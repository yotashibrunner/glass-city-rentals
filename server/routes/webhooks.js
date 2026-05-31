'use strict';

// Stripe webhook. Mounted with express.raw so the signature is verified against
// the exact bytes Stripe sent (express.json would corrupt the signature check).
// On checkout.session.completed: mark the booking paid, then best-effort email
// the customer their confirmation with the signed contract PDF attached.

const express = require('express');
const stripeSvc = require('../services/stripe');
const bookingSvc = require('../services/booking');
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
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const booking = await bookingSvc.markPaidBySession(
        session.id, session.payment_intent, session.amount_total
      );
      if (booking) {
        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        try {
          const pdf = await generatePdf(booking);
          await emailSvc.sendBookingConfirmation(booking, pdf, baseUrl);
        } catch (e) {
          console.error('[webhook] confirmation email failed:', e.message);
        }
        // Alert the operator(s) on push + SMS. Best-effort: notify never throws.
        try {
          await notifySvc.notifyNewBooking(booking, baseUrl);
        } catch (e) {
          console.error('[webhook] operator notification failed:', e.message);
        }
        console.log(`[webhook] booking ${booking.ref_code} marked paid`);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err.message);
    res.status(500).json({ error: 'handler_error' });
  }
});

module.exports = router;
