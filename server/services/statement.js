'use strict';

// Monthly operator statement PDF (pdfkit). Itemizes the prior month's paid
// bookings, then the commission/retainer calculation and total due.

const PDFDocument = require('pdfkit');
const { formatCents } = require('../utils/money');

const BUSINESS_NAME = 'Glass City Trailer Rentals LLC';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// statement: output of reports.statement(month, year). Returns Promise<Buffer>.
function generateStatementPdf(statement) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const t = statement.totals;

      doc.font('Helvetica-Bold').fontSize(18).fillColor('#000').text(BUSINESS_NAME);
      doc.font('Helvetica').fontSize(11).fillColor('#555')
        .text(`Operator Statement — ${statement.label}`);
      doc.moveDown(1);

      // Summary block.
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(13).text('Summary');
      doc.moveDown(0.4);
      const kv = (label, value, bold) => {
        const y = doc.y;
        doc.font('Helvetica').fontSize(11).fillColor('#444').text(label, 54, y);
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(11).fillColor('#000')
          .text(value, 300, y, { width: 200, align: 'right' });
        doc.moveDown(0.35);
      };
      kv('Bookings', String(t.booking_count));
      kv('Gross revenue', formatCents(t.gross_cents));
      kv('Stripe fees (est. 2.9% + $0.30)', `- ${formatCents(t.stripe_fees_cents)}`);
      kv('Net revenue', formatCents(t.net_cents), true);
      kv(`Commission (${(t.commission_rate * 100).toFixed(0)}% of net)`, formatCents(t.commission_cents));
      kv(`Retainer (${t.retainer_tier} tier)`, formatCents(t.retainer_cents));
      doc.moveDown(0.2);
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#1faa30');
      kv('TOTAL DUE TO OPERATOR', formatCents(t.total_due_cents), true);

      doc.moveDown(0.8);
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(13).text('Bookings');
      doc.moveDown(0.4);

      // Itemized list. Simple monospace-ish columns via fixed x positions.
      const cols = { date: 54, ref: 110, cust: 190, gross: 380, comm: 470 };
      const headerRow = (y) => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#888');
        doc.text('Date', cols.date, y);
        doc.text('Ref', cols.ref, y);
        doc.text('Customer / Trailer', cols.cust, y);
        doc.text('Gross', cols.gross, y, { width: 80, align: 'right' });
        doc.text('Comm.', cols.comm, y, { width: 80, align: 'right' });
      };
      headerRow(doc.y);
      doc.moveDown(0.3);
      doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor('#ddd').stroke();
      doc.moveDown(0.3);

      if (!statement.items.length) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#777').text('No paid bookings this month.', 54);
      }
      for (const it of statement.items) {
        if (doc.y > 700) { doc.addPage(); headerRow(doc.y); doc.moveDown(0.5); }
        const y = doc.y;
        doc.font('Helvetica').fontSize(9).fillColor('#222');
        doc.text(fmtDate(it.date), cols.date, y);
        doc.text(it.ref_code, cols.ref, y);
        doc.text(`${it.customer_name} · ${it.trailer_name}`, cols.cust, y, { width: 185 });
        doc.text(formatCents(it.gross_cents), cols.gross, y, { width: 80, align: 'right' });
        doc.text(formatCents(it.commission_cents), cols.comm, y, { width: 80, align: 'right' });
        doc.moveDown(0.5);
      }

      doc.moveDown(1);
      doc.font('Helvetica').fontSize(8).fillColor('#999')
        .text('Stripe fees are estimated (2.9% + $0.30/charge); your Stripe dashboard is authoritative. '
          + 'Revenue is recognized on the booking date.', 54, doc.y, { width: 500 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateStatementPdf };
