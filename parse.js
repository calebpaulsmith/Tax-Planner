/*
 * parse.js — Earnings & Leave (E&L) statement importer. window.ELParse.
 * Pure: text in, normalized period object out. No DOM/DB dependency
 * (regex table walk, so it runs in the browser and in a node harness).
 *
 * Federal E&L statements are HTML tables saved as .doc. The earnings/
 * deductions grid is a stable 6-column table:
 *   [code, description, hoursP/P, hoursYTD, amountP/P, amountYTD]
 * Codes repeat (75 = Retirement/TSP/Roth, 83 = FEHB/Dental), so rows are
 * mapped by DESCRIPTION keyword, with the code kept for reference.
 */
(function () {
  'use strict';

  function stripTags(s) {
    return s.replace(/<[^>]+>/g, '');
  }
  function unescapeHtml(s) {
    return s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }
  function clean(s) {
    return unescapeHtml(stripTags(s)).replace(/\s+/g, ' ').trim();
  }
  function rowCells(tr) {
    const out = [];
    const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m;
    while ((m = re.exec(tr))) out.push(clean(m[1]));
    return out;
  }
  function money(s) {
    if (s == null) return 0;
    const n = parseFloat(String(s).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : 0;
  }
  // Field map: description keyword -> normalized key + bucket.
  const EARNING_KEYS = [
    ['REGULAR', 'regular'],
    ['OVERTIME', 'overtime'],
    ['FLSA', 'flsa'],
    ['CASH AWARD', 'cashAward'],
    ['ANNUAL LEAVE', 'annualLeave'],
    ['SICK LEAVE', 'sickLeave'],
    ['OTHER LEAVE', 'otherLeave'],
    ['TIME OFF AWARD', 'timeOffAward'],
  ];
  const DEDUCTION_KEYS = [
    ['ROTH TSP', 'rothTsp'],
    ['TSP', 'tsp'],
    ['RETIREMENT', 'retirement'],
    ['SOCIAL SECURITY', 'oasdi'],
    ['OASDI', 'oasdi'],
    ['MEDICARE', 'medicare'],
    ['FEDERAL TAX', 'fedTax'],
    ['ST TAX', 'ilTax'],
    ['STATE TAX', 'ilTax'],
    ['FEHB', 'fehb'],
    ['DENTAL', 'dental'],
    ['HSA', 'hsa'],
    ['FSA', 'hsa'],
  ];
  function matchKey(desc, table) {
    const up = desc.toUpperCase();
    for (const [needle, key] of table) if (up.includes(needle)) return key;
    return null;
  }

  function parse(text) {
    const trs = text.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const rows = trs.map(rowCells).filter((c) => c.length && c.some(Boolean));

    const period = {
      source: 'el',
      raw: [],
      ytd: {},
      agency: {},
      leave: {},
    };
    let pastGross = false; // earnings above the GROSS PAY marker, deductions below

    // Name (appears before the first <form>)
    const nameM = text.match(/^\s*([A-Za-z][A-Za-z ,.'-]+?)\s*<form/);
    if (nameM) period.name = nameM[1].trim();

    for (let i = 0; i < rows.length; i++) {
      const c = rows[i];

      // Header: the row after "Year, Pay Period" labels.
      if (c[0] && /^Year, Pay Period/i.test(c[0]) && rows[i + 1]) {
        const h = rows[i + 1];
        const hm = (h[0] || '').match(
          /(\d{4}),\s*(\d{1,2})\s*\((\d{1,2}\/\d{1,2}\/\d{4})\s*to\s*(\d{1,2}\/\d{1,2}\/\d{4})\)/i
        );
        if (hm) {
          period.year = +hm[1];
          period.pp = +hm[2];
          period.periodStart = toIso(hm[3]);
          period.periodEnd = toIso(hm[4]);
        }
        period.agencyName = h[1] || '';
        const pgs = (h[2] || '').split(/\s+/);
        period.payPlan = pgs[0] || '';
        period.grade = pgs[1] || '';
        period.step = pgs[2] || '';
        period.salary = money(h[3]);
        period.scd = toIso(h[4]);
        continue;
      }

      const code = c[0];
      const desc = c[1] || '';

      // Earnings / deductions grid rows: first cell is a numeric code or **.
      if (/^\d{2}$/.test(code) || code === '**') {
        const rec = {
          code,
          desc,
          hoursPP: money(c[2]),
          hoursYTD: money(c[3]),
          amountPP: money(c[4]),
          amountYTD: money(c[5]),
        };
        period.raw.push(rec);

        if (/GROSS PAY/i.test(desc)) {
          period.gross = rec.amountPP;
          period.hours = rec.hoursPP;
          period.ytd.gross = rec.amountYTD;
          pastGross = true;
          continue;
        }
        if (/TOTAL DEDUCTIONS/i.test(desc)) {
          period.totalDeductions = rec.amountPP;
          period.ytd.totalDeductions = rec.amountYTD;
          continue;
        }
        if (/NET PAY/i.test(desc)) {
          period.net = rec.amountPP;
          period.ytd.net = rec.amountYTD;
          continue;
        }
        if (code === '**') continue;

        const key = !pastGross
          ? matchKey(desc, EARNING_KEYS)
          : matchKey(desc, DEDUCTION_KEYS);
        if (key) {
          period[key] = (period[key] || 0) + rec.amountPP;
          period.ytd[key] = (period.ytd[key] || 0) + rec.amountYTD;
        }
        // Capture state-tax exemptions count (e.g. "EXEMPTS 002")
        if (key === 'ilTax') {
          const exM = desc.match(/EXEMPTS\s*0*(\d+)/i);
          if (exM) period.ilAllowances = +exM[1];
        }
        continue;
      }

      // Leave balances: Annual / Sick rows -> accrued/used/balance.
      if (/^(Annual|Sick)$/i.test(code) && c.length >= 4) {
        period.leave[code.toLowerCase()] = {
          accrued: money(c[1]),
          used: money(c[2]),
          balance: money(c[3]),
        };
        continue;
      }

      // Agency contributions block: 2-cell [label, amount] rows.
      if (c.length === 2 && c[1] !== '' && /^[\d.,$]+$/.test(c[1].replace(/[$,\s]/g, ''))) {
        const label = c[0];
        if (/OASDI|Social Security/i.test(label)) period.agency.oasdi = money(c[1]);
        else if (/Medicare/i.test(label)) period.agency.medicare = money(c[1]);
        else if (/^Retirement/i.test(label)) period.agency.retirement = money(c[1]);
        else if (/^FEHB/i.test(label)) period.agency.fehb = money(c[1]);
        else if (/TSP Basic/i.test(label)) period.agency.tspBasic = money(c[1]);
        else if (/TSP Matching/i.test(label)) period.agency.tspMatching = money(c[1]);
        continue;
      }
    }

    // Derived: paydate = period end + 12 days (matches the agency convention).
    if (period.periodEnd) period.payDate = addDays(period.periodEnd, 12);
    period.id = period.year && period.pp ? `${period.year}-PP${pad(period.pp)}` : undefined;
    // OT/bonus this period (above the regular base) for the straight-vs-OT view.
    period.bonus = (period.cashAward || 0) + (period.timeOffAward || 0);
    return period;
  }

  // Parse many statements; key by id, sorted chronologically.
  function parseMany(texts) {
    return texts.map(parse).filter((p) => p.id).sort(byChrono);
  }
  function byChrono(a, b) {
    return (a.periodStart || '').localeCompare(b.periodStart || '');
  }

  function toIso(mdy) {
    if (!mdy) return undefined;
    const m = String(mdy).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return undefined;
    return `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  }
  function addDays(iso, days) {
    const [y, mo, d] = iso.split('-').map(Number);
    const dt = new Date(y, mo - 1, d + days);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }
  function pad(n) {
    return String(n).padStart(2, '0');
  }

  const api = { parse, parseMany };
  if (typeof window !== 'undefined') window.ELParse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
