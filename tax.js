/*
 * tax.js — pure paycheck & tax engine. Exposes window.TaxCalc (and module
 * exports for the node harness / future JavaScriptCore use on iOS).
 *
 * NO DOM, NO DB, NO globals beyond the export. Every formula is ported from
 * the user's `Pay Calculations.xlsx` and the cited rules in cites.js. Tax
 * tables are editable, year-keyed data so the engine survives annual updates.
 *
 * Explainability: the headline functions attach a `steps[]` trace
 *   { label, plain, formula, value, inputs:[{name,value,source}], cite }
 * so the UI can show "how is this computed?" with the user's real numbers and
 * a citation key (resolved via window.Cites). `cite` is a string id only — the
 * engine stays free of any presentation concern.
 *
 * Two federal calcs, kept separate (as in the sheet):
 *   - WITHHOLDING brackets  -> reproduce the per-paycheck amount withheld
 *     (IRS Pub 15-T annual percentage method + W-4 adjustments).
 *   - INCOME-TAX brackets   -> real 1040 brackets on taxable income, for the
 *     annual owe/refund prediction and bracket-distance insight.
 */
(function () {
  'use strict';

  const PP_PER_YEAR = 26;
  const OASDI_RATE = 0.062;
  const MEDICARE_RATE = 0.0145;
  const ADDL_MEDICARE_RATE = 0.009;
  const FICA_RATE = OASDI_RATE + MEDICARE_RATE; // 0.0765
  const FERS_RATE = 0.044;
  const TSP_BASE_PCT = 0.05;
  // FLSA time-and-a-half = regular(1.0) + premium(0.5); the OBBBA-deductible
  // "premium half" is 0.5/1.5 = 1/3 of the time-and-a-half overtime pay.
  const OT_PREMIUM_FRACTION = 1 / 3;

  // ------------------------------------------------------------------
  // TAX TABLES (editable). brackets ascending [{ min, rate, base }]:
  //   tax = base + (income - min) * rate for the row where min <= income < next.
  // ltcg: preferential-rate thresholds on TAXABLE income {r15, r20}.
  // ------------------------------------------------------------------
  const TAX_TABLES = {
    2023: {
      standardDeduction: { MFJ: 27700, Single: 13850, HoH: 20800 },
      ssWageBase: 160200,
      addlMedicareThreshold: { MFJ: 250000, Single: 200000, HoH: 200000 },
      ilRate: 0.0495, ilExemptionPerAllowance: 2425,
      incomeTax: {
        MFJ: [
          { min: 0, rate: 0.10, base: 0 }, { min: 22000, rate: 0.12, base: 2200 },
          { min: 89450, rate: 0.22, base: 10294 }, { min: 190750, rate: 0.24, base: 32580 },
          { min: 364200, rate: 0.32, base: 74208 }, { min: 462500, rate: 0.35, base: 105664 },
          { min: 693750, rate: 0.37, base: 186601.5 },
        ],
        Single: [
          { min: 0, rate: 0.10, base: 0 }, { min: 11000, rate: 0.12, base: 1100 },
          { min: 44725, rate: 0.22, base: 5147 }, { min: 95375, rate: 0.24, base: 16290 },
          { min: 182100, rate: 0.32, base: 37104 }, { min: 231250, rate: 0.35, base: 52832 },
          { min: 578125, rate: 0.37, base: 174238.25 },
        ],
      },
      ltcg: { MFJ: { r15: 89250, r20: 553850 }, Single: { r15: 44625, r20: 492300 } },
    },
    2024: {
      standardDeduction: { MFJ: 29200, Single: 14600, HoH: 21900 },
      ssWageBase: 168600,
      addlMedicareThreshold: { MFJ: 250000, Single: 200000, HoH: 200000 },
      ilRate: 0.0495, ilExemptionPerAllowance: 2775,
      incomeTax: {
        MFJ: [
          { min: 0, rate: 0.10, base: 0 }, { min: 23200, rate: 0.12, base: 2320 },
          { min: 94300, rate: 0.22, base: 10852 }, { min: 201050, rate: 0.24, base: 34337 },
          { min: 383900, rate: 0.32, base: 78221 }, { min: 487450, rate: 0.35, base: 111357 },
          { min: 731200, rate: 0.37, base: 196669.5 },
        ],
        Single: [
          { min: 0, rate: 0.10, base: 0 }, { min: 11600, rate: 0.12, base: 1160 },
          { min: 47150, rate: 0.22, base: 5426 }, { min: 100525, rate: 0.24, base: 17168.5 },
          { min: 191950, rate: 0.32, base: 39110.5 }, { min: 243725, rate: 0.35, base: 55678.5 },
          { min: 609350, rate: 0.37, base: 183647.25 },
        ],
      },
      ltcg: { MFJ: { r15: 94050, r20: 583750 }, Single: { r15: 47025, r20: 518900 } },
    },
    2025: {
      standardDeduction: { MFJ: 31500, Single: 15750, HoH: 23625 }, // OBBBA-raised
      ssWageBase: 176100,
      addlMedicareThreshold: { MFJ: 250000, Single: 200000, HoH: 200000 },
      ilRate: 0.0495, ilExemptionPerAllowance: 2850,
      incomeTax: {
        MFJ: [
          { min: 0, rate: 0.10, base: 0 }, { min: 23850, rate: 0.12, base: 2385 },
          { min: 96950, rate: 0.22, base: 11157 }, { min: 206700, rate: 0.24, base: 35302 },
          { min: 394600, rate: 0.32, base: 80398 }, { min: 501050, rate: 0.35, base: 114462 },
          { min: 751600, rate: 0.37, base: 202154.5 },
        ],
        Single: [
          { min: 0, rate: 0.10, base: 0 }, { min: 11925, rate: 0.12, base: 1192.5 },
          { min: 48475, rate: 0.22, base: 5578.5 }, { min: 103350, rate: 0.24, base: 17651 },
          { min: 197300, rate: 0.32, base: 40199 }, { min: 250525, rate: 0.35, base: 57231 },
          { min: 626350, rate: 0.37, base: 188769.75 },
        ],
      },
      ltcg: { MFJ: { r15: 96700, r20: 600050 }, Single: { r15: 48350, r20: 533400 } },
    },
    2026: { // IRS Rev. Proc. 2025 figures (released)
      standardDeduction: { MFJ: 32200, Single: 16100, HoH: 24150 },
      ssWageBase: 183600,
      addlMedicareThreshold: { MFJ: 250000, Single: 200000, HoH: 200000 },
      ilRate: 0.0495, ilExemptionPerAllowance: 2925,
      incomeTax: {
        MFJ: [
          { min: 0, rate: 0.10, base: 0 }, { min: 24800, rate: 0.12, base: 2480 },
          { min: 100800, rate: 0.22, base: 11600 }, { min: 211400, rate: 0.24, base: 35932 },
          { min: 403550, rate: 0.32, base: 82048 }, { min: 512450, rate: 0.35, base: 116896 },
          { min: 768700, rate: 0.37, base: 206583.5 },
        ],
        Single: [
          { min: 0, rate: 0.10, base: 0 }, { min: 12400, rate: 0.12, base: 1240 },
          { min: 50400, rate: 0.22, base: 5800 }, { min: 105700, rate: 0.24, base: 17966 },
          { min: 201775, rate: 0.32, base: 41024 }, { min: 256225, rate: 0.35, base: 58448 },
          { min: 640600, rate: 0.37, base: 192979.25 },
        ],
      },
      ltcg: { MFJ: { r15: 98900, r20: 613700 }, Single: { r15: 49450, r20: 545500 } },
    },
  };

  // IRS Pub 15-T (2025) Annual Percentage Method — Standard withholding.
  const WITHHOLDING_TABLES = {
    2025: {
      MFJ: [
        { min: 0, rate: 0, base: 0 }, { min: 17100, rate: 0.10, base: 0 },
        { min: 40950, rate: 0.12, base: 2385 }, { min: 114050, rate: 0.22, base: 11157 },
        { min: 223800, rate: 0.24, base: 35302 }, { min: 411700, rate: 0.32, base: 80398 },
        { min: 518150, rate: 0.35, base: 114462 }, { min: 768700, rate: 0.37, base: 202154.5 },
      ],
      Single: [
        { min: 0, rate: 0, base: 0 }, { min: 6400, rate: 0.10, base: 0 },
        { min: 18325, rate: 0.12, base: 1192.5 }, { min: 54875, rate: 0.22, base: 5578.5 },
        { min: 109750, rate: 0.24, base: 17651 }, { min: 203700, rate: 0.32, base: 40199 },
        { min: 256925, rate: 0.35, base: 57231 }, { min: 632750, rate: 0.37, base: 188769.75 },
      ],
      HoH: [
        { min: 0, rate: 0, base: 0 }, { min: 13900, rate: 0.10, base: 0 },
        { min: 30900, rate: 0.12, base: 1700 }, { min: 78750, rate: 0.22, base: 7442 },
        { min: 117250, rate: 0.24, base: 15912 }, { min: 211200, rate: 0.32, base: 38460 },
        { min: 264400, rate: 0.35, base: 55484 }, { min: 640250, rate: 0.37, base: 187031.5 },
      ],
    },
  };
  WITHHOLDING_TABLES[2023] = WITHHOLDING_TABLES[2025];
  WITHHOLDING_TABLES[2024] = WITHHOLDING_TABLES[2025];
  WITHHOLDING_TABLES[2026] = WITHHOLDING_TABLES[2025];

  const DEFAULT_W4 = { deductions: 0, credits: 0 };

  // OBBBA "No Tax on Overtime" (2025–2028).
  const OT_DEDUCTION = {
    cap: { MFJ: 25000, Single: 12500, HoH: 12500 },
    phaseoutStart: { MFJ: 300000, Single: 150000, HoH: 150000 },
    phaseoutPer1000: 100, // $100 reduction per $1,000 of MAGI over the start
    years: [2025, 2026, 2027, 2028],
  };

  // ------------------------------------------------------------------ helpers
  function tableFor(year) { return TAX_TABLES[year] || TAX_TABLES[2025]; }
  function withholdingFor(year, status) {
    const y = WITHHOLDING_TABLES[year] || WITHHOLDING_TABLES[2025];
    return y[status] || y.MFJ;
  }
  function incomeBrackets(year, status) {
    const t = tableFor(year);
    return t.incomeTax[status] || t.incomeTax.MFJ;
  }
  function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : 0; }
  function step(label, plain, formula, value, inputs, cite) {
    return { label, plain, formula, value, inputs: inputs || [], cite: cite || null };
  }

  function bracketTax(income, brackets) {
    if (income <= 0) return 0;
    let row = brackets[0];
    for (let i = 0; i < brackets.length; i++) {
      if (income >= brackets[i].min) row = brackets[i];
      else break;
    }
    return row.base + (income - row.min) * row.rate;
  }

  function bracketDistance(taxableIncome, year, status) {
    const brackets = incomeBrackets(year, status);
    let idx = 0;
    for (let i = 0; i < brackets.length; i++) {
      if (taxableIncome >= brackets[i].min) idx = i; else break;
    }
    const cur = brackets[idx];
    const next = brackets[idx + 1] || null;
    const tax = bracketTax(taxableIncome, brackets);
    return {
      taxableIncome, marginalRate: cur.rate,
      effectiveRate: taxableIncome > 0 ? tax / taxableIncome : 0,
      tax, bracketFloor: cur.min,
      nextRate: next ? next.rate : null, nextThreshold: next ? next.min : null,
      amountIntoBracket: taxableIncome - cur.min,
      amountToNextJump: next ? Math.max(0, next.min - taxableIncome) : null,
      brackets,
    };
  }

  // Long-term capital-gains tax, stacked on top of ordinary taxable income.
  function ltcgTax(ordinaryTaxable, gains, year, status) {
    if (gains <= 0) return 0;
    const t = tableFor(year);
    const b = (t.ltcg && (t.ltcg[status] || t.ltcg.MFJ)) || { r15: 0, r20: Infinity };
    let remaining = gains, tax = 0, floor = ordinaryTaxable;
    const at0 = Math.max(0, Math.min(remaining, b.r15 - floor));
    remaining -= at0; floor += at0;
    const at15 = Math.max(0, Math.min(remaining, b.r20 - floor));
    tax += at15 * 0.15; remaining -= at15;
    tax += Math.max(0, remaining) * 0.20;
    return tax;
  }

  function federalWithholding(periodTaxableWages, year, status, w4) {
    w4 = w4 || DEFAULT_W4;
    const brackets = withholdingFor(year, status);
    const annual = periodTaxableWages * PP_PER_YEAR;
    const adjusted = Math.max(0, annual - (w4.deductions || 0));
    const annualTax = Math.max(0, bracketTax(adjusted, brackets) - (w4.credits || 0));
    return annualTax / PP_PER_YEAR;
  }

  function ilTaxAnnual(annualBase, allowances, year) {
    const t = tableFor(year);
    const exemptions = (allowances || 0) * t.ilExemptionPerAllowance;
    return Math.max(0, annualBase - exemptions) * t.ilRate;
  }

  function fica(ssWagesThisPeriod, ytdSsWagesBefore, year, status) {
    const t = tableFor(year);
    const remaining = Math.max(0, t.ssWageBase - (ytdSsWagesBefore || 0));
    const oasdi = Math.min(ssWagesThisPeriod, remaining) * OASDI_RATE;
    let medicare = ssWagesThisPeriod * MEDICARE_RATE;
    const thr = (t.addlMedicareThreshold || {})[status] || Infinity;
    const ytdAfter = (ytdSsWagesBefore || 0) + ssWagesThisPeriod;
    if (ytdAfter > thr) {
      const over = Math.min(ssWagesThisPeriod, ytdAfter - Math.max(thr, ytdSsWagesBefore || 0));
      medicare += Math.max(0, over) * ADDL_MEDICARE_RATE;
    }
    return { oasdi, medicare, total: oasdi + medicare };
  }

  // ------------------------------------------------------- overtime (OBBBA)
  // Premium half of FLSA-required overtime for ONE period. Prefer a W-2 /
  // statement-reported figure when present (period.qualifiedOt); else estimate
  // it as 1/3 of the time-and-a-half OT pay (overtime + flsa codes).
  function qualifiedOvertime(period) {
    if (period.qualifiedOt != null) return num(period.qualifiedOt);
    const otPay = num(period.overtime) + num(period.flsa);
    return otPay * OT_PREMIUM_FRACTION;
  }

  // OBBBA deduction on annual qualified OT given MAGI. Returns value + steps.
  function overtimeDeduction(annualQualifiedOt, magi, status, year) {
    const eligibleYear = OT_DEDUCTION.years.includes(year);
    const cap = OT_DEDUCTION.cap[status] || OT_DEDUCTION.cap.Single;
    const start = OT_DEDUCTION.phaseoutStart[status] || OT_DEDUCTION.phaseoutStart.Single;
    const capped = Math.min(num(annualQualifiedOt), cap);
    const over = Math.max(0, num(magi) - start);
    const reduction = Math.ceil(over / 1000) * OT_DEDUCTION.phaseoutPer1000;
    const value = eligibleYear ? Math.max(0, capped - reduction) : 0;
    const steps = [
      step('Qualified overtime (premium half)',
        'Only the 0.5× premium portion of FLSA-required overtime counts — not the straight-time part.',
        `min(qualified OT, cap) = min(${money(annualQualifiedOt)}, ${money(cap)}) = ${money(capped)}`,
        capped,
        [{ name: 'annual qualified OT', value: annualQualifiedOt, source: 'E&L premium/FLSA codes (or W-2 box)' },
         { name: `${status} cap`, value: cap, source: 'OBBBA' }],
        'obbbaOvertime'),
    ];
    if (over > 0) steps.push(step('MAGI phase-out',
      `Reduced by $100 for every $1,000 of income over ${money(start)}.`,
      `${money(capped)} − ⌈${money(over)}/1000⌉×$100 = ${money(value)}`,
      value,
      [{ name: 'MAGI', value: magi, source: 'household income' }],
      'obbbaOvertime'));
    if (!eligibleYear) steps.push(step('Not an eligible year',
      'The deduction applies only to tax years 2025–2028.', `${year} → $0`, 0, [], 'obbbaOvertime'));
    return { value, capped, reduction, eligibleYear, steps };
  }

  // ------------------------------------------------------- paycheck breakdown
  function paycheckBreakdown(period, settings) {
    settings = settings || {};
    const year = period.year || 2025;
    const status = settings.filingStatus || 'MFJ';
    const gross = num(period.gross);
    const fehb = num(period.fehb), dental = num(period.dental), hsa = num(period.hsa);
    const retirement = num(period.retirement);
    const tsp = period.tsp != null ? num(period.tsp) : (retirement / FERS_RATE) * TSP_BASE_PCT;
    const rothTsp = num(period.rothTsp);

    const ssMedWages = gross - fehb - dental - hsa;
    const modeledFica = fica(ssMedWages, period.ytdSsWages, year, status);
    const oasdi = period.oasdi != null ? num(period.oasdi) : modeledFica.oasdi;
    const medicare = period.medicare != null ? num(period.medicare) : modeledFica.medicare;

    const agi = ssMedWages - tsp; // traditional TSP is pretax; Roth is not
    const fedTax = period.fedTax != null ? num(period.fedTax)
      : federalWithholding(agi - fehb - dental, year, status, settings.w4);
    const ilTax = period.ilTax != null ? num(period.ilTax)
      : ilTaxAnnual(agi * PP_PER_YEAR, settings.ilAllowances, year) / PP_PER_YEAR;

    const totalHealthRetire = fehb + dental + hsa + retirement + tsp + rothTsp;
    const totalTax = fedTax + ilTax + oasdi + medicare;
    const totalDeductions = totalHealthRetire + totalTax;
    const net = gross - totalDeductions;

    const steps = [
      step('Social Security / Medicare wages',
        'Gross pay minus pre-tax health and HSA. This is what FICA is charged on.',
        `${money(gross)} − ${money(fehb)} − ${money(dental)} − ${money(hsa)} = ${money(ssMedWages)}`,
        ssMedWages,
        [{ name: 'gross', value: gross, source: 'E&L gross pay' },
         { name: 'FEHB+dental', value: fehb + dental, source: 'E&L codes 83' },
         { name: 'HSA', value: hsa, source: 'E&L HSA code' }], 'hsaLimits'),
      step('Social Security (OASDI) 6.2%', 'Charged on FICA wages up to the annual wage base.',
        `${money(ssMedWages)} × 6.2% = ${money(oasdi)}`, oasdi,
        [{ name: 'FICA wages', value: ssMedWages, source: 'above' }], 'fica'),
      step('Medicare 1.45%', 'Charged on all FICA wages (no cap).',
        `${money(ssMedWages)} × 1.45% = ${money(medicare)}`, medicare,
        [{ name: 'FICA wages', value: ssMedWages, source: 'above' }], 'fica'),
      step('FERS retirement 4.4%', 'FERS-FRAE employee contribution on basic pay.',
        `basic pay × 4.4% = ${money(retirement)}`, retirement,
        [{ name: 'FERS amount', value: retirement, source: 'E&L code 75 RETIREMENT' }], 'fersFrae'),
      step('TSP (traditional + Roth)', 'Your own retirement savings; traditional is pre-tax for income tax.',
        `${money(tsp)} + ${money(rothTsp)} = ${money(tsp + rothTsp)}`, tsp + rothTsp,
        [{ name: 'TSP', value: tsp, source: 'E&L code 75 TSP-FERS' },
         { name: 'Roth TSP', value: rothTsp, source: 'E&L code 75 ROTH TSP' }], 'tspLimits'),
      step('Federal income tax withheld', 'Per-paycheck withholding (Pub 15-T) — actual from the statement when imported.',
        `withheld = ${money(fedTax)}`, fedTax,
        [{ name: 'taxable wages', value: agi - fehb - dental, source: 'gross − pretax' }], 'pub15t'),
      step('Illinois tax withheld', 'Illinois flat 4.95% on wages after exemptions.',
        `withheld = ${money(ilTax)}`, ilTax,
        [{ name: 'IL rate', value: 0.0495, source: 'IL DOR' }], 'ilTax'),
      step('Net pay', 'Gross minus every deduction above.',
        `${money(gross)} − ${money(totalDeductions)} = ${money(net)}`, net,
        [{ name: 'total deductions', value: totalDeductions, source: 'sum above' }], null),
    ];

    return {
      year, gross, fehb, dental, hsa, ssMedWages, oasdi, medicare,
      retirement, tsp, rothTsp, agi, fedTax, ilTax,
      fedActualRate: agi > 0 ? fedTax / agi : 0,
      ilActualRate: agi > 0 ? ilTax / agi : 0,
      totalHealthRetire, totalTax, totalDeductions, net,
      qualifiedOt: qualifiedOvertime(period),
      categories: {
        net, federalTax: fedTax, stateTax: ilTax, socialSecurity: oasdi, medicare,
        fersRetirement: retirement, tsp: tsp + rothTsp, health: fehb + dental, hsa,
      },
      steps,
    };
  }

  // ---------------------------------------------- straight-time vs OT/bonus
  function straightVsOt(period, settings) {
    settings = settings || {};
    const year = period.year || 2025;
    const status = settings.filingStatus || 'MFJ';
    const b = paycheckBreakdown(period, settings);
    const fehb = b.fehb, dental = b.dental, retirement = b.retirement;
    const base = retirement > 0 ? retirement / FERS_RATE : b.gross;
    const grossOT = Math.max(0, b.gross - base);

    const strAfterHD = base - (fehb + dental);
    const ficaStr = strAfterHD * FICA_RATE;
    const ficaOT = grossOT * FICA_RATE;
    const strAfterAll = strAfterHD - ficaStr - (base * FERS_RATE + base * TSP_BASE_PCT);
    const taxableStr = base - fehb - dental - base * TSP_BASE_PCT;

    const ilRate = b.ilActualRate;
    const ilStr = taxableStr * ilRate;
    const ilOT = grossOT * ilRate;
    const fedStr = federalWithholding(taxableStr, year, status, settings.w4);
    const fedOT = Math.max(0, b.fedTax - fedStr);

    const netStr = strAfterAll - ilStr - fedStr;
    const netOT = grossOT - ficaOT - ilOT - fedOT;
    const includeHsa = settings.includeHsaInNet ? b.hsa : 0;
    const hours = num(period.hours) || 0;

    return {
      grossStraight: base, grossOT, netStraight: netStr, netOT, netTotal: netStr + netOT,
      pctStraightRetained: base > 0 ? (netStr + includeHsa) / base : 0,
      pctOtRetained: grossOT > 0 ? netOT / grossOT : 0,
      pctTotalRetained: b.gross > 0 ? (netStr + netOT + includeHsa) / b.gross : 0,
      grossHourlyRate: hours > 0 ? b.gross / hours : 0,
      netHourlyRate: hours > 0 ? (netStr + netOT + includeHsa) / hours : 0,
      netHourlyStraightRate: hours > 0 ? (netStr + includeHsa) / hours : 0,
      netHourlyOtRate: hours > 0 ? netOT / hours : 0,
      qualifiedOt: b.qualifiedOt, fedOT, ilOT, ficaOT,
    };
  }

  function hsaSavings(amount, fedRate, ilRate) {
    return num(amount) * (num(fedRate) + num(ilRate) + OASDI_RATE + MEDICARE_RATE);
  }

  // ------------------------------------------------------- annual estimate
  // ytd: per-paycheck rollup (taxableWages, fedWithheld, ilWithheld, oasdi,
  //   medicare, periodsElapsed, qualifiedOt). hh (optional household):
  //   spouseWages, secondJobWages, secondJobWithheld, interest, dividends,
  //   capGains, otherAdjustments, itemizedDeductions, ilAllowances.
  function annualEstimate(ytd, settings) {
    settings = settings || {};
    const year = ytd.year || 2025;
    const status = settings.filingStatus || 'MFJ';
    const t = tableFor(year);
    const hh = settings.household || {};
    const periods = ytd.periodsElapsed || PP_PER_YEAR;
    const factor = PP_PER_YEAR / periods;

    const projWages = num(ytd.taxableWages) * factor;
    const projOt = num(ytd.qualifiedOt) * factor;
    const ordinaryOther = num(hh.spouseWages) + num(hh.secondJobWages) + num(hh.interest) + num(hh.dividends);
    const capGains = num(hh.capGains);
    const adjustments = num(hh.otherAdjustments);

    const magi = projWages + ordinaryOther + capGains - adjustments;
    const otDed = overtimeDeduction(projOt, magi, status, year);
    const stdDed = t.standardDeduction[status] || t.standardDeduction.MFJ;
    const deduction = Math.max(stdDed, num(hh.itemizedDeductions));

    const totalTaxable = Math.max(0, magi - deduction - otDed.value);
    const ltGains = Math.min(capGains, totalTaxable);
    const ordinaryTaxable = Math.max(0, totalTaxable - ltGains);

    const fed = bracketDistance(ordinaryTaxable, year, status);
    const capGainsTax = ltcgTax(ordinaryTaxable, ltGains, year, status);
    const fedTaxLiability = Math.max(0, fed.tax + capGainsTax - num(hh.taxCredits));

    const ilBase = projWages + ordinaryOther + capGains; // IL taxes most income
    const ilTaxLiability = ilTaxAnnual(ilBase, hh.ilAllowances != null ? hh.ilAllowances : settings.ilAllowances, year);

    const fedWithheldYear = num(ytd.fedWithheld) * factor + num(hh.secondJobWithheld) + num(hh.spouseWithheld);
    const ilWithheldYear = num(ytd.ilWithheld) * factor + num(hh.secondJobIlWithheld);

    const steps = [
      step('Annualize this year', `Scale ${periods} paychecks to a full year (×${factor.toFixed(2)}).`,
        `${money(ytd.taxableWages)} × ${factor.toFixed(2)} = ${money(projWages)}`, projWages,
        [{ name: 'YTD taxable wages', value: ytd.taxableWages, source: `${periods} checks` }], 'paydateYear'),
      step('Add other household income', 'Spouse + 2nd job + investment income you entered (optional).',
        `+ ${money(ordinaryOther)} ordinary, + ${money(capGains)} gains`, ordinaryOther + capGains,
        [{ name: 'spouse+2nd job', value: num(hh.spouseWages) + num(hh.secondJobWages), source: 'your fields' },
         { name: 'interest+dividends', value: num(hh.interest) + num(hh.dividends), source: 'your fields' }], null),
      ...otDed.steps,
      step('Subtract deductions', 'Larger of the standard deduction or your itemized total, plus the overtime deduction.',
        `${money(magi)} − ${money(deduction)} − ${money(otDed.value)} = ${money(totalTaxable)}`, totalTaxable,
        [{ name: 'standard deduction', value: stdDed, source: year >= 2026 ? 'brackets2026' : 'brackets2025' }],
        year >= 2026 ? 'brackets2026' : 'brackets2025'),
      step('Federal income tax', 'Ordinary brackets on ordinary income; preferential rates on long-term gains.',
        `${money(fed.tax)} + ${money(capGainsTax)} gains − ${money(hh.taxCredits)} credits = ${money(fedTaxLiability)}`,
        fedTaxLiability, [{ name: 'ordinary taxable', value: ordinaryTaxable, source: 'above' }],
        year >= 2026 ? 'brackets2026' : 'brackets2025'),
      step('Illinois tax', 'Flat 4.95% on income after exemptions.',
        `${money(ilBase)} × 4.95% (after exemptions) = ${money(ilTaxLiability)}`, ilTaxLiability,
        [{ name: 'IL base', value: ilBase, source: 'income' }], 'ilTax'),
      step('Refund or balance due', 'Projected withholding minus projected tax.',
        `(${money(fedWithheldYear + ilWithheldYear)} withheld) − (${money(fedTaxLiability + ilTaxLiability)} tax)`,
        (fedWithheldYear - fedTaxLiability) + (ilWithheldYear - ilTaxLiability),
        [{ name: 'withheld (proj.)', value: fedWithheldYear + ilWithheldYear, source: 'paychecks × factor' }], null),
    ];

    return {
      year, projectedTaxableWages: projWages, magi,
      qualifiedOvertime: projOt, overtimeDeduction: otDed.value, overtimeDeductionSteps: otDed.steps,
      standardDeduction: stdDed, deductionUsed: deduction, itemized: num(hh.itemizedDeductions),
      taxableIncome: totalTaxable, ordinaryTaxable, capGains: ltGains, capGainsTax,
      marginalRate: fed.marginalRate, effectiveRate: totalTaxable > 0 ? fedTaxLiability / totalTaxable : 0,
      amountToNextJump: fed.amountToNextJump, nextRate: fed.nextRate,
      federalTax: fedTaxLiability, stateTax: ilTaxLiability,
      federalWithheld: fedWithheldYear, stateWithheld: ilWithheldYear,
      federalBalance: fedWithheldYear - fedTaxLiability,
      stateBalance: ilWithheldYear - ilTaxLiability,
      get totalBalance() { return this.federalBalance + this.stateBalance; },
      steps,
    };
  }

  // --------------------------------------------------- decision: Roth vs Trad
  // amount = annual contribution being considered. Compares equal gross
  // contribution: traditional gives a tax break now + taxed-later balance;
  // Roth gives no break now + tax-free balance.
  function rothVsTraditional(amount, opts) {
    opts = opts || {};
    const marginalNow = num(opts.marginalNow);
    const stateRate = opts.stateRate != null ? num(opts.stateRate) : 0.0495;
    const retireRate = opts.retireRate != null ? num(opts.retireRate) : marginalNow;
    const years = num(opts.years) || 25;
    const ror = opts.ror != null ? num(opts.ror) : 0.07;
    const growth = Math.pow(1 + ror, years);
    const fv = num(amount) * growth;

    const taxSavedNow = num(amount) * (marginalNow + stateRate);
    const traditionalAfterTax = fv * (1 - retireRate);     // taxed at withdrawal
    const rothAfterTax = fv;                                 // tax-free
    const sideInvest = taxSavedNow * growth * (1 - 0.15);    // invest the upfront saving (taxed ~LTCG)
    const traditionalTotal = traditionalAfterTax + sideInvest;
    const steps = [
      step('Tax saved now (traditional)', 'Traditional lowers this year\'s federal + state taxable income.',
        `${money(amount)} × (${(marginalNow * 100).toFixed(0)}% + ${(stateRate * 100).toFixed(2)}%) = ${money(taxSavedNow)}`,
        taxSavedNow, [{ name: 'marginal rate now', value: marginalNow, source: 'your bracket' }], 'tspLimits'),
      step('Roth value at retirement', 'No break now, but withdrawals are tax-free.',
        `${money(amount)} × (1+${ror})^${years} = ${money(rothAfterTax)}`, rothAfterTax,
        [{ name: 'years', value: years, source: 'assumption' }, { name: 'return', value: ror, source: 'assumption' }], 'tspLimits'),
      step('Traditional value at retirement', 'Grows the same, but taxed on withdrawal at your future rate.',
        `${money(fv)} × (1 − ${(retireRate * 100).toFixed(0)}%) = ${money(traditionalAfterTax)}`, traditionalAfterTax,
        [{ name: 'assumed retirement rate', value: retireRate, source: 'assumption' }], 'tspLimits'),
    ];
    return {
      taxSavedNow, rothAfterTax, traditionalAfterTax, traditionalTotal,
      rothWinsBy: rothAfterTax - traditionalTotal,
      recommendation: retireRate < marginalNow ? 'traditional' : (retireRate > marginalNow ? 'roth' : 'tossup'),
      steps,
    };
  }

  function tspFutureValue(a) {
    const years = Math.max(0, (a.retirementAge || 62) - (a.currentAge || 35));
    const ror = a.expectedRor != null ? a.expectedRor : 0.08;
    const growth = a.incomeGrowth != null ? a.incomeGrowth : 0.035;
    const pct = a.contributionPct != null ? a.contributionPct : 0.10;
    const series = [];
    let balance = num(a.currentBalance) * Math.pow(1 + ror, years);
    let income = num(a.annualIncome), running = balance;
    for (let y = 0; y < years; y++) {
      const contribution = income * pct;
      running += contribution * Math.pow(1 + ror, years - y);
      series.push({ year: y, age: (a.currentAge || 35) + y, contribution, balance: running });
      income *= 1 + growth;
    }
    return { years, valueAtRetirement: running, fvCurrentBalance: balance, series };
  }

  function fersAnnuity(a) {
    const high3 = num(a.high3), yos = num(a.yearsOfService);
    const enhanced = (a.retirementAge || 0) >= 62 && yos >= 20;
    const mult = enhanced ? 0.011 : 0.01;
    let annual = high3 * mult * yos;
    if (a.survivorBenefit) annual *= 0.9;
    return { multiplier: mult, yearlyAnnuity: annual, monthlyAnnuity: annual / 12,
      replacementRate: high3 > 0 ? annual / high3 : 0 };
  }

  function money(n) {
    n = num(n);
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  const api = {
    PP_PER_YEAR, OASDI_RATE, MEDICARE_RATE, FICA_RATE, FERS_RATE, TSP_BASE_PCT, OT_PREMIUM_FRACTION,
    TAX_TABLES, WITHHOLDING_TABLES, DEFAULT_W4, OT_DEDUCTION,
    bracketTax, bracketDistance, ltcgTax, federalWithholding, ilTaxAnnual, fica,
    qualifiedOvertime, overtimeDeduction,
    paycheckBreakdown, straightVsOt, hsaSavings, annualEstimate,
    rothVsTraditional, tspFutureValue, fersAnnuity,
    tableFor, incomeBrackets,
  };
  if (typeof window !== 'undefined') window.TaxCalc = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
