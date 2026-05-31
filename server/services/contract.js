'use strict';

// Rental agreement: one versioned, data-driven builder feeds three surfaces —
// the on-screen contract (HTML), the immutable text snapshot stored at signing,
// and the downloadable PDF — so all three always match. Bump CONTRACT_VERSION
// (and keep the old text reproducible) whenever the language changes.
//
// ⚠ DRAFT LANGUAGE. Plan §13: have an Ohio attorney review this text before
// going live. The platform mechanics (intent, consent, attribution, integrity)
// are sound; the wording is placeholder.

const PDFDocument = require('pdfkit');
const { formatCents } = require('../utils/money');

const CONTRACT_VERSION = 1;
const PICKUP_ADDRESS = '2004 Front Street, Toledo, OH 43605';
const BUSINESS_NAME = 'Glass City Trailer Rentals LLC';

function fmtDate(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// Build the structured agreement for a booking. Pure data — no I/O.
function buildAgreement({ booking, trailer, customer }) {
  const isDumpster = trailer.type === 'dumpster';
  const periodLabel = isDumpster
    ? `Roll-off drop-off (${booking.quantity || 0} extra day${booking.quantity === 1 ? '' : 's'} beyond included)`
    : `${booking.quantity} ${booking.period_type}${booking.quantity === 1 ? '' : 's'}`;

  const isDelivery = booking.fulfillment === 'delivery';
  const summary = [
    { label: 'Reference', value: booking.ref_code },
    { label: 'Renter', value: customer.name },
    { label: 'Contact', value: `${customer.phone}${customer.email ? ' · ' + customer.email : ''}` },
    { label: 'Equipment', value: `${trailer.name}${trailer.size_label ? ' (' + trailer.size_label + ')' : ''}` },
    { label: 'Fulfillment', value: isDelivery ? 'Delivery' : 'Customer pickup' },
    ...(isDelivery && booking.delivery_address
      ? [{ label: 'Delivery address', value: booking.delivery_address }]
      : []),
    { label: isDumpster ? 'Drop-off' : 'Pickup', value: fmtDate(booking.start_at) },
    { label: isDumpster ? 'Scheduled pickup' : 'Return', value: fmtDate(booking.end_at) },
    { label: 'Rental term', value: periodLabel },
    { label: 'Subtotal', value: formatCents(booking.base_amount_cents + (booking.extra_charges_cents || 0)) },
    { label: 'Tax', value: formatCents(booking.tax_cents) },
    ...(booking.delivery_fee_cents > 0
      ? [{ label: 'Delivery fee', value: formatCents(booking.delivery_fee_cents) }]
      : []),
    { label: 'Total due', value: formatCents(booking.total_cents) },
  ];

  const sections = [
    {
      heading: '1. Equipment & Rental Term',
      paragraphs: [
        `${BUSINESS_NAME} ("Owner") agrees to rent to the Renter named above the equipment identified in this agreement for the rental term shown. The Renter has inspected, or had the opportunity to inspect, the equipment and accepts it in its current condition.`,
        trailer.hitch_requirement
          ? `Towing requirements: ${trailer.hitch_requirement}${trailer.plug_requirement ? ' · ' + trailer.plug_requirement : ''}. The Renter is responsible for providing a properly rated tow vehicle and connections.`
          : 'The Owner will arrange drop-off and pickup of the equipment at the service address.',
      ],
    },
    {
      heading: '2. Payment',
      paragraphs: [
        `The full balance of ${formatCents(booking.total_cents)} is charged at the time of booking. Rates are for customer pickup only; no delivery is included in this agreement unless separately arranged in writing.`,
      ],
    },
    {
      heading: isDumpster ? '3. Drop-off & Pickup' : '3. Pickup & Return',
      paragraphs: [
        isDumpster
          ? `The roll-off container will be dropped off and later picked up by the Owner at the service address provided by the Renter. The base rate includes the stated number of days; additional days are billed at the posted extra-day rate.`
          : `Equipment is picked up and returned by the Renter at ${PICKUP_ADDRESS}, during business hours (7:00 AM – 7:00 PM). Late returns may incur additional charges at the applicable rate.`,
      ],
    },
    {
      heading: '4. Renter Responsibilities',
      paragraphs: [
        'The Renter shall use the equipment in a safe and lawful manner, shall not exceed its rated capacity, and shall not sublet or permit use by unauthorized persons. The Renter is responsible for securing all loads and complying with all applicable traffic and transportation laws.',
      ],
    },
    {
      heading: '5. Liability & Damage',
      paragraphs: [
        'The Renter assumes all risk of loss or damage to the equipment from the time of pickup (or drop-off) until its return (or scheduled pickup), and is responsible for the cost of repair or replacement of any damage beyond ordinary wear. The Renter agrees to indemnify and hold the Owner harmless from any claims, damages, or injuries arising out of the Renter\'s use of the equipment, to the fullest extent permitted by law.',
      ],
    },
    {
      heading: '6. Cancellation Policy',
      paragraphs: [
        'Cancellations made 48 or more hours before the scheduled start receive a full refund. Cancellations made within 48 hours receive a 50% refund. No-shows are non-refundable.',
      ],
    },
  ];

  if (isDumpster) {
    sections.push({
      heading: '7. Prohibited Materials',
      paragraphs: [
        `Tires, hazardous waste, liquids, and prohibited materials may not be placed in the container. Tires found in the container at pickup are charged ${formatCents(trailer.per_tire_cents)} each. The Renter is responsible for any fees or fines resulting from prohibited materials.`,
      ],
    });
  }

  sections.push({
    heading: `${isDumpster ? '8' : '7'}. Electronic Signature & Consent`,
    paragraphs: [
      'By typing your name below and checking the consent boxes, you agree to conduct this transaction electronically and you adopt your typed name (and any drawn signature) as your legal electronic signature under the federal E-SIGN Act and the Ohio Uniform Electronic Transactions Act. You confirm that you have read and agree to this agreement, and you consent to receive the signed agreement and related records electronically. You may request a paper copy at pickup.',
    ],
  });

  return {
    version: CONTRACT_VERSION,
    title: `${BUSINESS_NAME} — Rental Agreement`,
    isDumpster,
    summary,
    sections,
  };
}

// Flatten the agreement to the exact plain text stored as the immutable
// snapshot at signing (and rendered into the PDF).
function toPlainText(agreement) {
  const lines = [];
  lines.push(agreement.title);
  lines.push(`Contract version ${agreement.version}`);
  lines.push('');
  lines.push('SUMMARY');
  for (const row of agreement.summary) lines.push(`  ${row.label}: ${row.value}`);
  lines.push('');
  for (const section of agreement.sections) {
    lines.push(section.heading);
    for (const p of section.paragraphs) lines.push(p);
    lines.push('');
  }
  return lines.join('\n');
}

// Generate the contract PDF from a signed booking. Renders the stored snapshot
// text (the exact agreement signed) plus the signature block, on demand — no
// file is persisted (Railway disk is ephemeral). Returns a Promise<Buffer>.
function generatePdf(booking) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const snapshot = booking.contract_snapshot || '(agreement text unavailable)';
      const firstBreak = snapshot.indexOf('\n');
      const title = firstBreak === -1 ? snapshot : snapshot.slice(0, firstBreak);
      const rest = firstBreak === -1 ? '' : snapshot.slice(firstBreak + 1);

      doc.font('Helvetica-Bold').fontSize(16).text(title, { align: 'left' });
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(10).fillColor('#333').text(rest, { align: 'left' });

      // Signature block.
      doc.moveDown(1);
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(12).text('Signature');
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10);
      doc.text(`Signed by (typed): ${booking.contract_signed_name || '—'}`);
      doc.text(`Date/time (UTC): ${booking.contract_signed_at ? new Date(booking.contract_signed_at).toISOString() : '—'}`);
      doc.text(`IP address: ${booking.contract_signed_ip || '—'}`);
      if (booking.contract_signed_user_agent) {
        doc.text(`Device: ${booking.contract_signed_user_agent}`, { width: 460 });
      }

      const sig = booking.contract_signature_image;
      if (sig && /^data:image\/png;base64,/.test(sig)) {
        try {
          const buf = Buffer.from(sig.replace(/^data:image\/png;base64,/, ''), 'base64');
          doc.moveDown(0.5);
          doc.text('Drawn signature:');
          doc.image(buf, { fit: [240, 90] });
        } catch (e) {
          // A bad image shouldn't break the legal record.
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { CONTRACT_VERSION, buildAgreement, toPlainText, generatePdf, PICKUP_ADDRESS, BUSINESS_NAME };
