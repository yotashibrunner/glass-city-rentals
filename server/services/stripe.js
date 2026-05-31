'use strict';

// Stripe Checkout (hosted) — full balance, zero PCI scope. Everything here is
// guarded by STRIPE_SECRET_KEY: with no key the booking flow still works up
// through signing, and callers get a typed 503 at the checkout step.

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

async function createCheckoutSession(booking, { successUrl, cancelUrl }) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();

  const deliveryFee = booking.delivery_fee_cents || 0;
  const rentalAmount = booking.total_cents - deliveryFee; // base + tax

  const lineItems = [{
    price_data: {
      currency: 'usd',
      product_data: {
        name: `${booking.trailer_name} — ${booking.ref_code}`,
        description: 'Glass City Trailer Rentals — rental balance',
      },
      unit_amount: rentalAmount,
    },
    quantity: 1,
  }];
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

  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    customer_email: booking.customer_email || undefined,
    client_reference_id: booking.ref_code,
    metadata: { booking_id: booking.id, ref_code: booking.ref_code },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

// Verify + parse a webhook payload. Requires the raw request body.
function constructEvent(rawBody, signature) {
  const stripe = getClient();
  if (!stripe || !config.stripeWebhookSecret) throw unconfigured();
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}

module.exports = { isConfigured, createCheckoutSession, constructEvent };
