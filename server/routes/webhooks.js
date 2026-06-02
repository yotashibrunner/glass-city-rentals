'use strict';

// Stripe webhook. Mounted with express.raw so the signature is verified against
// the exact bytes Stripe sent (express.json would corrupt the signature check).
// On checkout.session.completed: mark the booking paid, then best-effort email
// the customer their confirmation with the signed contract PDF attached.

const express = require('express');
const stripeSvc = require('../services/stripe');
const bookingSvc = require('../services/booking');
const chargesSvc = require('../services/charges');
const couponsSvc = require('../services/coupons');
const emailSvc = require('../services/email');
const notifySvc = require('../services/notify');
const { generatePdf } = require('../services/contract');

const router = express.Router();

router.post('/stripe', async (req, res) => {
  let event;
  try {
    event = stripeSvc.constructEvent(req.body, req.get('stripe-signature'));
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    console.log(`[webhook] received ${event.type} (${event.id})`);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const kind = (session.metadata && session.metadata.type) || 'booking';

      // Extension / additional-charge payment links resolve their own records
      // (an extension also pushes the booking's return date out). They don't
      // send a confirmation email.
      if (kind === 'extension') {
        const ext = await chargesSvc.markExtensionPaidBySession(session.id, session.payment_intent);
        console.log(`[webhook] extension ${ext ? ext.id + ' paid (return date moved)' : 'already paid / unknown'}`);
        return res.json({ received: true });
      }
      if (kind === 'charge') {
        const ch = await chargesSvc.markChargePaidBySession(session.id, session.payment_intent);
        console.log(`[webhook] additional charge ${ch ? ch.id + ' paid' : 'already paid / unknown'}`);
        return res.json({ received: true });
      }

      // Stripe always collects an email on its checkout page; prefer that, then
      // any email we passed. Used to mark paid + backfill the customer record.
      const stripeEmail =
        (session.customer_details && session.customer_details.email) || session.customer_email || null;

      // We save the card off-session on every booking — resolve the customer +
      // payment method so we can later refund a deposit / charge the card on file.
      const depositCents = Number(session.metadata && session.metadata.deposit_cents) || 0;
      const { customerId, paymentMethodId } = await stripeSvc.getSavedPaymentDetails(session);

      const booking = await bookingSvc.markPaidBySession(session.id, {
        paymentIntentId: session.payment_intent,
        amountCents: session.amount_total,
        customerEmail: stripeEmail,
        customerId,
        paymentMethodId,
        depositCents,
      });
      if (!booking) {
        console.warn(`[webhook] no pending booking for session ${session.id} (already paid or unknown).`);
        return res.json({ received: true });
      }

      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      console.log(`[webhook] booking ${booking.ref_code} marked paid; email=${booking.customer_email || '(none)'}`);

      // Confirmation email with the signed-contract PDF (best-effort).
      try {
        const pdf = await generatePdf(booking);
        const result = await emailSvc.sendBookingConfirmation(booking, pdf, baseUrl);
        if (result && result.skipped) {
          console.warn(`[webhook] confirmation email skipped for ${booking.ref_code} (${booking.customer_email ? 'email service not configured' : 'no customer email'}).`);
        } else {
          console.log(`[webhook] confirmation email sent for ${booking.ref_code}.`);
        }
      } catch (e) {
        console.error('[webhook] confirmation email failed:', e.message);
      }

      // Record the coupon use (idempotent) — only counts a PAID booking.
      if (booking.coupon_id) {
        try {
          await couponsSvc.recordUse(booking.coupon_id, booking.id, booking.discount_applied_cents);
        } catch (e) {
          console.error('[webhook] coupon use record failed:', e.message);
        }
      }

      // Alert the operator(s) on push + SMS. Best-effort: notify never throws.
      try {
        await notifySvc.notifyNewBooking(booking, baseUrl);
      } catch (e) {
        console.error('[webhook] operator notification failed:', e.message);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err.message);
    res.status(500).json({ error: 'handler_error' });
  }
});

module.exports = router;
