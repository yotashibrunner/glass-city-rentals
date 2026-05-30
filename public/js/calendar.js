'use strict';

/*
 * Availability calendar widget for trailer detail pages. Renders N months from
 * today, fetches busy ranges from /api/trailers/:slug/availability, disables
 * past + busy days, and lets the customer click a start then end date. Calls
 * onSelect({ start, end, days }) when a clean range is chosen, or onSelect(null)
 * while the selection is incomplete. No dependencies.
 */
(function (global) {
  const DAY_MS = 86400000;
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function startOfToday() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function dayCount(a, b) { return Math.round((b - a) / DAY_MS) + 1; }

  async function createCalendar(opts) {
    const root = typeof opts.container === 'string' ? document.querySelector(opts.container) : opts.container;
    const slug = opts.slug;
    const months = opts.months || 2;
    const onSelect = opts.onSelect || function () {};

    let busy = [];          // [{ s, e }] in ms
    let start = null;       // Date
    let end = null;         // Date
    let available = true;

    const statusEl = document.createElement('p');
    statusEl.className = 'cal-status';
    statusEl.textContent = 'Loading availability…';
    const monthsWrap = document.createElement('div');
    monthsWrap.className = 'cal-months';
    const legend = document.createElement('div');
    legend.className = 'cal-legend';
    legend.innerHTML =
      '<span><span class="sw free"></span>Available</span>' +
      '<span><span class="sw sel"></span>Selected</span>' +
      '<span><span class="sw busy"></span>Unavailable</span>';
    root.replaceChildren(statusEl, monthsWrap, legend);

    try {
      const res = await fetch(`/api/trailers/${encodeURIComponent(slug)}/availability`);
      const data = await res.json();
      if (res.ok) {
        busy = (data.busy || []).map((b) => ({ s: new Date(b.start_at).getTime(), e: new Date(b.end_at).getTime() }));
        available = data.status === 'available';
        statusEl.textContent = available
          ? 'Select your pickup and return dates.'
          : 'This trailer is currently unavailable — call (419) 654-3584.';
      } else {
        statusEl.textContent = 'Could not load availability.';
      }
    } catch (err) {
      statusEl.textContent = 'Could not load availability. Check your connection.';
    }

    function isBusy(day) {
      const ds = day.getTime();
      const de = ds + DAY_MS;
      return busy.some((r) => ds < r.e && de > r.s);
    }
    function rangeHasBusy(a, b) {
      for (let t = a.getTime(); t <= b.getTime(); t += DAY_MS) {
        if (isBusy(new Date(t))) return true;
      }
      return false;
    }

    function emit() {
      if (start && end) onSelect({ start: ymd(start), end: ymd(end), days: dayCount(start, end) });
      else onSelect(null);
    }

    function pick(day) {
      if (!available || isBusy(day) || day < startOfToday()) return;
      if (!start || (start && end)) {
        start = day; end = null;
      } else if (day < start) {
        start = day; end = null;
      } else if (rangeHasBusy(start, day)) {
        // Can't span an unavailable day — restart the selection here.
        start = day; end = null;
      } else {
        end = day;
      }
      render();
      emit();
    }

    function render() {
      monthsWrap.replaceChildren();
      const today = startOfToday();
      const base = new Date(today.getFullYear(), today.getMonth(), 1);

      for (let m = 0; m < months; m++) {
        const month = new Date(base.getFullYear(), base.getMonth() + m, 1);
        const block = document.createElement('div');

        const title = document.createElement('h3');
        title.className = 'cal-month-title';
        title.textContent = `${MONTH_NAMES[month.getMonth()]} ${month.getFullYear()}`;
        block.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'cal-grid';
        for (const d of DOW) {
          const h = document.createElement('div');
          h.className = 'cal-dow';
          h.textContent = d;
          grid.appendChild(h);
        }

        const firstDow = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
        const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        for (let i = 0; i < firstDow; i++) {
          const blank = document.createElement('div');
          blank.className = 'cal-day empty';
          grid.appendChild(blank);
        }

        for (let dnum = 1; dnum <= daysInMonth; dnum++) {
          const day = new Date(month.getFullYear(), month.getMonth(), dnum);
          const cell = document.createElement('div');
          cell.className = 'cal-day';
          cell.textContent = String(dnum);

          if (day < today) {
            cell.classList.add('past');
          } else if (isBusy(day) || !available) {
            cell.classList.add('busy');
          } else {
            cell.classList.add('free');
            if (start && day.getTime() === start.getTime()) cell.classList.add('sel-start');
            else if (end && day.getTime() === end.getTime()) cell.classList.add('sel-end');
            else if (start && end && day > start && day < end) cell.classList.add('in-range');
            cell.addEventListener('click', () => pick(day));
          }
          grid.appendChild(cell);
        }
        block.appendChild(grid);
        monthsWrap.appendChild(block);
      }
    }

    render();
    return {
      get value() { return start && end ? { start: ymd(start), end: ymd(end), days: dayCount(start, end) } : null; },
      reset() { start = null; end = null; render(); emit(); },
    };
  }

  global.createCalendar = createCalendar;
})(window);
