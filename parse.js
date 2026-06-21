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

  // ================================================================
  // PDF import (browser only — uses pdf.js global `pdfjsLib`).
  // Returns the SAME normalized shapes as the .doc parser / the app's
  // settings, so downstream code is identical. Each parser is best-effort
  // and the UI shows parsed values for confirmation before saving.
  // ================================================================
  async function readPdf(arrayBuffer) {
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js not loaded');
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fields = {};
    try { fields = (await pdf.getFieldObjects()) || {}; } catch (e) { fields = {}; }
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const items = tc.items.map((it) => ({
        str: it.str, x: it.transform[4], y: it.transform[5],
      }));
      pages.push({ items, text: tc.items.map((it) => it.str).join(' ') });
    }
    return { pages, fields, allText: pages.map((p) => p.text).join('\n') };
  }
  function fieldVal(fields, name) {
    const f = fields[name];
    if (!f) return undefined;
    // pdf.js returns an array per field name; the first entry is the parent
    // (no value). Scan for the first kid with an actual value.
    const arr = Array.isArray(f) ? f : [f];
    for (const o of arr) if (o && o.value != null && o.value !== '') return o.value;
    return undefined;
  }

  // ---- W-2 (clean named form fields on the FEMA/NFC W-2) -----------
  function parseW2(pdfData) {
    const f = pdfData.fields || {};
    const get = (n) => money(fieldVal(f, n));
    const w2 = {
      kind: 'w2',
      box1Wages: get('GROSS_TAX_INCOME'),
      fedWithheld: get('FED_TAX_WITHHELD'),
      ssWages: get('SOC_SEC_WAGES'),
      medicareWages: get('MEDICARE_WAGES'),
      stateWages: get('STATE_WAGES'),
      stateWithheld: get('STATE_TAX'),
      tspTraditional: 0, hsa: 0, qualifiedOt: 0,
    };
    // Box 12 codes: D = traditional TSP/401k, W = HSA (employer+employee), AA/EE = Roth
    for (let i = 1; i <= 8; i++) {
      const code = (fieldVal(f, `blk12_${i}_literal`) || '').toString().trim().toUpperCase();
      const amt = money(fieldVal(f, `blk12_${i}`));
      if (code === 'D' || code === 'EE') w2.tspTraditional += amt;
      if (code === 'AA') w2.rothTsp = (w2.rothTsp || 0) + amt;
      if (code === 'W') w2.hsa += amt;
    }
    // Box 14: qualified overtime (OBBBA) sometimes reported here on 2025+ W-2s.
    for (let i = 1; i <= 8; i++) {
      const lit = (fieldVal(f, `blk14_${i}_literal`) || '').toString().toUpperCase();
      const amt = money(fieldVal(f, `blk14_${i}`));
      if (/OVERTIME|FLSA|OT\b/.test(lit)) w2.qualifiedOt += amt;
    }
    const yr = (pdfData.allText.match(/Tax Statement\s*(\d{4})|\b(20\d{2})\b/) || [])[0];
    w2.year = yr ? +(yr.match(/20\d{2}/)[0]) : undefined;
    return w2;
  }

  // ---- 1040 (parse the prepared-return summary; prefill household) --
  function parse1040(pdfData) {
    const t = pdfData.allText.replace(/\s+/g, ' ');
    const grab = (re) => { const m = t.match(re); return m ? money(m[1]) : undefined; };
    return {
      kind: '1040',
      grossIncome: grab(/Gross Income[.\s]*\$?\s*([\d,]+)/i),
      agi: grab(/Adjusted Gross Income[.\s]*\$?\s*([\d,]+)/i),
      taxableIncome: grab(/(?:Total )?Taxable Income[.\s]*\$?\s*([\d,]+)/i),
      totalTax: grab(/Total Tax[.\s]*\$?\s*([\d,]+)/i),
      year: (t.match(/YEAR ENDING\s*December 31,\s*(\d{4})/i) || t.match(/(20\d{2})\s*Federal/i) || [])[1] &&
        +((t.match(/YEAR ENDING\s*December 31,\s*(\d{4})/i) || t.match(/(20\d{2})\s*Federal/i))[1]),
    };
  }

  // ---- E&L PDF (USDA AD-334 coordinate form) — positional rows -----
  function parseElPdf(pdfData) {
    const p0 = pdfData.pages[0];
    if (!p0) return null;
    const items = p0.items.filter((it) => it.str && it.str.trim());
    const period = { source: 'el', raw: [], ytd: {}, agency: {}, leave: {} };
    const codeMap = {
      '01': 'regular', '21': 'overtime', '34': 'flsa', '44': 'cashAward',
      '61': 'annualLeave', '62': 'sickLeave', '66': 'otherLeave',
      '75': null, '76': 'oasdi', '77': 'fedTax', '78': 'ilTax', '83': null, '97': 'medicare',
    };
    // Codes sit at x<60; amounts at x≈480-525 (P/P) and 530-575 (YTD). The form
    // offsets a code and its amount by a pixel or two, so match by NEAREST y
    // (a row-bucket would split pairs that straddle a boundary).
    const codeItems = items.filter((it) => /^\d{2}$/.test(it.str.trim()) && it.x < 60);
    const descItems = items.filter((it) => it.x >= 55 && it.x < 320);
    const nearest = (band0, band1, y) => {
      let best = null, bestDy = 4.5;
      for (const it of items) {
        if (it.x < band0 || it.x > band1) continue;
        if (!/^[\d,]+\.\d{2}$/.test(it.str.trim())) continue;
        const dy = Math.abs(it.y - y);
        if (dy < bestDy) { bestDy = dy; best = it; }
      }
      return best ? money(best.str) : 0;
    };
    for (const ci of codeItems) {
      const code = ci.str.trim();
      const desc = descItems.filter((it) => Math.abs(it.y - ci.y) < 4.5).sort((a, b) => a.x - b.x).map((it) => it.str).join(' ').trim();
      const ppAmt = nearest(470, 528, ci.y);
      const ytdAmt = nearest(530, 580, ci.y);
      period.raw.push({ code, desc, amountPP: ppAmt, amountYTD: ytdAmt });
      let keyName = codeMap[code];
      if (code === '75') keyName = /ROTH/i.test(desc) ? 'rothTsp' : /TSP/i.test(desc) ? 'tsp' : 'retirement';
      if (code === '83') keyName = /DENTAL/i.test(desc) ? 'dental' : 'fehb';
      if (keyName) { period[keyName] = (period[keyName] || 0) + ppAmt; period.ytd[keyName] = (period.ytd[keyName] || 0) + ytdAmt; }
    }
    // gross = sum of earnings; net = gross - deductions
    const E = ['regular', 'overtime', 'flsa', 'cashAward', 'annualLeave', 'sickLeave', 'otherLeave'];
    const D = ['retirement', 'tsp', 'rothTsp', 'oasdi', 'fedTax', 'ilTax', 'fehb', 'dental', 'hsa', 'medicare'];
    period.gross = round2(E.reduce((s, k) => s + (period[k] || 0), 0));
    period.totalDeductions = round2(D.reduce((s, k) => s + (period[k] || 0), 0));
    period.net = round2(period.gross - period.totalDeductions);
    // header: dates. AD-334 prints the official pay date plainly; period dates
    // live in positional MO/DA/YR boxes that are unreliable to recover, so we
    // anchor on the pay date and let the user confirm the period number.
    const payM = pdfData.allText.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*Official Pay Date/i);
    if (payM) { period.payDate = toIso(payM[1]); period.year = +toIso(payM[1]).slice(0, 4); }
    const dateM = pdfData.allText.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:to|-)\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (dateM) { period.periodStart = toIso(dateM[1]); period.periodEnd = toIso(dateM[2]); period.year = +period.periodStart.slice(0, 4); }
    const ppM = pdfData.allText.match(/\bP\/?P\b[^0-9]{0,8}(\d{1,2})\b/);
    if (ppM) period.pp = +ppM[1];
    if (period.periodEnd) period.payDate = addDays(period.periodEnd, 12);
    period.id = period.year && period.pp ? `${period.year}-PP${pad(period.pp)}` : undefined;
    period.bonus = (period.cashAward || 0);
    period.lowConfidence = !period.id || !period.gross; // flag for the confirm UI
    return period;
  }
  function pickNum(row, xMin, xMax) {
    const t = row.filter((it) => it.x >= xMin && it.x <= xMax && /^[\d,]+\.\d{2}$/.test(it.str.trim()));
    return t.length ? money(t[t.length - 1].str) : 0;
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  // Dispatch a File by sniffing its content/type.
  async function parseAnyPdf(arrayBuffer, filename) {
    const data = await readPdf(arrayBuffer);
    const t = data.allText;
    // A prepared-return *package* contains W-2 copies too, and a standalone W-2's
    // IRS insert mentions "Form 1040" — so neither generic term discriminates.
    // Use return-SUMMARY markers (HR Block style) for the 1040, and the W-2's
    // named form fields for the W-2.
    const isReturn = /Individual Tax Return|Tax\s*Summary|Refund Amount|Amount You Owe|Total Taxable Income/i.test(t);
    const isW2 = !!data.fields.GROSS_TAX_INCOME && /Wage and Tax Statement/i.test(t);
    if (isW2 && !isReturn) return { type: 'w2', data: parseW2(data) };
    if (isReturn) return { type: '1040', data: parse1040(data) };
    if (/EARNINGS AND DEDUCTIONS|STATEMENT OF EARNINGS AND LEAVE|AD-334/i.test(t))
      return { type: 'el', data: parseElPdf(data) };
    if (data.fields.GROSS_TAX_INCOME) return { type: 'w2', data: parseW2(data) };
    return { type: 'unknown', data: null };
  }

  const api = { parse, parseMany, readPdf, parseW2, parse1040, parseElPdf, parseAnyPdf };
  if (typeof window !== 'undefined') window.ELParse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
