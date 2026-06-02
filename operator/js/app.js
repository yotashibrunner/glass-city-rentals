'use strict';

/*
 * Operator PWA controller. Tiny state machine — no router library. Views are
 * cloned from <template> elements in index.html:
 *   login  →  dashboard  →  inventory  →  trailer detail
 * Auth lives in api.js (JWT in localStorage, auto-refresh). Every operator
 * API call goes through api.apiFetch, which adds the bearer token.
 */

(function (GC) {
  const { api } = GC;
  const root = document.getElementById('app');

  function mount(templateId) {
    const tpl = document.getElementById(templateId);
    root.replaceChildren(tpl.content.cloneNode(true));
  }

  // If the session can't be recovered, drop back to login. Returns true when
  // it handled an auth failure so callers can stop.
  function handleAuth(err) {
    if (err instanceof api.AuthError) {
      const cached = api.auth.user;
      renderLogin(cached && cached.email);
      return true;
    }
    return false;
  }

  // ── Money helpers (DB stores integer cents) ─────────────────────────────
  function centsToInput(c) {
    if (c == null) return '';
    return Number.isInteger(c) && c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2);
  }
  function inputToCents(str) {
    const s = String(str).trim();
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }
  function fmtMoney(c) {
    if (c == null) return null;
    return c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`;
  }

  // Short pricing summary for list rows.
  function priceSummary(t) {
    if (t.type === 'dumpster') {
      const drop = fmtMoney(t.flat_drop_off_cents);
      return drop ? `${drop} drop-off` : '';
    }
    const daily = fmtMoney(t.daily_rate);
    return daily ? `${daily}/day` : '';
  }

  function statusLabel(s) {
    return s === 'out_of_service' ? 'Out of Service' : 'Available';
  }

  // ── Date helpers ────────────────────────────────────────────────────────
  // Bookings store start/end at UTC midnight (date-only granularity), so all
  // formatting reads UTC to avoid the displayed day drifting by timezone.
  const DAY_MS = 86400000;

  function fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  }

  // end_at is exclusive (the midnight after the last rental day), so the day the
  // trailer is actually due back is one day earlier.
  function fmtReturnDay(iso) {
    if (!iso) return '—';
    return fmtDay(new Date(new Date(iso).getTime() - DAY_MS).toISOString());
  }

  // Compact pickup→return range for list rows.
  function fmtRange(b) {
    return `${fmtDay(b.start_at)} – ${fmtReturnDay(b.end_at)}`;
  }

  function todayISODate() {
    return new Date().toISOString().slice(0, 10);
  }

  function shiftDate(isoDate, days) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
  }

  // 'YYYY-MM-DD' ⇄ UTC-midnight Date.
  function parseUTC(isoDate) { return new Date(`${isoDate}T00:00:00Z`); }
  function ymd(d) { return d.toISOString().slice(0, 10); }

  // Date + time for action attribution (UTC wall-clock, matching how times are
  // stored/shown elsewhere).
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
    });
  }

  function fmtMonthYear(d) {
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  function fmtShortDay(d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  // ── Booking status badges ────────────────────────────────────────────────
  const BOOKING_STATUS = {
    pending: { label: 'Pending', cls: 'badge-warn' },
    signed: { label: 'Signed', cls: 'badge-warn' },
    paid: { label: 'Paid', cls: 'badge-ok' },
    confirmed: { label: 'Confirmed', cls: 'badge-ok' },
    out: { label: 'Out', cls: 'badge-out' },
    returned: { label: 'Returned', cls: 'badge-done' },
    cancelled: { label: 'Cancelled', cls: 'badge-oos' },
  };

  function paintBookingBadge(el, status) {
    const meta = BOOKING_STATUS[status] || { label: status, cls: '' };
    el.textContent = meta.label;
    el.className = `badge ${meta.cls}`;
  }

  // Human-readable deposit state for the booking detail.
  function depositStatusLine(b) {
    const held = b.deposit_paid_fmt || '$0';
    switch (b.deposit_status) {
      case 'held': return `${held} held`;
      case 'refunded': return `${held} — refunded`;
      case 'partially_kept': return `${held} held · ${b.deposit_refunded_fmt || '$0'} refunded`;
      case 'kept': return `${held} — kept`;
      default: return held;
    }
  }

  const CHARGE_STATUS = {
    pending: 'badge-warn', paid: 'badge-ok', waived: 'badge-done', disputed: 'badge-oos',
  };

  // Deterministic color per trailer so the schedule reads at a glance.
  function trailerHue(key) {
    let h = 0;
    for (let i = 0; i < (key || '').length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    return h;
  }

  // Fill a cloned tpl-booking-row and wire its tap target.
  function fillBookingRow(node, b, onOpen) {
    node.querySelector('[data-customer]').textContent = b.customer_name || '—';
    node.querySelector('[data-trailer]').textContent = b.trailer_name || '';
    node.querySelector('[data-when]').textContent =
      fmtRange(b) + (b.time_fmt ? ` · ${b.time_fmt}` : '');
    node.querySelector('[data-phone]').textContent = b.customer_phone || '';
    paintBookingBadge(node.querySelector('[data-badge]'), b.status);

    // PICKUP / DELIVERY badge (+ address line for deliveries).
    const isDelivery = b.fulfillment === 'delivery';
    const fb = node.querySelector('[data-fulfillment]');
    fb.textContent = isDelivery ? 'Delivery' : 'Pickup';
    fb.classList.add(isDelivery ? 'badge-delivery' : 'badge-pickup');
    const addr = node.querySelector('[data-address]');
    if (isDelivery && b.delivery_address) {
      addr.textContent = `📍 ${b.delivery_address}`;
      addr.classList.add('booking-address');
      addr.hidden = false;
    }

    const stripe = node.querySelector('[data-stripe]');
    stripe.style.background = `hsl(${trailerHue(b.trailer_slug || b.trailer_name)} 55% 50%)`;
    node.querySelector('[data-open]').addEventListener('click', () => onOpen(b));
  }

  // Fill a cloned tpl-blackout-row. onDelete(bo, rowEl) handles removal.
  function fillBlackoutRow(node, bo, onDelete) {
    const trailerEl = node.querySelector('[data-trailer]');
    trailerEl.textContent = bo.fleet_wide ? 'All trailers' : (bo.trailer_name || 'Trailer');
    const when = bo.start_date === bo.end_date
      ? fmtDay(bo.start_date)
      : `${fmtDay(bo.start_date)} – ${fmtDay(bo.end_date)}`;
    node.querySelector('[data-when]').textContent = when;
    const reasonEl = node.querySelector('[data-reason]');
    if (bo.reason) reasonEl.textContent = bo.reason; else reasonEl.hidden = true;
    const delBtn = node.querySelector('[data-del]');
    const li = node.querySelector('.blackout-row');
    delBtn.addEventListener('click', () => onDelete(bo, li, delBtn));
  }

  // Keep a badge + toggle button visually in sync with a trailer's status.
  function paintStatus(badgeEl, toggleEl, status) {
    const oos = status === 'out_of_service';
    badgeEl.textContent = statusLabel(status);
    badgeEl.classList.toggle('badge-oos', oos);
    badgeEl.classList.toggle('badge-ok', !oos);
    if (toggleEl) {
      toggleEl.textContent = oos ? 'Set Available' : 'Set Out of Service';
      toggleEl.classList.toggle('btn-restore', oos);
      toggleEl.classList.toggle('btn-danger', !oos);
    }
  }

  // Wire a status toggle. PATCHes the new status and updates in place — no
  // page reload. `errEl` shows transient failures; `onChange` lets the caller
  // refresh anything else bound to this trailer.
  function wireToggle(trailer, badgeEl, toggleEl, errEl, onChange) {
    paintStatus(badgeEl, toggleEl, trailer.status);
    toggleEl.addEventListener('click', async () => {
      const next = trailer.status === 'out_of_service' ? 'available' : 'out_of_service';
      toggleEl.disabled = true;
      if (errEl) errEl.hidden = true;
      try {
        const data = await api.apiFetch(`/api/operator/trailers/${trailer.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: next }),
        });
        Object.assign(trailer, data.trailer);
        paintStatus(badgeEl, toggleEl, trailer.status);
        if (onChange) onChange(trailer);
      } catch (err) {
        if (handleAuth(err)) return;
        if (errEl) {
          errEl.textContent = err.message || 'Could not update. Try again.';
          errEl.hidden = false;
        }
      } finally {
        toggleEl.disabled = false;
      }
    });
  }

  // ── Login ─────────────────────────────────────────────────────────────
  function renderLogin(prefillEmail) {
    mount('tpl-login');
    const form = root.querySelector('form');
    const errorEl = form.querySelector('[data-error]');
    const submitBtn = form.querySelector('[data-submit]');
    const emailEl = form.querySelector('#email');
    const passwordEl = form.querySelector('#password');

    if (prefillEmail) emailEl.value = prefillEmail;
    (prefillEmail ? passwordEl : emailEl).focus();

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = !msg;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const email = emailEl.value.trim();
      const password = passwordEl.value;
      if (!email || !password) {
        showError('Enter your email and password.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Logging in…';
      try {
        await api.login(email, password);
        renderDashboard();
      } catch (err) {
        showError(err.message || 'Login failed.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log in';
        passwordEl.select();
      }
    });
  }

  // ── Dashboard ──────────────────────────────────────────────────────────
  async function renderDashboard() {
    mount('tpl-dashboard');

    const welcome = root.querySelector('[data-welcome]');
    const logoutBtn = root.querySelector('[data-logout]');
    const errEl = root.querySelector('[data-error]');

    logoutBtn.addEventListener('click', () => {
      api.logout();
      renderLogin();
    });
    root.querySelector('[data-nav="inventory"]').addEventListener('click', () => renderInventory());
    root.querySelector('[data-nav="schedule"]').addEventListener('click', () => renderSchedule());
    root.querySelector('[data-nav="calendar"]').addEventListener('click', () => renderCalendar());
    root.querySelector('[data-nav="accounts"]').addEventListener('click', () => renderAccounts());
    root.querySelector('[data-nav="diagnostics"]').addEventListener('click', () => renderDiagnostics());
    root.querySelector('[data-nav="reports"]').addEventListener('click', () => renderReports());
    root.querySelector('[data-nav="audit"]').addEventListener('click', () => renderAudit());
    root.querySelector('[data-nav="settings"]').addEventListener('click', () => renderSettings());
    root.querySelector('[data-nav="coupons"]').addEventListener('click', () => renderCoupons());

    // Role-gated nav: admin-only items (inventory, calendar, accounts,
    // diagnostics) for admins; reports + audit for admins and owners.
    const role = api.auth.user && api.auth.user.role;
    const isAdmin = role === 'admin';
    const canReport = role === 'admin' || role === 'owner';
    root.querySelectorAll('[data-admin]').forEach((el) => { el.hidden = !isAdmin; });
    root.querySelectorAll('[data-reports]').forEach((el) => { el.hidden = !canReport; });

    setupNotifications();

    // Show whatever we already know immediately, then confirm with the API.
    const cached = api.auth.user;
    if (cached) welcome.textContent = `Signed in as ${cached.name || cached.email}.`;

    // Paint one dashboard section: fill its list, or hide the whole section
    // when it has no items (only non-empty sections show).
    function paintSection(key, bookings) {
      const sectionEl = root.querySelector(`[data-section="${key}"]`);
      const listEl = root.querySelector(`[data-list="${key}"]`);
      const countEl = root.querySelector(`[data-count="${key}"]`);
      listEl.replaceChildren();
      if (!bookings.length) {
        sectionEl.hidden = true;
        return;
      }
      sectionEl.hidden = false;
      countEl.textContent = `(${bookings.length})`;
      const rowTpl = document.getElementById('tpl-booking-row');
      for (const b of bookings) {
        const node = rowTpl.content.cloneNode(true);
        fillBookingRow(node, b, (bk) => renderBookingDetail(bk.id, renderDashboard));
        listEl.appendChild(node);
      }
      return bookings.length;
    }

    try {
      const data = await api.apiFetch('/api/operator/dashboard');
      const u = data.user || cached || {};
      welcome.textContent = `Signed in as ${u.name || u.email || 'operator'}.`;
      const keys = ['pickups', 'dropoffs', 'retrievals', 'returns', 'active'];
      let total = 0;
      for (const k of keys) total += paintSection(k, data[k] || []) || 0;
      // When the whole day is empty, show a single friendly line.
      root.querySelector('[data-dash-empty]').hidden = total > 0;
    } catch (err) {
      if (handleAuth(err)) return;
      errEl.textContent = 'Could not reach the server. Try again when back online.';
      errEl.hidden = false;
    }
  }

  // ── Booking detail ───────────────────────────────────────────────────────
  // onBack returns to wherever we came from (dashboard or schedule).
  async function renderBookingDetail(id, onBack) {
    mount('tpl-booking-detail');
    root.querySelector('[data-back]').addEventListener('click', () => (onBack || renderDashboard)());

    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const detailEl = root.querySelector('[data-detail]');

    let booking;
    try {
      const data = await api.apiFetch(`/api/operator/bookings/${id}`);
      booking = data.booking;
    } catch (err) {
      if (handleAuth(err)) return;
      loadingEl.hidden = true;
      errEl.textContent = err.message || 'Could not load this booking.';
      errEl.hidden = false;
      return;
    }
    loadingEl.hidden = true;

    function paint() {
      root.querySelector('[data-ref]').textContent = booking.ref_code;
      paintBookingBadge(root.querySelector('[data-badge]'), booking.status);
      root.querySelector('[data-customer]').textContent = booking.customer_name || '—';

      const phone = booking.customer_phone || '';
      root.querySelector('[data-phone]').textContent = phone || 'No phone on file';
      const phoneLink = root.querySelector('[data-phone-link]');
      if (phone) phoneLink.href = `tel:${phone.replace(/[^+\d]/g, '')}`;
      else phoneLink.removeAttribute('href');

      const trailerLine = [booking.trailer_name, booking.size_label].filter(Boolean).join(' · ');
      root.querySelector('[data-trailer]').textContent = trailerLine;

      const isDelivery = booking.fulfillment === 'delivery';
      const time = booking.time_fmt || null;
      root.querySelector('[data-fulfillment]').textContent = isDelivery
        ? `Delivery (${booking.delivery_fee_fmt || '$60'})` : 'Customer pickup';
      root.querySelector('[data-reqtime]').textContent = time || 'Not specified';

      // Delivery → "Deliver to: <address> at <time>"; pickup → "Customer
      // arriving at: <time>".
      const deliverRow = root.querySelector('[data-deliver-row]');
      const arriveRow = root.querySelector('[data-arrive-row]');
      if (isDelivery) {
        deliverRow.hidden = false;
        arriveRow.hidden = true;
        const addr = booking.delivery_address || '(no address)';
        root.querySelector('[data-deliver]').textContent = time ? `${addr} at ${time}` : addr;
      } else {
        deliverRow.hidden = true;
        arriveRow.hidden = false;
        root.querySelector('[data-arrive]').textContent = time || 'Not specified';
      }

      root.querySelector('[data-start]').textContent = fmtDay(booking.start_at);
      root.querySelector('[data-end]').textContent = fmtReturnDay(booking.end_at);
      root.querySelector('[data-paid]').textContent =
        booking.amount_paid_cents ? booking.amount_paid_fmt : `${booking.total_fmt} (unpaid)`;

      const depRow = root.querySelector('[data-deposit-row]');
      if (booking.deposit_status && booking.deposit_status !== 'none') {
        depRow.hidden = false;
        root.querySelector('[data-deposit]').textContent = depositStatusLine(booking);
      } else {
        depRow.hidden = true;
      }

      const couponRow = root.querySelector('[data-coupon-row]');
      if (booking.coupon_code || booking.discount_applied_cents > 0) {
        couponRow.hidden = false;
        const disc = booking.discount_applied_fmt || fmtMoney(booking.discount_applied_cents) || '$0';
        root.querySelector('[data-coupon]').textContent =
          booking.coupon_code ? `${booking.coupon_code} (−${disc})` : `−${disc}`;
      } else {
        couponRow.hidden = true;
      }

      if (booking.customer_notes) {
        root.querySelector('[data-notes-row]').hidden = false;
        root.querySelector('[data-notes]').textContent = booking.customer_notes;
      }
      const opRow = root.querySelector('[data-opnotes-row]');
      if (booking.operator_notes) {
        opRow.hidden = false;
        root.querySelector('[data-opnotes]').textContent = booking.operator_notes;
      } else {
        opRow.hidden = true;
      }

      const contractBtn = root.querySelector('[data-contract]');
      if (booking.contract_url) {
        contractBtn.href = booking.contract_url;
        contractBtn.hidden = false;
      } else {
        contractBtn.hidden = true;
      }

      // Action buttons reflect the booking's place in its lifecycle, labeled
      // by fulfillment: delivery → Mark Delivered / Mark Retrieved; pickup →
      // Mark Picked Up / Mark Returned. (Both map to the same out/returned
      // transitions server-side.) `isDelivery` is already in scope above.
      const pickupBtn = root.querySelector('[data-pickup]');
      const returnBtn = root.querySelector('[data-return]');
      const extendBtn = root.querySelector('[data-extend]');
      const addChargeBtn = root.querySelector('[data-add-charge]');
      const doneEl = root.querySelector('[data-done]');
      // Owners are read-only — they never see the mark buttons.
      const canAct = !(api.auth.user && api.auth.user.role === 'owner');
      const canPickup = canAct && (booking.status === 'paid' || booking.status === 'confirmed');
      const canReturn = canAct && booking.status === 'out';
      pickupBtn.textContent = isDelivery ? 'Mark Delivered' : 'Mark Picked Up';
      returnBtn.textContent = isDelivery ? 'Mark Retrieved' : 'Mark Returned';
      pickupBtn.hidden = !canPickup;
      returnBtn.hidden = !canReturn;
      extendBtn.hidden = !(canAct && booking.status === 'out');
      addChargeBtn.hidden = !(canAct && booking.status === 'returned');
      // Attribution: who made the most recent status change, and when.
      const attrEl = root.querySelector('[data-attribution]');
      const who = booking.managed_by_name;
      if (who && booking.status === 'out' && booking.picked_up_at) {
        attrEl.textContent = `Marked ${isDelivery ? 'delivered' : 'picked up'} by ${who} at ${fmtDateTime(booking.picked_up_at)}`;
        attrEl.hidden = false;
      } else if (who && booking.status === 'returned' && booking.returned_at) {
        attrEl.textContent = `Marked ${isDelivery ? 'retrieved' : 'returned'} by ${who} at ${fmtDateTime(booking.returned_at)}`;
        attrEl.hidden = false;
      } else {
        attrEl.hidden = true;
      }

      if (booking.status === 'returned') {
        doneEl.hidden = false;
        doneEl.textContent = isDelivery
          ? 'Retrieved — unit is available again.'
          : 'Returned — trailer is available again.';
      } else if (booking.status === 'cancelled') {
        doneEl.hidden = false;
        doneEl.textContent = 'This booking was cancelled.';
      } else {
        doneEl.hidden = true;
      }
    }
    paint();

    const actionErr = root.querySelector('[data-action-error]');
    async function transition(btn, status, working) {
      actionErr.hidden = true;
      btn.disabled = true;
      btn.textContent = working;
      try {
        const data = await api.apiFetch(`/api/operator/bookings/${booking.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        });
        booking = data.booking;
        paint();
      } catch (err) {
        if (handleAuth(err)) return;
        actionErr.textContent = err.message || 'Could not update. Try again.';
        actionErr.hidden = false;
        btn.disabled = false;
        paint(); // restore the correct button label
      }
    }

    const reopen = () => renderBookingDetail(booking.id, onBack);
    root.querySelector('[data-pickup]').addEventListener('click', (e) =>
      transition(e.currentTarget, 'out', 'Marking…'));
    root.querySelector('[data-return]').addEventListener('click', (e) => {
      // A held deposit must be settled through the Return Condition screen;
      // otherwise a return is a simple status transition.
      if (booking.deposit_status === 'held') renderReturnCondition(booking, reopen);
      else transition(e.currentTarget, 'returned', 'Marking…');
    });
    root.querySelector('[data-extend]').addEventListener('click', () => renderExtendRental(booking, reopen));
    root.querySelector('[data-add-charge]').addEventListener('click', () => renderAddCharge(booking, reopen));

    // Charges + extensions history (loaded once; non-fatal on failure).
    (async function loadCharges() {
      const section = root.querySelector('[data-charges-section]');
      const listEl = root.querySelector('[data-charges-list]');
      const emptyEl = root.querySelector('[data-charges-empty]');
      // Only relevant once a rental is active or done.
      if (!['out', 'returned'].includes(booking.status)) return;
      let data;
      try {
        data = await api.apiFetch(`/api/operator/bookings/${booking.id}/charges`);
      } catch (err) { return; }
      section.hidden = false;
      const tpl = document.getElementById('tpl-charge-row');
      const rows = [];
      for (const e of data.extensions || []) {
        rows.push({
          title: `Extension · ${e.days_extended} day${e.days_extended > 1 ? 's' : ''}`,
          sub: `New return ${fmtReturnDay(e.new_end_at)}`,
          amt: e.extension_fee_fmt, status: e.status,
        });
      }
      for (const c of data.charges || []) {
        rows.push({
          title: c.type_label, sub: c.description, amt: c.amount_fmt, status: c.status,
        });
      }
      if (!rows.length) { emptyEl.hidden = false; return; }
      for (const r of rows) {
        const node = tpl.content.cloneNode(true);
        node.querySelector('[data-title]').textContent = r.title;
        node.querySelector('[data-sub]').textContent = r.sub || '';
        node.querySelector('[data-amt]').textContent = r.amt || '';
        const badge = node.querySelector('[data-status]');
        badge.textContent = r.status;
        badge.className = `badge ${CHARGE_STATUS[r.status] || ''}`;
        listEl.appendChild(node);
      }
    })();

    detailEl.hidden = false;
  }

  // ── Return condition (deposit settlement) ────────────────────────────────
  // Deduction lines the operator can apply against the deposit at return.
  const DEDUCTION_TYPES = [
    { key: 'damage', label: 'Damage' },
    { key: 'prohibited_items', label: 'Prohibited items' },
    { key: 'tires', label: 'Tires' },
    { key: 'tonnage_overage', label: 'Tonnage overage' },
    { key: 'other', label: 'Other' },
  ];

  async function renderReturnCondition(booking, onDone) {
    mount('tpl-return-condition');
    root.querySelector('[data-back]').addEventListener('click', onDone);
    root.querySelector('[data-formtitle]').textContent =
      `Return — ${booking.customer_name || booking.ref_code}`;

    const depositCents = booking.deposit_paid_cents || 0;
    root.querySelector('[data-deposit-line]').textContent =
      `Deposit held: ${booking.deposit_paid_fmt || '$0'}`;

    const modeBtns = root.querySelectorAll('[data-mode]');
    const dedSection = root.querySelector('[data-deductions]');
    let mode = 'clean';
    function setMode(m) {
      mode = m;
      modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
      dedSection.hidden = m === 'clean';
      recompute();
    }
    modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    // Build a row per deduction type: a $ amount, plus a count for tires and a
    // tons input for tonnage (auto-calculated from the settings rate).
    let tonnageRateCents = 7500;
    api.apiFetch('/api/operator/settings').then((d) => {
      if (d.settings && Number.isInteger(d.settings.tonnage_overage_rate_cents)) {
        tonnageRateCents = d.settings.tonnage_overage_rate_cents;
      }
    }).catch(() => {});

    const fieldsEl = root.querySelector('[data-deduction-fields]');
    const amountInputs = {};
    const perTireCents = booking.per_tire_cents || 300;
    for (const t of DEDUCTION_TYPES) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const label = document.createElement('label');
      label.textContent = t.label;
      const amt = document.createElement('input');
      amt.type = 'number'; amt.min = '0'; amt.step = '0.01'; amt.inputMode = 'decimal';
      amt.placeholder = '0.00';

      if (t.key === 'tires') {
        const count = document.createElement('input');
        count.type = 'number'; count.min = '0'; count.step = '1'; count.inputMode = 'numeric';
        count.placeholder = `# tires @ ${fmtMoney(perTireCents)}/ea`;
        count.addEventListener('input', () => {
          const n = Math.max(0, parseInt(count.value, 10) || 0);
          amt.value = n ? centsToInput(n * perTireCents) : '';
          recompute();
        });
        wrap.append(label, count, amt);
      } else if (t.key === 'tonnage_overage') {
        const tons = document.createElement('input');
        tons.type = 'number'; tons.min = '0'; tons.step = '0.01'; tons.inputMode = 'decimal';
        tons.placeholder = 'tons over';
        tons.dataset.tons = '1';
        tons.addEventListener('input', () => {
          const n = Math.max(0, Number(tons.value) || 0);
          amt.value = n ? centsToInput(Math.round(n * tonnageRateCents)) : '';
          recompute();
        });
        amountInputs[t.key + '_tons'] = tons;
        wrap.append(label, tons, amt);
      } else {
        wrap.append(label, amt);
      }
      amt.addEventListener('input', recompute);
      amountInputs[t.key] = amt;
      fieldsEl.appendChild(wrap);
    }

    const totalEl = root.querySelector('[data-total-deductions]');
    const refundEl = root.querySelector('[data-refund]');
    const overageRow = root.querySelector('[data-overage-row]');
    const overageEl = root.querySelector('[data-overage]');
    function collectDeductions() {
      const out = [];
      for (const t of DEDUCTION_TYPES) {
        const cents = inputToCents(amountInputs[t.key].value);
        if (cents && cents > 0) {
          const d = { charge_type: t.key, description: t.label, amount_cents: cents };
          if (t.key === 'tonnage_overage' && amountInputs.tonnage_overage_tons) {
            const tons = Number(amountInputs.tonnage_overage_tons.value) || null;
            if (tons) { d.weight_tons = tons; d.description = `${tons} tons over`; }
          }
          out.push(d);
        }
      }
      return out;
    }
    function recompute() {
      const total = mode === 'clean' ? 0 : collectDeductions().reduce((s, d) => s + d.amount_cents, 0);
      const refund = Math.max(0, depositCents - total);
      const overage = Math.max(0, total - depositCents);
      totalEl.textContent = fmtMoney(total) || '$0';
      refundEl.textContent = fmtMoney(refund) || '$0';
      overageRow.hidden = overage <= 0;
      overageEl.textContent = fmtMoney(overage) || '$0';
    }
    setMode('clean');

    const errEl = root.querySelector('[data-error]');
    const confirmBtn = root.querySelector('[data-confirm]');
    confirmBtn.addEventListener('click', async () => {
      errEl.hidden = true;
      const clean = mode === 'clean';
      const deductions = clean ? [] : collectDeductions();
      if (!clean && !deductions.length) {
        errEl.textContent = 'Enter at least one deduction, or choose Clean return.';
        errEl.hidden = false;
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Processing…';
      try {
        await api.apiFetch(`/api/operator/bookings/${booking.id}/return`, {
          method: 'POST',
          body: JSON.stringify({
            clean, deductions,
            operator_notes: root.querySelector('[data-opnotes]').value.trim() || undefined,
          }),
        });
        onDone();
      } catch (err) {
        if (handleAuth(err)) return;
        errEl.textContent = err.message || 'Could not process the return.';
        errEl.hidden = false;
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm return';
      }
    });
  }

  // ── Extend rental ────────────────────────────────────────────────────────
  function renderExtendRental(booking, onDone) {
    mount('tpl-extend-rental');
    root.querySelector('[data-back]').addEventListener('click', onDone);
    root.querySelector('[data-formtitle]').textContent = `Extend — ${booking.ref_code}`;
    const currentReturn = fmtReturnDay(booking.end_at);
    root.querySelector('[data-current]').textContent = `Current return: ${currentReturn}`;

    const dateEl = root.querySelector('[data-newdate]');
    const previewEl = root.querySelector('[data-preview]');
    const errEl = root.querySelector('[data-error]');
    const savedEl = root.querySelector('[data-saved]');
    const saveBtn = root.querySelector('[data-save]');
    // Earliest selectable new return = current return + 1 day.
    const minDate = ymd(new Date(new Date(booking.end_at).getTime())); // end_at is the day after current return
    dateEl.min = minDate;

    dateEl.addEventListener('change', () => {
      previewEl.textContent = '';
      if (!dateEl.value) return;
      const newEndExcl = parseUTC(dateEl.value).getTime() + DAY_MS;
      const days = Math.round((newEndExcl - new Date(booking.end_at).getTime()) / DAY_MS);
      if (days > 0) previewEl.textContent = `${days} extra day${days > 1 ? 's' : ''} — fee calculated at the daily rate.`;
    });

    root.querySelector('[data-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true; savedEl.hidden = true;
      if (!dateEl.value) { errEl.textContent = 'Pick a new return date.'; errEl.hidden = false; return; }
      saveBtn.disabled = true; saveBtn.textContent = 'Extending…';
      try {
        const r = await api.apiFetch(`/api/operator/bookings/${booking.id}/extend`, {
          method: 'POST', body: JSON.stringify({ new_return_date: dateEl.value }),
        });
        savedEl.textContent = `Extended. Fee ${r.extension.extension_fee_fmt} — payment link sent to the customer.`;
        savedEl.hidden = false;
        saveBtn.textContent = 'Done';
        setTimeout(onDone, 1200);
      } catch (err) {
        if (handleAuth(err)) return;
        errEl.textContent = err.message || 'Could not extend the rental.';
        errEl.hidden = false;
        saveBtn.disabled = false; saveBtn.textContent = 'Extend & send payment link';
      }
    });
  }

  // ── Add charge ───────────────────────────────────────────────────────────
  function renderAddCharge(booking, onDone) {
    mount('tpl-add-charge');
    root.querySelector('[data-back]').addEventListener('click', onDone);
    root.querySelector('[data-formtitle]').textContent = `Add charge — ${booking.ref_code}`;

    const typeEl = root.querySelector('[data-type]');
    const tiresField = root.querySelector('[data-tires-field]');
    const tiresEl = root.querySelector('[data-tires]');
    const tonsField = root.querySelector('[data-tons-field]');
    const tonsEl = root.querySelector('[data-tons]');
    const descEl = root.querySelector('[data-desc]');
    const amountEl = root.querySelector('[data-amount]');
    const methodEl = root.querySelector('[data-method]');
    const cardNote = root.querySelector('[data-card-note]');
    const errEl = root.querySelector('[data-error]');
    const savedEl = root.querySelector('[data-saved]');
    const saveBtn = root.querySelector('[data-save]');

    const hasCard = !!(booking.stripe_customer_id && booking.stripe_payment_method_id);
    if (!hasCard) {
      // No saved card — force payment link.
      [...methodEl.options].forEach((o) => { if (o.value === 'card_on_file') o.disabled = true; });
      methodEl.value = 'payment_link';
      cardNote.hidden = false;
    }

    const perTireCents = booking.per_tire_cents || 300;
    let tonnageRateCents = 7500;
    api.apiFetch('/api/operator/settings').then((d) => {
      if (d.settings && Number.isInteger(d.settings.tonnage_overage_rate_cents)) {
        tonnageRateCents = d.settings.tonnage_overage_rate_cents;
      }
    }).catch(() => {});

    function syncType() {
      const t = typeEl.value;
      tiresField.hidden = t !== 'tires';
      tonsField.hidden = t !== 'tonnage_overage';
    }
    typeEl.addEventListener('change', syncType);
    syncType();

    tiresEl.addEventListener('input', () => {
      const n = Math.max(0, parseInt(tiresEl.value, 10) || 0);
      if (n) amountEl.value = centsToInput(n * perTireCents);
    });
    tonsEl.addEventListener('input', () => {
      const n = Math.max(0, Number(tonsEl.value) || 0);
      if (n) amountEl.value = centsToInput(Math.round(n * tonnageRateCents));
    });

    root.querySelector('[data-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true; savedEl.hidden = true;
      const amountCents = inputToCents(amountEl.value);
      const description = descEl.value.trim() || typeEl.options[typeEl.selectedIndex].text;
      if (!amountCents || amountCents <= 0) { errEl.textContent = 'Enter a positive amount.'; errEl.hidden = false; return; }
      const body = {
        charge_type: typeEl.value,
        description,
        amount_cents: amountCents,
        billing_method: methodEl.value,
      };
      if (typeEl.value === 'tonnage_overage' && tonsEl.value) body.weight_tons = Number(tonsEl.value);
      saveBtn.disabled = true; saveBtn.textContent = 'Adding…';
      try {
        await api.apiFetch(`/api/operator/bookings/${booking.id}/charges`, {
          method: 'POST', body: JSON.stringify(body),
        });
        savedEl.textContent = methodEl.value === 'card_on_file'
          ? 'Charged to the card on file. Customer notified.'
          : 'Charge added — payment link sent to the customer.';
        savedEl.hidden = false;
        saveBtn.textContent = 'Done';
        setTimeout(onDone, 1200);
      } catch (err) {
        if (handleAuth(err)) return;
        errEl.textContent = err.message || 'Could not add the charge.';
        errEl.hidden = false;
        saveBtn.disabled = false; saveBtn.textContent = 'Add charge';
      }
    });
  }

  // ── Coupons (admin) ──────────────────────────────────────────────────────
  function couponSummary(c) {
    const parts = [c.value_fmt];
    if (c.trailer_name) parts.push(c.trailer_name); else parts.push('all trailers');
    if (c.min_booking_cents) parts.push(`min ${c.min_booking_fmt}`);
    const uses = c.max_uses != null ? `${c.use_count}/${c.max_uses} used` : `${c.use_count} used`;
    parts.push(uses);
    if (c.expires_at) parts.push(`exp ${fmtDay(c.expires_at)}`);
    return parts.join(' · ');
  }

  async function renderCoupons() {
    mount('tpl-coupons');
    root.querySelector('[data-back]').addEventListener('click', () => renderDashboard());
    root.querySelector('[data-add]').addEventListener('click', () => renderCouponForm());

    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const listEl = root.querySelector('[data-list]');
    const emptyEl = root.querySelector('[data-empty]');

    let coupons;
    try {
      const data = await api.apiFetch('/api/operator/coupons');
      coupons = data.coupons || [];
    } catch (err) {
      if (handleAuth(err)) return;
      loadingEl.hidden = true;
      errEl.textContent = err.message || 'Could not load coupons.';
      errEl.hidden = false;
      return;
    }
    loadingEl.hidden = true;
    if (!coupons.length) { emptyEl.hidden = false; return; }

    const tpl = document.getElementById('tpl-coupon-row');
    for (const c of coupons) {
      const node = tpl.content.cloneNode(true);
      node.querySelector('[data-code]').textContent = c.code;
      node.querySelector('[data-sub]').textContent = couponSummary(c);
      const statusEl = node.querySelector('[data-status]');
      statusEl.textContent = c.active ? 'Active' : 'Inactive';
      statusEl.className = `badge ${c.active ? 'badge-ok' : 'badge-oos'}`;

      const toggleEl = node.querySelector('[data-toggle]');
      toggleEl.textContent = c.active ? 'Deactivate' : 'Activate';
      toggleEl.classList.add(c.active ? 'btn-danger' : 'btn-restore');
      toggleEl.addEventListener('click', async () => {
        toggleEl.disabled = true;
        try {
          await api.apiFetch(`/api/operator/coupons/${c.id}`, {
            method: 'PATCH', body: JSON.stringify({ active: !c.active }),
          });
          renderCoupons();
        } catch (err) {
          if (handleAuth(err)) return;
          errEl.textContent = err.message || 'Could not update.';
          errEl.hidden = false;
          toggleEl.disabled = false;
        }
      });

      // Deletable only while never used.
      const delEl = node.querySelector('[data-del]');
      if (c.use_count === 0) {
        delEl.hidden = false;
        delEl.addEventListener('click', async () => {
          if (!window.confirm(`Delete coupon ${c.code}?`)) return;
          try {
            await api.apiFetch(`/api/operator/coupons/${c.id}`, { method: 'DELETE' });
            renderCoupons();
          } catch (err) {
            if (handleAuth(err)) return;
            errEl.textContent = err.message || 'Could not delete.';
            errEl.hidden = false;
          }
        });
      }
      listEl.appendChild(node);
    }
    listEl.hidden = false;
  }

  function renderCouponForm() {
    mount('tpl-coupon-form');
    root.querySelector('[data-back]').addEventListener('click', () => renderCoupons());

    const typeEl = root.querySelector('#cf-type');
    const valueField = root.querySelector('[data-value-field]');
    const valueLabel = root.querySelector('[data-value-label]');
    const valueEl = root.querySelector('#cf-value');
    const trailerEl = root.querySelector('#cf-trailer');
    const errEl = root.querySelector('[data-error]');
    const savedEl = root.querySelector('[data-saved]');
    const saveBtn = root.querySelector('[data-save]');

    // Populate the trailer restriction dropdown.
    api.apiFetch('/api/operator/trailers').then((d) => {
      for (const t of d.trailers || []) {
        const o = document.createElement('option');
        o.value = t.id; o.textContent = t.name; trailerEl.appendChild(o);
      }
    }).catch(() => {});

    function syncType() {
      const t = typeEl.value;
      valueField.hidden = t === 'free_delivery';
      valueLabel.textContent = t === 'percentage' ? 'Percent off' : 'Amount off ($)';
      valueEl.step = t === 'percentage' ? '1' : '0.01';
    }
    typeEl.addEventListener('change', syncType);
    syncType();

    root.querySelector('[data-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true; savedEl.hidden = true;
      const type = typeEl.value;
      const body = {
        code: root.querySelector('#cf-code').value.trim().toUpperCase() || undefined,
        discount_type: type,
        description: root.querySelector('#cf-desc').value.trim() || undefined,
        min_booking_cents: inputToCents(root.querySelector('#cf-min').value) || 0,
        max_uses: root.querySelector('#cf-max').value.trim() || null,
        trailer_id: trailerEl.value || null,
        expires_at: root.querySelector('#cf-expires').value || null,
      };
      if (type === 'percentage') body.discount_value = parseInt(valueEl.value, 10);
      else if (type === 'flat') body.discount_value = inputToCents(valueEl.value);
      else body.discount_value = 0;

      saveBtn.disabled = true; saveBtn.textContent = 'Creating…';
      try {
        await api.apiFetch('/api/operator/coupons', { method: 'POST', body: JSON.stringify(body) });
        renderCoupons();
      } catch (err) {
        if (handleAuth(err)) return;
        errEl.textContent = err.message || 'Could not create the coupon.';
        errEl.hidden = false;
        saveBtn.disabled = false; saveBtn.textContent = 'Create coupon';
      }
    });
  }

  // ── Settings (admin) ─────────────────────────────────────────────────────
  async function renderSettings() {
    mount('tpl-settings');
    root.querySelector('[data-back]').addEventListener('click', () => renderDashboard());
    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const bodyEl = root.querySelector('[data-body]');
    const depEl = root.querySelector('[data-deposits-enabled]');
    const depStatus = root.querySelector('[data-deposits-status]');
    const tonnageEl = root.querySelector('[data-tonnage]');
    const saveErr = root.querySelector('[data-save-error]');
    const savedEl = root.querySelector('[data-saved]');
    const saveBtn = root.querySelector('[data-save]');

    function paintDepStatus() {
      depStatus.textContent = depEl.checked
        ? 'Deposits are ON — customers pay a refundable deposit at booking.'
        : 'Deposits are OFF — no deposit is collected at booking.';
    }

    let settings;
    try {
      const d = await api.apiFetch('/api/operator/settings');
      settings = d.settings;
    } catch (err) {
      if (handleAuth(err)) return;
      loadingEl.hidden = true;
      errEl.textContent = err.message || 'Could not load settings.';
      errEl.hidden = false;
      return;
    }
    loadingEl.hidden = true;
    depEl.checked = !!settings.deposits_enabled;
    tonnageEl.value = centsToInput(settings.tonnage_overage_rate_cents);
    paintDepStatus();
    depEl.addEventListener('change', paintDepStatus);
    bodyEl.hidden = false;

    saveBtn.addEventListener('click', async () => {
      saveErr.hidden = true; savedEl.hidden = true;
      const tonnage = inputToCents(tonnageEl.value);
      if (tonnage == null) { saveErr.textContent = 'Enter a valid tonnage rate.'; saveErr.hidden = false; return; }
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        await api.apiFetch('/api/operator/settings', {
          method: 'PATCH',
          body: JSON.stringify({ deposits_enabled: depEl.checked, tonnage_overage_rate_cents: tonnage }),
        });
        savedEl.hidden = false;
      } catch (err) {
        if (handleAuth(err)) return;
        saveErr.textContent = err.message || 'Could not save settings.';
        saveErr.hidden = false;
      } finally {
        saveBtn.disabled = false; saveBtn.textContent = 'Save settings';
      }
    });
  }

  // ── Schedule ───────────────────────────────────────────────────────────
  async function renderSchedule(initialDate) {
    mount('tpl-schedule');
    root.querySelector('[data-back]').addEventListener('click', () => renderDashboard());

    const dateInput = root.querySelector('[data-date]');
    const dayLabel = root.querySelector('[data-day-label]');
    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const listEl = root.querySelector('[data-list]');
    const emptyEl = root.querySelector('[data-empty]');

    let current = initialDate || todayISODate();
    dateInput.value = current;

    async function load() {
      dateInput.value = current;
      dayLabel.textContent = current === todayISODate()
        ? 'Today' : fmtDay(`${current}T00:00:00Z`);
      loadingEl.hidden = false;
      errEl.hidden = true;
      listEl.hidden = true;
      emptyEl.hidden = true;
      listEl.replaceChildren();

      let bookings;
      try {
        const data = await api.apiFetch(`/api/operator/schedule?date=${current}`);
        bookings = data.bookings || [];
      } catch (err) {
        if (handleAuth(err)) return;
        loadingEl.hidden = true;
        errEl.textContent = err.message || 'Could not load the schedule.';
        errEl.hidden = false;
        return;
      }

      loadingEl.hidden = true;
      if (!bookings.length) {
        emptyEl.hidden = false;
        return;
      }
      const rowTpl = document.getElementById('tpl-booking-row');
      for (const b of bookings) {
        const node = rowTpl.content.cloneNode(true);
        fillBookingRow(node, b, (bk) => renderBookingDetail(bk.id, () => renderSchedule(current)));
        listEl.appendChild(node);
      }
      listEl.hidden = false;
    }

    root.querySelector('[data-prev]').addEventListener('click', () => {
      current = shiftDate(current, -1);
      load();
    });
    root.querySelector('[data-next]').addEventListener('click', () => {
      current = shiftDate(current, 1);
      load();
    });
    dateInput.addEventListener('change', () => {
      if (dateInput.value) { current = dateInput.value; load(); }
    });

    load();
  }

  // ── Inventory ──────────────────────────────────────────────────────────
  async function renderInventory() {
    mount('tpl-inventory');

    root.querySelector('[data-back]').addEventListener('click', () => renderDashboard());
    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const listEl = root.querySelector('[data-list]');

    let trailers;
    try {
      const data = await api.apiFetch('/api/operator/trailers');
      trailers = data.trailers || [];
    } catch (err) {
      if (handleAuth(err)) return;
      loadingEl.hidden = true;
      errEl.textContent = err.message || 'Could not load the fleet.';
      errEl.hidden = false;
      return;
    }

    loadingEl.hidden = true;
    if (trailers.length === 0) {
      loadingEl.hidden = false;
      loadingEl.textContent = 'No trailers yet.';
      return;
    }

    const rowTpl = document.getElementById('tpl-trailer-row');
    for (const trailer of trailers) {
      const node = rowTpl.content.cloneNode(true);
      const thumb = node.querySelector('[data-thumb]');
      const nameEl = node.querySelector('[data-name]');
      const subEl = node.querySelector('[data-sub]');
      const badgeEl = node.querySelector('[data-badge]');
      const toggleEl = node.querySelector('[data-toggle]');
      const openEl = node.querySelector('[data-open]');

      if (trailer.photo_url) {
        thumb.src = trailer.photo_url;
        thumb.alt = trailer.name;
        thumb.addEventListener('error', () => thumb.classList.add('thumb-broken'));
      } else {
        thumb.classList.add('thumb-broken');
      }
      nameEl.textContent = trailer.name;
      subEl.textContent = [trailer.size_label, priceSummary(trailer)].filter(Boolean).join(' · ');

      wireToggle(trailer, badgeEl, toggleEl, errEl);
      openEl.addEventListener('click', () => renderTrailerDetail(trailer));

      // Unit counts + on-hold stepper.
      const u = trailer.units || {
        total: trailer.quantity_total ?? 1, on_hold: trailer.quantity_on_hold ?? 0, out: 0,
        available: Math.max(0, (trailer.quantity_total ?? 1) - (trailer.quantity_on_hold ?? 0)),
      };
      const unitsEl = node.querySelector('[data-units]');
      const holdEl = node.querySelector('[data-hold]');
      const decBtn = node.querySelector('[data-hold-dec]');
      const incBtn = node.querySelector('[data-hold-inc]');
      function paintUnits() {
        unitsEl.textContent = `Total ${u.total} · Out ${u.out} · Avail ${u.available}`;
        holdEl.textContent = u.on_hold;
        decBtn.disabled = u.on_hold <= 0;
        incBtn.disabled = u.on_hold >= u.total;
      }
      paintUnits();
      async function setHold(next) {
        next = Math.max(0, Math.min(u.total, next));
        if (next === u.on_hold) return;
        decBtn.disabled = incBtn.disabled = true;
        try {
          const data = await api.apiFetch(`/api/operator/trailers/${trailer.id}`, {
            method: 'PATCH', body: JSON.stringify({ quantity_on_hold: next }),
          });
          u.on_hold = data.trailer.quantity_on_hold;
          u.available = Math.max(0, u.total - u.on_hold - u.out);
          Object.assign(trailer, data.trailer);
        } catch (err) {
          if (handleAuth(err)) return;
          errEl.textContent = err.message || 'Could not update units on hold.';
          errEl.hidden = false;
        } finally {
          paintUnits();
        }
      }
      decBtn.addEventListener('click', () => setHold(u.on_hold - 1));
      incBtn.addEventListener('click', () => setHold(u.on_hold + 1));

      listEl.appendChild(node);
    }
    listEl.hidden = false;
  }

  // ── Trailer detail ─────────────────────────────────────────────────────
  // Editable fields per trailer type. kind drives the input + conversion.
  const COMMON_FIELDS = [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'photo_url', label: 'Photo URL', kind: 'text' },
    { key: 'description', label: 'Description', kind: 'textarea' },
  ];
  const TRAILER_FIELDS = [
    { key: 'hourly_rate', label: 'Hourly rate ($)', kind: 'money' },
    { key: 'daily_rate', label: 'Daily rate ($)', kind: 'money' },
    { key: 'weekly_rate', label: 'Weekly rate ($)', kind: 'money' },
    { key: 'monthly_rate', label: 'Monthly rate ($)', kind: 'money' },
  ];
  const DUMPSTER_FIELDS = [
    { key: 'flat_drop_off_cents', label: 'Drop-off flat ($)', kind: 'money' },
    { key: 'flat_drop_off_days', label: 'Days included', kind: 'int' },
    { key: 'extra_day_cents', label: 'Extra day ($)', kind: 'money' },
    { key: 'per_tire_cents', label: 'Per tire ($)', kind: 'money' },
  ];

  const INVENTORY_FIELDS = [
    { key: 'quantity_total', label: 'Units owned', kind: 'int' },
    { key: 'quantity_on_hold', label: 'Units on hold (maintenance)', kind: 'int' },
  ];

  // Per-trailer security deposit. deposit_cents is NOT NULL in the DB, so an
  // empty amount must serialize to 0 (zero), never null.
  const DEPOSIT_FIELDS = [
    { key: 'deposit_enabled', label: 'Collect deposit for this trailer', kind: 'bool' },
    { key: 'deposit_cents', label: 'Deposit amount ($)', kind: 'money', zero: true },
  ];

  function fieldsFor(type) {
    return COMMON_FIELDS
      .concat(type === 'dumpster' ? DUMPSTER_FIELDS : TRAILER_FIELDS)
      .concat(INVENTORY_FIELDS)
      .concat(DEPOSIT_FIELDS);
  }

  function renderTrailerDetail(trailer) {
    mount('tpl-trailer-detail');

    root.querySelector('[data-back]').addEventListener('click', () => renderInventory());

    const photoEl = root.querySelector('[data-photo]');
    const titleEl = root.querySelector('[data-title]');
    const typeEl = root.querySelector('[data-typeline]');
    const badgeEl = root.querySelector('[data-badge]');
    const toggleEl = root.querySelector('[data-toggle]');
    const fieldsEl = root.querySelector('[data-fields]');
    const formEl = root.querySelector('[data-form]');
    const errEl = root.querySelector('[data-error]');
    const savedEl = root.querySelector('[data-saved]');
    const saveBtn = root.querySelector('[data-save]');

    function paintHead() {
      titleEl.textContent = trailer.name;
      const typeName = trailer.type === 'dumpster' ? 'Dumpster' : 'Trailer';
      typeEl.textContent = [typeName, trailer.size_label].filter(Boolean).join(' · ');
      if (trailer.photo_url) {
        photoEl.src = trailer.photo_url;
        photoEl.alt = trailer.name;
        photoEl.hidden = false;
        photoEl.addEventListener('error', () => { photoEl.hidden = true; }, { once: true });
      }
    }
    paintHead();

    wireToggle(trailer, badgeEl, toggleEl, errEl, paintHead);

    // Build the edit form from the field config.
    const fields = fieldsFor(trailer.type);
    const inputs = {};
    for (const f of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const label = document.createElement('label');
      label.textContent = f.label;
      const id = `f-${f.key}`;
      label.htmlFor = id;

      let input;
      if (f.kind === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
      } else if (f.kind === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!trailer[f.key];
        wrap.classList.add('field-check');
      } else {
        input = document.createElement('input');
        input.type = f.kind === 'text' ? 'text' : 'number';
        if (f.kind === 'money') { input.step = '0.01'; input.min = '0'; input.inputMode = 'decimal'; }
        if (f.kind === 'int') { input.step = '1'; input.min = '0'; input.inputMode = 'numeric'; }
      }
      input.id = id;
      if (f.kind !== 'bool') {
        input.value =
          f.kind === 'money' ? centsToInput(trailer[f.key]) :
          trailer[f.key] == null ? '' : String(trailer[f.key]);
      }

      inputs[f.key] = input;
      wrap.append(label, input);
      fieldsEl.appendChild(wrap);
    }

    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      savedEl.hidden = true;

      const patch = {};
      for (const f of fields) {
        if (f.kind === 'bool') { patch[f.key] = inputs[f.key].checked; continue; }
        const raw = inputs[f.key].value;
        if (f.kind === 'money') {
          const c = inputToCents(raw);
          patch[f.key] = c == null && f.zero ? 0 : c;
        } else if (f.kind === 'int') patch[f.key] = raw.trim() === '' ? null : parseInt(raw, 10);
        else patch[f.key] = raw.trim() === '' ? null : raw.trim();
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const data = await api.apiFetch(`/api/operator/trailers/${trailer.id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        Object.assign(trailer, data.trailer);
        paintHead();
        savedEl.hidden = false;
      } catch (err) {
        if (handleAuth(err)) return;
        errEl.textContent = err.message || 'Could not save.';
        errEl.hidden = false;
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save changes';
      }
    });
  }

  // ── Blackout removal (shared by calendar + blackouts screens) ───────────
  async function confirmDeleteBlackout(bo, onDone, btn) {
    const label = bo.fleet_wide ? 'all trailers' : (bo.trailer_name || 'this trailer');
    if (!window.confirm(`Remove the blackout for ${label}?`)) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
    try {
      await api.apiFetch(`/api/operator/blackouts/${bo.id}`, { method: 'DELETE' });
      onDone();
    } catch (err) {
      if (handleAuth(err)) return;
      if (btn) { btn.disabled = false; btn.textContent = 'Remove'; }
      window.alert(err.message || 'Could not remove the blackout.');
    }
  }

  // ── Calendar ─────────────────────────────────────────────────────────────
  // Month/week grid of bookings (dots, color-coded by trailer) + blackouts
  // (shaded cells). Tapping a day opens a panel listing that day's bookings and
  // blackouts, with a quick "Block" action. `state` can carry { mode, anchor,
  // selected } to restore the view after drilling into a booking or blackout.
  const CAL_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  async function renderCalendar(state) {
    mount('tpl-calendar');
    root.querySelector('[data-back]').addEventListener('click', () => renderDashboard());

    const view = { mode: 'month', anchor: todayISODate(), ...(state || {}) };
    let selected = view.selected || null;

    const titleEl = root.querySelector('[data-title]');
    const gridEl = root.querySelector('[data-grid]');
    const legendEl = root.querySelector('[data-legend]');
    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const panelEl = root.querySelector('[data-day-panel]');
    const modeBtns = root.querySelectorAll('[data-mode]');
    const todayISO = todayISODate();

    let bookingRanges = [];   // [{ b, s, e }]
    let blackoutRanges = [];  // [{ x, s, e }]

    function setMode(mode) {
      view.mode = mode;
      modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    }
    setMode(view.mode);
    modeBtns.forEach((b) => b.addEventListener('click', () => {
      if (view.mode === b.dataset.mode) return;
      setMode(b.dataset.mode);
      selected = null;
      load();
    }));

    root.querySelector('[data-manage]').addEventListener('click', () =>
      renderBlackouts({}, () => renderCalendar(view)));

    root.querySelector('[data-prev]').addEventListener('click', () => step(-1));
    root.querySelector('[data-next]').addEventListener('click', () => step(1));

    function step(dir) {
      const a = parseUTC(view.anchor);
      if (view.mode === 'week') {
        view.anchor = ymd(new Date(a.getTime() + dir * 7 * DAY_MS));
      } else {
        // Jump whole months, anchored to the 1st to avoid day overflow.
        view.anchor = ymd(new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + dir, 1)));
      }
      selected = null;
      load();
    }

    // Visible grid: a Sunday start + number of weeks.
    function gridInfo() {
      const a = parseUTC(view.anchor);
      if (view.mode === 'week') {
        const start = new Date(a.getTime() - a.getUTCDay() * DAY_MS);
        return { start, weeks: 1, monthIndex: null };
      }
      const monthFirst = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1));
      const start = new Date(monthFirst.getTime() - monthFirst.getUTCDay() * DAY_MS);
      return { start, weeks: 6, monthIndex: monthFirst.getUTCMonth() };
    }

    function overlapping(ranges, dayStart) {
      const dayEnd = dayStart + DAY_MS;
      return ranges.filter((r) => r.s < dayEnd && r.e > dayStart);
    }

    function paintTitle(info) {
      if (view.mode === 'week') {
        const end = new Date(info.start.getTime() + 6 * DAY_MS);
        titleEl.textContent = `${fmtShortDay(info.start)} – ${fmtShortDay(end)}`;
      } else {
        titleEl.textContent = fmtMonthYear(parseUTC(view.anchor));
      }
    }

    function renderGrid(info) {
      gridEl.replaceChildren();
      for (const d of CAL_DOW) {
        const h = document.createElement('div');
        h.className = 'cal-dow';
        h.textContent = d[0];
        h.setAttribute('aria-label', d);
        gridEl.appendChild(h);
      }
      const cells = info.weeks * 7;
      for (let i = 0; i < cells; i++) {
        const day = new Date(info.start.getTime() + i * DAY_MS);
        const iso = ymd(day);
        const dayStart = day.getTime();

        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cal-cell';
        if (info.monthIndex !== null && day.getUTCMonth() !== info.monthIndex) cell.classList.add('outside');
        if (iso === todayISO) cell.classList.add('today');
        if (iso === selected) cell.classList.add('selected');

        const num = document.createElement('span');
        num.className = 'cal-num';
        num.textContent = String(day.getUTCDate());
        cell.appendChild(num);

        const dayBookings = overlapping(bookingRanges, dayStart);
        if (overlapping(blackoutRanges, dayStart).length) cell.classList.add('blocked');

        if (dayBookings.length) {
          const dots = document.createElement('span');
          dots.className = 'cal-dots';
          for (const r of dayBookings.slice(0, 3)) {
            const dot = document.createElement('span');
            dot.className = 'cal-dot';
            dot.style.background = `hsl(${trailerHue(r.b.trailer_slug || r.b.trailer_name)} 55% 55%)`;
            dots.appendChild(dot);
          }
          if (dayBookings.length > 3) {
            const more = document.createElement('span');
            more.className = 'cal-more';
            more.textContent = `+${dayBookings.length - 3}`;
            dots.appendChild(more);
          }
          cell.appendChild(dots);
        }

        cell.addEventListener('click', () => {
          selected = iso;
          gridEl.querySelectorAll('.cal-cell.selected').forEach((c) => c.classList.remove('selected'));
          cell.classList.add('selected');
          renderDayPanel(iso);
        });
        gridEl.appendChild(cell);
      }
    }

    function renderDayPanel(iso) {
      const dayStart = parseUTC(iso).getTime();
      const dayBookings = overlapping(bookingRanges, dayStart).map((r) => r.b);
      const dayBlackouts = overlapping(blackoutRanges, dayStart).map((r) => r.x);

      root.querySelector('[data-day-title]').textContent = fmtDay(iso);
      const boList = root.querySelector('[data-day-blackouts]');
      const bkList = root.querySelector('[data-day-bookings]');
      const emptyEl = root.querySelector('[data-day-empty]');
      boList.replaceChildren();
      bkList.replaceChildren();

      const boTpl = document.getElementById('tpl-blackout-row');
      for (const bo of dayBlackouts) {
        const node = boTpl.content.cloneNode(true);
        fillBlackoutRow(node, bo, (b, li, btn) => confirmDeleteBlackout(b, () => load(), btn));
        boList.appendChild(node);
      }
      const rowTpl = document.getElementById('tpl-booking-row');
      for (const b of dayBookings) {
        const node = rowTpl.content.cloneNode(true);
        fillBookingRow(node, b, (bk) =>
          renderBookingDetail(bk.id, () => renderCalendar({ ...view, selected: iso })));
        bkList.appendChild(node);
      }
      emptyEl.hidden = dayBookings.length > 0 || dayBlackouts.length > 0;

      root.querySelector('[data-block-day]').onclick = () =>
        renderBlackouts({ start: iso, end: iso }, () => renderCalendar({ ...view, selected: iso }));

      panelEl.hidden = false;
    }

    async function load() {
      const info = gridInfo();
      paintTitle(info);
      loadingEl.hidden = false;
      errEl.hidden = true;
      gridEl.hidden = true;
      legendEl.hidden = true;
      panelEl.hidden = true;

      const from = ymd(info.start);
      const to = ymd(new Date(info.start.getTime() + info.weeks * 7 * DAY_MS)); // exclusive

      let data;
      try {
        data = await api.apiFetch(`/api/operator/calendar?from=${from}&to=${to}`);
      } catch (err) {
        if (handleAuth(err)) return;
        loadingEl.hidden = true;
        errEl.textContent = err.message || 'Could not load the calendar.';
        errEl.hidden = false;
        return;
      }

      bookingRanges = (data.bookings || []).map((b) => ({ b, s: Date.parse(b.start_at), e: Date.parse(b.end_at) }));
      blackoutRanges = (data.blackouts || []).map((x) => ({ x, s: Date.parse(x.start_at), e: Date.parse(x.end_at) }));

      loadingEl.hidden = true;
      renderGrid(info);
      gridEl.hidden = false;
      legendEl.hidden = false;
      if (selected) renderDayPanel(selected);
    }

    load();
  }

  // ── Blackouts management ─────────────────────────────────────────────────
  // Add form (trailer / from / to / reason) + a list of current blackouts with
  // remove buttons. `prefill` can seed the date inputs; `onBack` overrides the
  // back target (defaults to the calendar).
  async function renderBlackouts(prefill, onBack) {
    mount('tpl-blackouts');
    root.querySelector('[data-back]').addEventListener('click', () => (onBack || renderCalendar)());

    const formEl = root.querySelector('[data-form]');
    const trailerSel = root.querySelector('[data-trailer]');
    const startEl = root.querySelector('[data-start]');
    const endEl = root.querySelector('[data-end]');
    const reasonEl = root.querySelector('[data-reason]');
    const errEl = root.querySelector('[data-error]');
    const savedEl = root.querySelector('[data-saved]');
    const saveBtn = root.querySelector('[data-save]');

    const loadingEl = root.querySelector('[data-loading]');
    const listErrEl = root.querySelector('[data-list-error]');
    const listEl = root.querySelector('[data-list]');
    const emptyEl = root.querySelector('[data-empty]');

    if (prefill && prefill.start) startEl.value = prefill.start;
    if (prefill && prefill.end) endEl.value = prefill.end;

    // Populate the trailer dropdown ("All trailers" is already in the markup).
    try {
      const data = await api.apiFetch('/api/operator/trailers');
      for (const t of data.trailers || []) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        trailerSel.appendChild(opt);
      }
    } catch (err) {
      if (handleAuth(err)) return;
      // Non-fatal — the operator can still block the whole fleet.
    }

    async function loadList() {
      loadingEl.hidden = false;
      listErrEl.hidden = true;
      listEl.hidden = true;
      emptyEl.hidden = true;
      listEl.replaceChildren();

      let blackouts;
      try {
        const data = await api.apiFetch('/api/operator/blackouts');
        blackouts = data.blackouts || [];
      } catch (err) {
        if (handleAuth(err)) return;
        loadingEl.hidden = true;
        listErrEl.textContent = err.message || 'Could not load blackouts.';
        listErrEl.hidden = false;
        return;
      }

      loadingEl.hidden = true;
      if (!blackouts.length) { emptyEl.hidden = false; return; }
      const tpl = document.getElementById('tpl-blackout-row');
      for (const bo of blackouts) {
        const node = tpl.content.cloneNode(true);
        fillBlackoutRow(node, bo, (b, li, btn) => confirmDeleteBlackout(b, loadList, btn));
        listEl.appendChild(node);
      }
      listEl.hidden = false;
    }

    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      savedEl.hidden = true;
      const start = startEl.value;
      const end = endEl.value || start;
      if (!start) {
        errEl.textContent = 'Pick a start date.';
        errEl.hidden = false;
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Blocking…';
      try {
        await api.apiFetch('/api/operator/blackouts', {
          method: 'POST',
          body: JSON.stringify({
            trailer_id: trailerSel.value || null,
            start,
            end,
            reason: reasonEl.value.trim() || null,
          }),
        });
        savedEl.hidden = false;
        reasonEl.value = '';
        await loadList();
      } catch (err) {
        if (handleAuth(err)) return;
        errEl.textContent = err.message || 'Could not block those dates.';
        errEl.hidden = false;
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Block these dates';
      }
    });

    loadList();
  }

  // ── Notifications (Phase 8) ──────────────────────────────────────────────
  // Wires the dashboard "Alerts on this device" card to the GC.push module.
  // Adapts to support / permission / subscription state.
  async function setupNotifications() {
    const card = root.querySelector('[data-notif]');
    if (!card || !GC.push) return;
    const statusEl = card.querySelector('[data-notif-status]');
    const enableBtn = card.querySelector('[data-notif-enable]');
    const testBtn = card.querySelector('[data-notif-test]');
    const disableBtn = card.querySelector('[data-notif-disable]');
    const errEl = card.querySelector('[data-notif-error]');
    const push = GC.push;

    card.hidden = false;
    const show = (btn, on) => { btn.hidden = !on; };

    async function paint() {
      errEl.hidden = true;
      const st = await push.status();
      if (!st.supported) {
        statusEl.textContent = 'This device or browser doesn’t support push notifications.';
        show(enableBtn, false); show(testBtn, false); show(disableBtn, false);
        return;
      }
      if (st.permission === 'denied') {
        statusEl.textContent = 'Notifications are blocked in your browser settings — re-allow them to turn alerts on.';
        show(enableBtn, false); show(testBtn, false); show(disableBtn, false);
        return;
      }
      if (st.subscribed) {
        statusEl.textContent = 'On — this device gets a push when a new booking is paid.';
        show(enableBtn, false); show(testBtn, true); show(disableBtn, true);
      } else {
        statusEl.textContent = 'Off — enable alerts to get a push the moment a booking comes in.';
        show(enableBtn, true); show(testBtn, false); show(disableBtn, false);
      }
    }

    function run(btn, label, fn, after) {
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = label;
      Promise.resolve()
        .then(fn)
        .then(() => { if (after) return after(); })
        .catch((err) => {
          if (handleAuth(err)) return;
          errEl.textContent = err.message || 'Something went wrong.';
          errEl.hidden = false;
        })
        .finally(() => { btn.disabled = false; btn.textContent = original; });
    }

    enableBtn.addEventListener('click', () => run(enableBtn, 'Enabling…', () => push.enable(), paint));
    disableBtn.addEventListener('click', () => run(disableBtn, 'Turning off…', () => push.disable(), paint));
    testBtn.addEventListener('click', () => run(testBtn, 'Sending…', () => push.test()));

    paint();
  }

  // ── Accounts (admin) ─────────────────────────────────────────────────────
  function roleBadge(el, role) {
    el.textContent = role === 'admin' ? 'Admin' : 'Operator';
    el.className = `badge ${role === 'admin' ? 'badge-role-admin' : 'badge-role-operator'}`;
  }
  function activeBadge(el, active) {
    el.textContent = active ? 'Active' : 'Inactive';
    el.className = `badge ${active ? 'badge-ok' : 'badge-oos'}`;
  }

  async function renderAccounts() {
    mount('tpl-accounts');
    root.querySelector('[data-back]').addEventListener('click', () => renderDashboard());
    root.querySelector('[data-add]').addEventListener('click', () => renderAccountForm(null));

    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const listEl = root.querySelector('[data-list]');

    let accounts;
    try {
      const data = await api.apiFetch('/api/operator/accounts');
      accounts = data.accounts || [];
    } catch (err) {
      if (handleAuth(err)) return;
      loadingEl.hidden = true;
      errEl.textContent = err.message || 'Could not load accounts.';
      errEl.hidden = false;
      return;
    }

    loadingEl.hidden = true;
    const tpl = document.getElementById('tpl-account-row');
    const meId = api.auth.user && api.auth.user.id;
    for (const a of accounts) {
      const node = tpl.content.cloneNode(true);
      node.querySelector('[data-name]').textContent = a.name + (a.id === meId ? ' (you)' : '');
      node.querySelector('[data-contact]').textContent = [a.email, a.phone].filter(Boolean).join(' · ');
      node.querySelector('[data-login]').textContent = a.last_login_at
        ? `Last login ${fmtDateTime(a.last_login_at)}` : 'Never logged in';
      roleBadge(node.querySelector('[data-role]'), a.role);
      activeBadge(node.querySelector('[data-active]'), a.active);
      node.querySelector('[data-open]').addEventListener('click', () => renderAccountForm(a));
      listEl.appendChild(node);
    }
    listEl.hidden = false;
  }

  // account = null → create; otherwise edit that account.
  function renderAccountForm(account) {
    mount('tpl-account-form');
    const isEdit = !!account;
    const meId = api.auth.user && api.auth.user.id;
    const isSelf = isEdit && account.id === meId;

    root.querySelector('[data-back]').addEventListener('click', () => renderAccounts());

    const nameEl = root.querySelector('[data-name]');
    const emailEl = root.querySelector('[data-email]');
    const phoneEl = root.querySelector('[data-phone]');
    const roleEl = root.querySelector('[data-role]');
    const pwEl = root.querySelector('[data-password]');
    const errEl = root.querySelector('[data-error]');
    const savedEl = root.querySelector('[data-saved]');
    const saveBtn = root.querySelector('[data-save]');

    root.querySelector('[data-title]').textContent = isEdit ? 'Edit account' : 'New operator';
    root.querySelector('[data-formtitle]').textContent = isEdit ? account.name : 'New Operator';
    saveBtn.textContent = isEdit ? 'Save changes' : 'Create operator';

    if (isEdit) {
      nameEl.value = account.name || '';
      phoneEl.value = account.phone || '';
      roleEl.value = account.role || 'operator';
      root.querySelector('[data-email-field]').hidden = true; // email is fixed after creation
      root.querySelector('[data-pw-label]').textContent = 'Reset password';
      root.querySelector('[data-pw-hint]').hidden = false;
      pwEl.placeholder = 'Leave blank to keep current';
      if (isSelf) roleEl.disabled = true; // can't change your own role
    }

    // Danger zone (deactivate) — only when editing someone else who is active.
    const dangerEl = root.querySelector('[data-danger]');
    if (isEdit && !isSelf && account.active) {
      dangerEl.hidden = false;
      root.querySelector('[data-danger-note]').textContent =
        'Deactivating blocks this person from logging in. Their history is kept.';
      root.querySelector('[data-deactivate]').addEventListener('click', async () => {
        if (!window.confirm(`Deactivate ${account.name}? They won't be able to log in.`)) return;
        try {
          await api.apiFetch(`/api/operator/accounts/${account.id}`, { method: 'DELETE' });
          renderAccounts();
        } catch (err) {
          if (handleAuth(err)) return;
          errEl.textContent = err.message || 'Could not deactivate.';
          errEl.hidden = false;
        }
      });
    } else if (isEdit && !isSelf && !account.active) {
      // Reactivate option for an inactive account.
      dangerEl.hidden = false;
      root.querySelector('[data-danger-note]').textContent = 'This account is deactivated.';
      const btn = root.querySelector('[data-deactivate]');
      btn.textContent = 'Reactivate account';
      btn.classList.remove('btn-danger');
      btn.addEventListener('click', async () => {
        try {
          await api.apiFetch(`/api/operator/accounts/${account.id}`, {
            method: 'PATCH', body: JSON.stringify({ active: true }),
          });
          renderAccounts();
        } catch (err) {
          if (handleAuth(err)) return;
          errEl.textContent = err.message || 'Could not reactivate.';
          errEl.hidden = false;
        }
      });
    }

    root.querySelector('[data-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true; savedEl.hidden = true;
      const name = nameEl.value.trim();
      const phone = phoneEl.value.trim();
      const role = roleEl.value;
      const password = pwEl.value;
      if (!name) { errEl.textContent = 'Name is required.'; errEl.hidden = false; return; }
      if (!isEdit && password.length < 8) { errEl.textContent = 'Temporary password must be at least 8 characters.'; errEl.hidden = false; return; }

      saveBtn.disabled = true;
      saveBtn.textContent = isEdit ? 'Saving…' : 'Creating…';
      try {
        if (isEdit) {
          const body = { name, phone, password: password || undefined };
          if (!isSelf) body.role = role;
          await api.apiFetch(`/api/operator/accounts/${account.id}`, {
            method: 'PATCH', body: JSON.stringify(body),
          });
        } else {
          await api.apiFetch('/api/operator/accounts', {
            method: 'POST',
            body: JSON.stringify({ name, email: emailEl.value.trim(), phone, role, password }),
          });
        }
        renderAccounts();
      } catch (err) {
        if (handleAuth(err)) return;
        errEl.textContent = err.message || 'Could not save the account.';
        errEl.hidden = false;
        saveBtn.disabled = false;
        saveBtn.textContent = isEdit ? 'Save changes' : 'Create operator';
      }
    });
  }

  // ── Diagnostics (admin): integration status + test email ─────────────────
  async function renderDiagnostics() {
    mount('tpl-diagnostics');
    root.querySelector('[data-back]').addEventListener('click', () => renderDashboard());

    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const listEl = root.querySelector('[data-integrations]');
    const emailEl = root.querySelector('[data-email]');
    const sendBtn = root.querySelector('[data-send]');
    const testErr = root.querySelector('[data-test-error]');
    const testOk = root.querySelector('[data-test-ok]');

    if (api.auth.user && api.auth.user.email) emailEl.value = api.auth.user.email;

    // Labels for the channels that matter, in display order.
    const CHANNELS = [
      ['stripe_payments', 'Stripe payments'],
      ['stripe_webhook_secret', 'Stripe webhook secret'],
      ['email_resend', 'Email (Resend)'],
      ['web_push', 'Web push (VAPID)'],
      ['sms_twilio', 'SMS (Twilio)'],
      ['operator_phone_set', 'Operator phone'],
    ];

    try {
      const data = await api.apiFetch('/api/operator/integrations');
      loadingEl.hidden = true;
      listEl.replaceChildren();
      for (const [key, label] of CHANNELS) {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        const badge = document.createElement('span');
        badge.className = `badge ${data[key] ? 'badge-ok' : 'badge-oos'}`;
        badge.textContent = data[key] ? 'On' : 'Off';
        dd.appendChild(badge);
        row.append(dt, dd);
        listEl.appendChild(row);
      }
      // Extra context rows.
      for (const [label, val] of [['From email', data.from_email], ['Base URL', data.base_url]]) {
        const row = document.createElement('div');
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd'); dd.textContent = val || '—';
        row.append(dt, dd);
        listEl.appendChild(row);
      }
      listEl.hidden = false;
    } catch (err) {
      if (handleAuth(err)) return;
      loadingEl.hidden = true;
      errEl.textContent = err.message || 'Could not load integration status.';
      errEl.hidden = false;
    }

    sendBtn.addEventListener('click', async () => {
      testErr.hidden = true; testOk.hidden = true;
      const to = emailEl.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        testErr.textContent = 'Enter a valid email address.';
        testErr.hidden = false;
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      try {
        await api.apiFetch('/api/operator/test-email', {
          method: 'POST', body: JSON.stringify({ email: to }),
        });
        testOk.textContent = `Sent to ${to}. Check the inbox (and spam).`;
        testOk.hidden = false;
      } catch (err) {
        if (handleAuth(err)) return;
        testErr.textContent = err.message || 'Could not send the test email.';
        testErr.hidden = false;
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send test email';
      }
    });

    // Generic "send test X" runner: POSTs, shows ok/err, restores the button.
    function wireTest(btn, okEl, errEl2, label, bodyFn, path, okMsg) {
      btn.addEventListener('click', async () => {
        okEl.hidden = true; errEl2.hidden = true;
        const body = bodyFn ? bodyFn() : null;
        if (body === false) return; // validation handled in bodyFn
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          await api.apiFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
          okEl.textContent = okMsg;
          okEl.hidden = false;
        } catch (err) {
          if (handleAuth(err)) return;
          errEl2.textContent = err.message || 'Could not send.';
          errEl2.hidden = false;
        } finally {
          btn.disabled = false; btn.textContent = label;
        }
      });
    }

    wireTest(
      root.querySelector('[data-send-push]'),
      root.querySelector('[data-push-ok]'), root.querySelector('[data-push-error]'),
      'Send test push', null, '/api/operator/push/test',
      'Sent — check this device for the notification.'
    );

    const phoneEl = root.querySelector('[data-phone]');
    wireTest(
      root.querySelector('[data-send-sms]'),
      root.querySelector('[data-sms-ok]'), root.querySelector('[data-sms-error]'),
      'Send test SMS',
      () => ({ phone: phoneEl.value.trim() || undefined }),
      '/api/operator/test-sms',
      'Sent — check the phone for the text.'
    );
  }

  // ── Reports (admin + owner) ──────────────────────────────────────────────
  function currentYM() { return new Date().toISOString().slice(0, 7); }
  function ymRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}`, y, m };
  }

  async function renderReports() {
    mount('tpl-reports');
    root.querySelector('[data-back]').addEventListener('click', () => renderDashboard());
    const monthEl = root.querySelector('[data-month]');
    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const reportEl = root.querySelector('[data-report]');
    const isAdmin = api.auth.user && api.auth.user.role === 'admin';
    monthEl.value = currentYM();

    async function load() {
      const ym = monthEl.value || currentYM();
      const { from, to, y, m } = ymRange(ym);
      loadingEl.hidden = false; errEl.hidden = true; reportEl.hidden = true;
      let summary; let trailers; let bookings;
      try {
        const qs = `from=${from}&to=${to}`;
        [summary, trailers, bookings] = await Promise.all([
          api.apiFetch(`/api/operator/reports/summary?${qs}`).then((d) => d.summary),
          api.apiFetch(`/api/operator/reports/by-trailer?${qs}`).then((d) => d.trailers),
          api.apiFetch(`/api/operator/reports/bookings?${qs}`).then((d) => d.bookings),
        ]);
      } catch (err) {
        if (handleAuth(err)) return;
        loadingEl.hidden = true;
        errEl.textContent = err.message || 'Could not load reports.';
        errEl.hidden = false;
        return;
      }
      loadingEl.hidden = true;

      // Summary cards.
      const cards = [
        ['Gross Revenue', summary.gross_fmt],
        ['Stripe Fees', '- ' + summary.stripe_fees_fmt],
        ['Net Revenue', summary.net_fmt],
        [`Commission (${Math.round(summary.commission_rate * 100)}%)`, summary.commission_fmt],
        [`Retainer · ${summary.retainer_tier}`, summary.retainer_fmt],
        ['Total Due to Operator', summary.total_due_fmt],
      ];
      const grid = root.querySelector('[data-summary]');
      grid.replaceChildren();
      cards.forEach(([label, val], i) => {
        const c = document.createElement('div');
        c.className = 'stat-card' + (i === cards.length - 1 ? ' stat-total' : '');
        c.innerHTML = `<span class="stat-label"></span><span class="stat-val"></span>`;
        c.querySelector('.stat-label').textContent = label;
        c.querySelector('.stat-val').textContent = val || '$0';
        grid.appendChild(c);
      });

      // Statement / CSV (admin only).
      const genCard = root.querySelector('[data-gen-card]');
      genCard.hidden = !isAdmin;
      if (isAdmin && !genCard.dataset.wired) {
        genCard.dataset.wired = '1';
        const genErr = root.querySelector('[data-gen-error]');
        const genOk = root.querySelector('[data-gen-ok]');
        root.querySelector('[data-generate]').addEventListener('click', async (e) => {
          genErr.hidden = true; genOk.hidden = true;
          const ymNow = monthEl.value || currentYM(); const [yy, mm] = ymNow.split('-').map(Number);
          const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Sending…';
          try {
            const r = await api.apiFetch('/api/operator/reports/send-statement', {
              method: 'POST', body: JSON.stringify({ month: mm, year: yy }),
            });
            genOk.textContent = `Statement for ${r.label} emailed to ${r.recipients.join(', ')} (total due ${r.total_due_fmt}).`;
            genOk.hidden = false;
          } catch (err) {
            if (handleAuth(err)) return;
            genErr.textContent = err.message || 'Could not send statement.';
            genErr.hidden = false;
          } finally { btn.disabled = false; btn.textContent = 'Generate & email statement'; }
        });
        root.querySelector('[data-csv]').addEventListener('click', async () => {
          const ymNow = monthEl.value || currentYM(); const { from: f, to: t } = ymRange(ymNow);
          try {
            const res = await fetch(`/api/operator/reports/export.csv?from=${f}&to=${t}`, {
              headers: { Authorization: `Bearer ${api.auth.access}` },
            });
            if (!res.ok) throw new Error('Export failed (' + res.status + ')');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `glass-city-bookings-${ymNow}.csv`;
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
          } catch (err) { genErr.textContent = err.message; genErr.hidden = false; }
        });
      }

      // By-trailer.
      const btEl = root.querySelector('[data-by-trailer]');
      btEl.replaceChildren();
      root.querySelector('[data-bt-empty]').hidden = trailers.length > 0;
      for (const t of trailers) {
        const li = document.createElement('li');
        li.className = 'rep-row';
        li.innerHTML = `<span class="rep-main"></span><span class="rep-amt"></span>`;
        li.querySelector('.rep-main').textContent = `${t.trailer} · ${t.count} booking${t.count === 1 ? '' : 's'} · ${t.pct}%`;
        li.querySelector('.rep-amt').textContent = t.gross_fmt;
        btEl.appendChild(li);
      }

      // Bookings.
      const bkEl = root.querySelector('[data-bookings]');
      bkEl.replaceChildren();
      root.querySelector('[data-bk-count]').textContent = bookings.length ? `(${bookings.length})` : '';
      root.querySelector('[data-bk-empty]').hidden = bookings.length > 0;
      for (const b of bookings) {
        const li = document.createElement('li');
        li.className = 'rep-row rep-booking';
        const main = document.createElement('span'); main.className = 'rep-main';
        main.textContent = `${fmtDay(b.date)} · ${b.customer_name} · ${b.trailer_name}`;
        const sub = document.createElement('span'); sub.className = 'rep-sub muted';
        sub.textContent = `gross ${b.gross_fmt} · fee ${b.stripe_fee_fmt} · net ${b.net_fmt} · comm ${b.commission_fmt} · ${b.status}`;
        const wrap = document.createElement('span'); wrap.className = 'rep-meta';
        wrap.append(main, sub);
        li.appendChild(wrap);
        bkEl.appendChild(li);
      }

      reportEl.hidden = false;
    }

    monthEl.addEventListener('change', load);
    load();
  }

  // ── Audit log (admin + owner) ────────────────────────────────────────────
  const ACTION_LABELS = {
    'auth.login': 'Logged in',
    'booking.create': 'Booking created',
    'booking.paid': 'Booking paid',
    'booking.update': 'Booking status change',
    'booking.return': 'Return processed',
    'settings.update': 'Settings changed',
    'trailer.update': 'Trailer/pricing edit',
    'blackout.create': 'Dates blocked',
    'blackout.delete': 'Blackout removed',
    'account.create': 'Account created',
    'account.update': 'Account updated',
    'account.deactivate': 'Account deactivated',
  };
  function actionLabel(a) { return ACTION_LABELS[a] || a; }
  function detailText(d) {
    if (!d || typeof d !== 'object') return '';
    if (d.status) return `→ ${d.status}`;
    if (d.fields) return d.fields.join(', ');
    if (d.ref) return d.ref;
    if (d.amount_cents != null) return fmtMoney(d.amount_cents) || '';
    return '';
  }

  async function renderAudit() {
    mount('tpl-audit');
    root.querySelector('[data-back]').addEventListener('click', () => renderDashboard());
    const fromEl = root.querySelector('[data-from]');
    const toEl = root.querySelector('[data-to]');
    const opEl = root.querySelector('[data-operator]');
    const actEl = root.querySelector('[data-action]');
    const loadingEl = root.querySelector('[data-loading]');
    const errEl = root.querySelector('[data-error]');
    const listEl = root.querySelector('[data-list]');
    const emptyEl = root.querySelector('[data-empty]');
    const moreBtn = root.querySelector('[data-more]');
    const LIMIT = 50;
    let offset = 0;

    // Populate filters: action types (admin+owner), operators (admin only —
    // ignore if forbidden).
    api.apiFetch('/api/operator/audit/actions').then((d) => {
      for (const a of d.actions || []) {
        const o = document.createElement('option'); o.value = a; o.textContent = actionLabel(a); actEl.appendChild(o);
      }
    }).catch(() => {});
    api.apiFetch('/api/operator/accounts').then((d) => {
      for (const a of d.accounts || []) {
        const o = document.createElement('option'); o.value = a.id; o.textContent = a.name || a.email; opEl.appendChild(o);
      }
    }).catch(() => {}); // owners can't list accounts — that's fine.

    function qs() {
      const p = new URLSearchParams();
      if (fromEl.value) p.set('from', fromEl.value);
      if (toEl.value) p.set('to', toEl.value);
      if (opEl.value) p.set('user_id', opEl.value);
      if (actEl.value) p.set('action', actEl.value);
      p.set('limit', LIMIT); p.set('offset', offset);
      return p.toString();
    }

    async function load(reset) {
      if (reset) { offset = 0; listEl.replaceChildren(); }
      loadingEl.hidden = false; errEl.hidden = true; emptyEl.hidden = true;
      let data;
      try {
        data = await api.apiFetch(`/api/operator/audit?${qs()}`);
      } catch (err) {
        if (handleAuth(err)) return;
        loadingEl.hidden = true;
        errEl.textContent = err.message || 'Could not load the audit log.';
        errEl.hidden = false;
        return;
      }
      loadingEl.hidden = true;
      for (const it of data.items) {
        const li = document.createElement('li');
        li.className = 'audit-row';
        const top = document.createElement('span'); top.className = 'audit-top';
        top.textContent = `${actionLabel(it.action)}${it.entity ? ' · ' + it.entity : ''}`;
        const sub = document.createElement('span'); sub.className = 'audit-sub muted';
        const dt = detailText(it.detail);
        sub.textContent = `${fmtDateTime(it.at)} · ${it.operator}${dt ? ' · ' + dt : ''}`;
        li.append(top, sub);
        listEl.appendChild(li);
      }
      offset += data.items.length;
      emptyEl.hidden = offset > 0;
      moreBtn.hidden = offset >= data.total;
    }

    root.querySelector('[data-apply]').addEventListener('click', () => load(true));
    moreBtn.addEventListener('click', () => load(false));
    load(true);
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  function start() {
    if (!api.auth.isLoggedIn()) {
      renderLogin();
      return;
    }
    // A push notification deep-links to /operator/?booking=<id> — open it
    // directly, then strip the param so a later refresh lands on the dashboard.
    const bookingId = new URLSearchParams(window.location.search).get('booking');
    if (bookingId) {
      history.replaceState({}, '', '/operator/');
      renderBookingDetail(bookingId, renderDashboard);
    } else {
      renderDashboard();
    }
  }

  // Register the service worker (PWA installability). Failure is non-fatal —
  // the app still works, it just isn't installable/offline.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/operator/service-worker.js', { scope: '/operator/' })
        .catch((err) => console.warn('SW registration failed:', err));
    });
  }

  start();
})(window.GC);
