'use strict';

// Stripe Checkout (hosted) — full balance, zero PCI scope. Everything here is
// guarded by STRIPE_SECRET_KEY: with no key the booking flow still works up
// through signing, and callers get a typed 503 at the checkout step.
//
// Beyond the initial booking payment this also powers the deposit lifecycle:
//   - the booking Checkout can collect a refundable security deposit AND save
//     the customer's card off-session (setup_future_usage) so we can later
//     refund the deposit or charge the card for return-time overages;
//   - refunds (clean / partial deposit returns);
//   - off-session charges to the card on file (overage beyond the deposit);
//   - hosted payment links (Checkout Sessions) for rental extensions and
//     post-rental additional charges.

const Stripe = require('stripe');
const config = require('../config');

let client = null;
function getClient() {
  if (!config.stripeSecretKey) return null;
  if (!client) client = new Stripe(config.stripeSecretKey);
  return client;
}

function isConfigured() {
  return !!config.stripeSecretKey;
}

function unconfigured() {
  const err = new Error('Online payments are not set up yet. Please call (419) 654-3584 to pay.');
  err.status = 503;
  err.code = 'stripe_unconfigured';
  return err;
}

// Booking checkout. `depositCents` (optional) adds a refundable-deposit line
// item; when present we also force a Customer and save the payment method
// off-session so the deposit can be refunded / the card charged later.
async function createCheckoutSession(booking, { successUrl, cancelUrl, depositCents = 0 }) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();

  const deliveryFee = booking.delivery_fee_cents || 0;
  // total_cents is already net of any discount; the rental line is whatever
  // remains after the (separate) delivery line. Guard against a discount pulling
  // it to zero/negative — Stripe rejects a $0 line item.
  const rentalAmount = booking.total_cents - deliveryFee; // base + tax − discount

  const lineItems = [];
  if (rentalAmount > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${booking.trailer_name} — ${booking.ref_code}`,
          description: booking.discount_applied_cents > 0
            ? 'Glass City Trailer Rentals — rental balance (discount applied)'
            : 'Glass City Trailer Rentals — rental balance',
        },
        unit_amount: rentalAmount,
      },
      quantity: 1,
    });
  }
  if (deliveryFee > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: 'Local delivery', description: 'Drop-off & pickup at your address' },
        unit_amount: deliveryFee,
      },
      quantity: 1,
    });
  }
  const deposit = Math.max(0, Math.round(depositCents) || 0);
  if (deposit > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Refundable security deposit',
          description: 'Refunded after the trailer is returned in good condition',
        },
        unit_amount: deposit,
      },
      quantity: 1,
    });
  }

  const params = {
    mode: 'payment',
    line_items: lineItems,
    customer_email: booking.customer_email || undefined,
    client_reference_id: booking.ref_code,
    metadata: {
      type: 'booking', booking_id: booking.id, ref_code: booking.ref_code,
      deposit_cents: String(deposit),
      privacy_url: `${config.siteUrl || config.baseUrl}/privacy`,
      terms_url: `${config.siteUrl || config.baseUrl}/terms`,
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
  // Always create a Customer + save the card off-session so we can refund a
  // deposit or bill the card on file for post-rental charges on any booking.
  const paymentIntentData = { setup_future_usage: 'off_session' };
  if (booking.customer_email) paymentIntentData.receipt_email = booking.customer_email;
  params.customer_creation = 'always';
  params.payment_intent_data = paymentIntentData;

  return stripe.checkout.sessions.create(params);
}

// Given a completed Checkout Session, resolve the Customer + saved payment
// method so a deposit can later be refunded / the card charged off-session.
// Returns { customerId, paymentMethodId } (either may be null).
async function getSavedPaymentDetails(session) {
  const stripe = getClient();
  if (!stripe) return { customerId: null, paymentMethodId: null };
  const customerId = typeof session.customer === 'string' ? session.customer : (session.customer && session.customer.id) || null;
  let paymentMethodId = null;
  const piId = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id);
  if (piId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(piId);
      paymentMethodId = typeof pi.payment_method === 'string' ? pi.payment_method : (pi.payment_method && pi.payment_method.id) || null;
    } catch (err) {
      console.error('[stripe] could not retrieve payment intent for saved PM:', err.message);
    }
  }
  return { customerId, paymentMethodId };
}

// Refund part or all of a captured payment (deposit return). Returns the Stripe
// refund object.
async function refund({ paymentIntentId, amountCents }) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  if (!paymentIntentId) throw new Error('No payment to refund.');
  const params = { payment_intent: paymentIntentId };
  if (amountCents != null) params.amount = Math.round(amountCents);
  return stripe.refunds.create(params);
}

// Charge the saved card off-session (overage beyond the deposit, or an
// additional charge billed to card on file). Returns the PaymentIntent.
async function chargeCardOnFile({ customerId, paymentMethodId, amountCents, description, metadata }) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  if (!customerId || !paymentMethodId) {
    const err = new Error('No saved card on file for this booking.');
    err.status = 409;
    err.code = 'no_card_on_file';
    throw err;
  }
  return stripe.paymentIntents.create({
    amount: Math.round(amountCents),
    currency: 'usd',
    customer: customerId,
    payment_method: paymentMethodId,
    off_session: true,
    confirm: true,
    description: description || undefined,
    metadata: metadata || undefined,
  });
}

// A hosted, shareable payment link for an extension fee or additional charge.
// Implemented as a Checkout Session (behaves like a payment link for the
// customer, lets us prefill the email + attach metadata the webhook branches
// on). Returns { id, url }.
async function createPaymentLink({ amountCents, productName, description, customerEmail, metadata, successUrl, cancelUrl }) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: productName, description: description || undefined },
        unit_amount: Math.round(amountCents),
      },
      quantity: 1,
    }],
    customer_email: customerEmail || undefined,
    metadata: metadata || undefined,
    payment_intent_data: customerEmail ? { receipt_email: customerEmail } : undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return { id: session.id, url: session.url };
}

// Verify + parse a webhook payload. Requires the raw request body.
function constructEvent(rawBody, signature) {
  const stripe = getClient();
  if (!stripe || !config.stripeWebhookSecret) throw unconfigured();
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}

module.exports = {
  isConfigured, createCheckoutSession, getSavedPaymentDetails,
  refund, chargeCardOnFile, createPaymentLink, constructEvent,
};
