'use strict';

/*
 * Thin client for the public quote API, shared by the trailer and dumpster
 * pages. requestQuote() posts a selection and returns the server-computed
 * { base_cents, tax_cents, total_cents, ... } — the server is the source of
 * truth for all money math; the page only displays it.
 */
(function (global) {
  function money(cents) {
    if (cents == null) return '—';
    const dollars = cents / 100;
    return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
  }

  async function requestQuote(payload) {
    const res = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Could not compute a quote.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  global.GCQuote = { money, requestQuote };
})(window);
