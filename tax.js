/*
 * tax.js — pure paycheck & tax engine. Exposes window.TaxCalc.
 * No DOM, no DB. Every formula here is ported from the user's
 * `Pay Calculations.xlsx` (the spec). Tax tables are kept as editable,
 * year-keyed data so the engine survives annual IRS/IL updates.
 *
 * Two kinds of federal numbers, deliberately separate (as in the sheet):
 *   - WITHHOLDING brackets  -> reproduce the per-paycheck amount your
 *     agency actually withholds (IRS Pub 15-T annual percentage method,
 *     with W-4 deduction/credit adjustments). Used for the straight-vs-OT
 *     split and "modeled" per-period tax.
 *   - INCOME-TAX brackets   -> the real 1040 brackets on taxable income
 *     (after the standard deduction). Used for the annual owe/refund
 *     estimate and the "distance to the next bracket jump" insight.
 */
(function () {
  'use strict';

  const PP_PER_YEAR = 26;          // biweekly pay periods
  const OASDI_RATE = 0.062;
  const MEDICARE_RATE = 0.0145;
  const ADDL_MEDICARE_RATE = 0.009;
  const FICA_RATE = OASDI_RATE + MEDICARE_RATE; // 0.0765
  const FERS_RATE = 0.044;         // FERS-FRAE employee share
  const TSP_BASE_PCT = 0.05;       // 5% gets full agency match

  // ------------------------------------------------------------------
  // TAX TABLES (editable). brackets: ascending [{ min, rate, base }]
  //   tax = base + (income - min) * rate, for the row where
  //   min <= income < nextMin.
  // ------------------------------------------------------------------
  const TAX_TABLES = {
    2023: {
      standardDeduction: { MFJ: 27700, Single: 13850, HoH: 20800 },
      ssWageBase: 160200,
      addlMedicareThreshold: { MFJ: 250000, Single: 200000, HoH: 200000 },
      ilRate: 0.0495,
      ilExemptionPerAllowance: 2425,
      // 1040 income-tax brackets on taxable income
      incomeTax: {
        MFJ: [
          { min: 0, rate: 0.10, base: 0 },
          { min: 22000, rate: 0.12, base: 2200 },
          { min: 89450, rate: 0.22, base: 10294 },
          { min: 190750, rate: 0.24, base: 32580 },
          { min: 364200, rate: 0.32, base: 74208 },
          { min: 462500, rate: 0.35, base: 105664 },
          { min: 693750, rate: 0.37, base: 186601.5 },
        ],
        Single: [
          { min: 0, rate: 0.10, base: 0 },
          { min: 11000, rate: 0.12, base: 1100 },
          { min: 44725, rate: 0.22, base: 5147 },
          { min: 95375, rate: 0.24, base: 16290 },
          { min: 182100, rate: 0.32, base: 37104 },
          { min: 231250, rate: 0.35, base: 52832 },
          { min: 578125, rate: 0.37, base: 174238.25 },
        ],
      },
    },
    2024: {
      standardDeduction: { MFJ: 29200, Single: 14600, HoH: 21900 },
      ssWageBase: 168600,
      addlMedicareThreshold: { MFJ: 250000, Single: 200000, HoH: 200000 },
      ilRate: 0.0495,
      ilExemptionPerAllowance: 2775,
      incomeTax: {
        MFJ: [
          { min: 0, rate: 0.10, base: 0 },
          { min: 23200, rate: 0.12, base: 2320 },
          { min: 94300, rate: 0.22, base: 10852 },
          { min: 201050, rate: 0.24, base: 34337 },
          { min: 383900, rate: 0.32, base: 78221 },
          { min: 487450, rate: 0.35, base: 111357 },
          { min: 731200, rate: 0.37, base: 196669.5 },
        ],
        Single: [
          { min: 0, rate: 0.10, base: 0 },
          { min: 11600, rate: 0.12, base: 1160 },
          { min: 47150, rate: 0.22, base: 5426 },
          { min: 100525, rate: 0.24, base: 17168.5 },
          { min: 191950, rate: 0.32, base: 39110.5 },
          { min: 243725, rate: 0.35, base: 55678.5 },
          { min: 609350, rate: 0.37, base: 183647.25 },
        ],
      },
    },
    2025: {
      // OBBBA-raised standard deduction (matches the sheet's 31500 MFJ)
      standardDeduction: { MFJ: 31500, Single: 15750, HoH: 23625 },
      ssWageBase: 176100,
      addlMedicareThreshold: { MFJ: 250000, Single: 200000, HoH: 200000 },
      ilRate: 0.0495,
      ilExemptionPerAllowance: 2850,
      incomeTax: {
        MFJ: [
          { min: 0, rate: 0.10, base: 0 },
          { min: 23850, rate: 0.12, base: 2385 },
          { min: 96950, rate: 0.22, base: 11157 },
          { min: 206700, rate: 0.24, base: 35302 },
          { min: 394600, rate: 0.32, base: 80398 },
          { min: 501050, rate: 0.35, base: 114462 },
          { min: 751600, rate: 0.37, base: 202154.5 },
        ],
        Single: [
          { min: 0, rate: 0.10, base: 0 },
          { min: 11925, rate: 0.12, base: 1192.5 },
          { min: 48475, rate: 0.22, base: 5578.5 },
          { min: 103350, rate: 0.24, base: 17651 },
          { min: 197300, rate: 0.32, base: 40199 },
          { min: 250525, rate: 0.35, base: 57231 },
          { min: 626350, rate: 0.37, base: 188769.75 },
        ],
      },
    },
    2026: {
      // Estimates — editable in Settings as official figures land.
      standardDeduction: { MFJ: 32600, Single: 16300, HoH: 24450 },
      ssWageBase: 183600,
      addlMedicareThreshold: { MFJ: 250000, Single: 200000, HoH: 200000 },
      ilRate: 0.0495,
      ilExemptionPerAllowance: 2950,
      incomeTax: {
        MFJ: [
          { min: 0, rate: 0.10, base: 0 },
          { min: 24700, rate: 0.12, base: 2470 },
          { min: 100400, rate: 0.22, base: 11554 },
          { min: 214050, rate: 0.24, base: 36557 },
          { min: 408650, rate: 0.32, base: 83261 },
          { min: 518900, rate: 0.35, base: 118541 },
          { min: 778450, rate: 0.37, base: 209383.5 },
        ],
        Single: [
          { min: 0, rate: 0.10, base: 0 },
          { min: 12350, rate: 0.12, base: 1235 },
          { min: 50200, rate: 0.22, base: 5777 },
          { min: 107050, rate: 0.24, base: 18284 },
          { min: 204350, rate: 0.32, base: 41636 },
          { min: 259450, rate: 0.35, base: 59268 },
          { min: 648850, rate: 0.37, base: 195573 },
        ],
      },
    },
  };

  // IRS Pub 15-T (2025) Annual Percentage Method — Standard withholding
  // (Form W-4 Step 2 NOT checked). Used to reproduce the per-paycheck
  // federal withholding the agency computes. brackets: [{ min, rate, base }].
  const WITHHOLDING_TABLES = {
    2025: {
      MFJ: [
        { min: 0, rate: 0, base: 0 },
        { min: 17100, rate: 0.10, base: 0 },
        { min: 40950, rate: 0.12, base: 2385 },
        { min: 114050, rate: 0.22, base: 11157 },
        { min: 223800, rate: 0.24, base: 35302 },
        { min: 411700, rate: 0.32, base: 80398 },
        { min: 518150, rate: 0.35, base: 114462 },
        { min: 768700, rate: 0.37, base: 202154.5 },
      ],
      Single: [
        { min: 0, rate: 0, base: 0 },
        { min: 6400, rate: 0.10, base: 0 },
        { min: 18325, rate: 0.12, base: 1192.5 },
        { min: 54875, rate: 0.22, base: 5578.5 },
        { min: 109750, rate: 0.24, base: 17651 },
        { min: 203700, rate: 0.32, base: 40199 },
        { min: 256925, rate: 0.35, base: 57231 },
        { min: 632750, rate: 0.37, base: 188769.75 },
      ],
      HoH: [
        { min: 0, rate: 0, base: 0 },
        { min: 13900, rate: 0.10, base: 0 },
        { min: 30900, rate: 0.12, base: 1700 },
        { min: 78750, rate: 0.22, base: 7442 },
        { min: 117250, rate: 0.24, base: 15912 },
        { min: 211200, rate: 0.32, base: 38460 },
        { min: 264400, rate: 0.35, base: 55484 },
        { min: 640250, rate: 0.37, base: 187031.5 },
      ],
    },
  };
  // Reuse the 2025 withholding shape for adjacent years until updated.
  WITHHOLDING_TABLES[2023] = WITHHOLDING_TABLES[2025];
  WITHHOLDING_TABLES[2024] = WITHHOLDING_TABLES[2025];
  WITHHOLDING_TABLES[2026] = WITHHOLDING_TABLES[2025];

  // Default W-4 adjustments (the user's, from the sheet's row-32 formula).
  // deductions: subtracted from annualized wages before the table lookup
  //   (Form W-4 line 4b / 2019-or-earlier allowances rolled in).
  // credits: subtracted from the annual tentative tax (W-4 step 3).
  const DEFAULT_W4 = { deductions: 12900, credits: 2500 };

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function tableFor(year) {
    return TAX_TABLES[year] || TAX_TABLES[2025];
  }
  function withholdingFor(year, status) {
    const y = WITHHOLDING_TABLES[year] || WITHHOLDING_TABLES[2025];
    return y[status] || y.MFJ;
  }
  function incomeBrackets(year, status) {
    const t = tableFor(year);
    return t.incomeTax[status] || t.incomeTax.MFJ;
  }

  // Progressive tax from an ascending [{min,rate,base}] table.
  function bracketTax(income, brackets) {
    if (income <= 0) return 0;
    let row = brackets[0];
    for (let i = 0; i < brackets.length; i++) {
      if (income >= brackets[i].min) row = brackets[i];
      else break;
    }
    return row.base + (income - row.min) * row.rate;
  }

  // Marginal rate + distance to the next bracket jump, on TAXABLE income
  // (after standard deduction). This answers "what am I paying above the
  // jump, and how far until the next one?"
  function bracketDistance(taxableIncome, year, status) {
    const brackets = incomeBrackets(year, status);
    let idx = 0;
    for (let i = 0; i < brackets.length; i++) {
      if (taxableIncome >= brackets[i].min) idx = i;
      else break;
    }
    const cur = brackets[idx];
    const next = brackets[idx + 1] || null;
    const tax = bracketTax(taxableIncome, brackets);
    return {
      taxableIncome,
      marginalRate: cur.rate,
      effectiveRate: taxableIncome > 0 ? tax / taxableIncome : 0,
      tax,
      bracketFloor: cur.min,
      nextRate: next ? next.rate : null,
      nextThreshold: next ? next.min : null,
      amountIntoBracket: taxableIncome - cur.min,
      amountToNextJump: next ? Math.max(0, next.min - taxableIncome) : null,
      brackets,
    };
  }

  // Modeled federal withholding for ONE pay period, given that period's
  // taxable wages (gross - pretax health - traditional TSP). Reproduces
  // the agency's Pub 15-T calc.
  function federalWithholding(periodTaxableWages, year, status, w4) {
    w4 = w4 || DEFAULT_W4;
    const brackets = withholdingFor(year, status);
    const annual = periodTaxableWages * PP_PER_YEAR;
    const adjusted = Math.max(0, annual - (w4.deductions || 0));
    const annualTax = Math.max(0, bracketTax(adjusted, brackets) - (w4.credits || 0));
    return annualTax / PP_PER_YEAR;
  }

  // Illinois flat tax (modeled). taxableBase is annual; allowances reduce it.
  function ilTaxAnnual(annualBase, allowances, year) {
    const t = tableFor(year);
    const exemptions = (allowances || 0) * t.ilExemptionPerAllowance;
    return Math.max(0, annualBase - exemptions) * t.ilRate;
  }

  // FICA for one period. ytdSsWagesBefore caps OASDI at the wage base.
  function fica(ssWagesThisPeriod, ytdSsWagesBefore, year, status) {
    const t = tableFor(year);
    const base = t.ssWageBase;
    const remaining = Math.max(0, base - (ytdSsWagesBefore || 0));
    const oasdiWages = Math.min(ssWagesThisPeriod, remaining);
    const oasdi = oasdiWages * OASDI_RATE;
    let medicare = ssWagesThisPeriod * MEDICARE_RATE;
    const thr = (t.addlMedicareThreshold || {})[status] || Infinity;
    const ytdAfter = (ytdSsWagesBefore || 0) + ssWagesThisPeriod;
    if (ytdAfter > thr) {
      const over = Math.min(ssWagesThisPeriod, ytdAfter - Math.max(thr, ytdSsWagesBefore || 0));
      medicare += Math.max(0, over) * ADDL_MEDICARE_RATE;
    }
    return { oasdi, medicare, total: oasdi + medicare };
  }

  // ------------------------------------------------------------------
  // Per-paycheck breakdown (rows 2-21). Uses ACTUAL withheld figures
  // from the imported statement when present; falls back to modeled.
  //   period: { gross, fehb, dental, hsa, retirement, tsp, rothTsp,
  //             oasdi, medicare, fedTax, ilTax, hours }
  // ------------------------------------------------------------------
  function paycheckBreakdown(period, settings) {
    settings = settings || {};
    const year = period.year || 2025;
    const status = settings.filingStatus || 'MFJ';
    const gross = num(period.gross);
    const fehb = num(period.fehb);
    const dental = num(period.dental);
    const hsa = num(period.hsa);
    const retirement = num(period.retirement);
    const tsp = period.tsp != null ? num(period.tsp) : (retirement / FERS_RATE) * TSP_BASE_PCT;
    const rothTsp = num(period.rothTsp);

    const ssMedWages = gross - fehb - dental - hsa;
    const modeledFica = fica(ssMedWages, period.ytdSsWages, year, status);
    const oasdi = period.oasdi != null ? num(period.oasdi) : modeledFica.oasdi;
    const medicare = period.medicare != null ? num(period.medicare) : modeledFica.medicare;

    // AGI for withholding = wages minus pretax (traditional TSP). Roth is NOT pretax.
    const agi = ssMedWages - tsp;
    const fedTax = period.fedTax != null ? num(period.fedTax)
      : federalWithholding(agi - fehb - dental, year, status, settings.w4);
    const ilTax = period.ilTax != null ? num(period.ilTax)
      : ilTaxAnnual(agi * PP_PER_YEAR, settings.ilAllowances, year) / PP_PER_YEAR;

    const totalHealthRetire = fehb + dental + hsa + retirement + tsp + rothTsp;
    const totalTax = fedTax + ilTax + oasdi + medicare;
    const totalDeductions = totalHealthRetire + totalTax;
    const net = gross - totalDeductions;

    return {
      year, gross, fehb, dental, hsa, ssMedWages, oasdi, medicare,
      retirement, tsp, rothTsp, agi, fedTax, ilTax,
      fedActualRate: agi > 0 ? fedTax / agi : 0,
      ilActualRate: agi > 0 ? ilTax / agi : 0,
      totalHealthRetire, totalTax, totalDeductions, net,
      // category rollup for "where my money goes"
      categories: {
        net,
        federalTax: fedTax,
        stateTax: ilTax,
        socialSecurity: oasdi,
        medicare,
        fersRetirement: retirement,
        tsp: tsp + rothTsp,
        health: fehb + dental,
        hsa,
      },
    };
  }

  // ------------------------------------------------------------------
  // Straight-time vs OT/bonus retained analysis (rows 22-48).
  // The headline insight: OT/bonus dollars sit on top of your income and
  // are taxed at your marginal rate, so each one keeps far less.
  // ------------------------------------------------------------------
  function straightVsOt(period, settings) {
    settings = settings || {};
    const year = period.year || 2025;
    const status = settings.filingStatus || 'MFJ';
    const b = paycheckBreakdown(period, settings);
    const fehb = b.fehb, dental = b.dental;
    const retirement = b.retirement;
    const base = retirement > 0 ? retirement / FERS_RATE : b.gross; // gross straight time
    const grossOT = Math.max(0, b.gross - base);

    const strAfterHD = base - (fehb + dental);
    const ficaStr = strAfterHD * FICA_RATE;
    const ficaOT = grossOT * FICA_RATE;
    // take-home of straight pay before income tax
    const strAfterAll = strAfterHD - ficaStr - (base * FERS_RATE + base * TSP_BASE_PCT);
    // income-taxable straight wage = base - health - traditional TSP
    const taxableStr = base - fehb - dental - base * TSP_BASE_PCT;

    const ilRate = b.ilActualRate; // use the period's realized IL rate
    const ilStr = taxableStr * ilRate;
    const ilOT = grossOT * ilRate;

    const fedStr = federalWithholding(taxableStr, year, status, settings.w4);
    const fedOT = Math.max(0, b.fedTax - fedStr);

    const netStr = strAfterAll - ilStr - fedStr;
    const netOT = grossOT - ficaOT - ilOT - fedOT;
    const includeHsa = settings.includeHsaInNet ? b.hsa : 0;
    const hours = num(period.hours) || 0;

    return {
      grossStraight: base,
      grossOT,
      netStraight: netStr,
      netOT,
      netTotal: netStr + netOT,
      pctStraightRetained: base > 0 ? (netStr + includeHsa) / base : 0,
      pctOtRetained: grossOT > 0 ? netOT / grossOT : 0,
      pctTotalRetained: b.gross > 0 ? (netStr + netOT + includeHsa) / b.gross : 0,
      grossHourlyRate: hours > 0 ? b.gross / hours : 0,
      netHourlyRate: hours > 0 ? (netStr + netOT + includeHsa) / hours : 0,
      netHourlyStraightRate: hours > 0 ? (netStr + includeHsa) / hours : 0,
      netHourlyOtRate: hours > 0 ? netOT / hours : 0,
      fedOT, ilOT, ficaOT,
    };
  }

  // HSA contribution combined-tax savings (row 49):
  //   HSA * (fedRate + ilRate + OASDI + Medicare)
  function hsaSavings(amount, fedRate, ilRate) {
    return num(amount) * (num(fedRate) + num(ilRate) + OASDI_RATE + MEDICARE_RATE);
  }

  // ------------------------------------------------------------------
  // Annual owe/refund estimate (rows 51-69 + Sheet1). Annualizes YTD,
  // applies the standard deduction and 1040 brackets, compares to YTD
  // withholding scaled to full year.
  //   ytd: { taxableWages, fedWithheld, ilWithheld, periodsElapsed,
  //          ilAllowances }
  // ------------------------------------------------------------------
  function annualEstimate(ytd, settings) {
    settings = settings || {};
    const year = ytd.year || 2025;
    const status = settings.filingStatus || 'MFJ';
    const t = tableFor(year);
    const periods = ytd.periodsElapsed || PP_PER_YEAR;
    const factor = PP_PER_YEAR / periods;

    const projWages = num(ytd.taxableWages) * factor;          // annual taxable wages (after pretax)
    const stdDed = (t.standardDeduction[status] || t.standardDeduction.MFJ);
    const taxableIncome = Math.max(0, projWages + num(ytd.otherIncome) - stdDed);

    const fed = bracketDistance(taxableIncome, year, status);
    const fedTaxLiability = fed.tax - num(ytd.taxCredits);
    const ilTaxLiability = ilTaxAnnual(projWages, ytd.ilAllowances, year);

    const fedWithheldYear = num(ytd.fedWithheld) * factor;
    const ilWithheldYear = num(ytd.ilWithheld) * factor;

    return {
      year,
      projectedTaxableWages: projWages,
      standardDeduction: stdDed,
      taxableIncome,
      marginalRate: fed.marginalRate,
      effectiveRate: fed.effectiveRate,
      amountToNextJump: fed.amountToNextJump,
      nextRate: fed.nextRate,
      federalTax: Math.max(0, fedTaxLiability),
      stateTax: ilTaxLiability,
      federalWithheld: fedWithheldYear,
      stateWithheld: ilWithheldYear,
      federalBalance: fedWithheldYear - Math.max(0, fedTaxLiability), // + = refund, - = owe
      stateBalance: ilWithheldYear - ilTaxLiability,
      get totalBalance() { return this.federalBalance + this.stateBalance; },
    };
  }

  // ------------------------------------------------------------------
  // Retirement projections
  // ------------------------------------------------------------------
  // TSP future value: current balance compounded + each year's
  // contribution compounded to the retirement year.
  //   a: { currentBalance, annualIncome, contributionPct, expectedRor,
  //        incomeGrowth, currentAge, retirementAge }
  function tspFutureValue(a) {
    const years = Math.max(0, (a.retirementAge || 62) - (a.currentAge || 35));
    const ror = a.expectedRor != null ? a.expectedRor : 0.08;
    const growth = a.incomeGrowth != null ? a.incomeGrowth : 0.035;
    const pct = a.contributionPct != null ? a.contributionPct : 0.10;
    const series = [];
    let balance = num(a.currentBalance) * Math.pow(1 + ror, years);
    let income = num(a.annualIncome);
    let running = balance;
    for (let y = 0; y < years; y++) {
      const contribution = income * pct;
      const fv = contribution * Math.pow(1 + ror, years - y);
      running += fv;
      series.push({ year: y, age: (a.currentAge || 35) + y, contribution, balance: running });
      income *= 1 + growth;
    }
    return { years, valueAtRetirement: running, fvCurrentBalance: balance, series };
  }

  // FERS basic annuity. Multiplier is 1.0% (or 1.1% if retiring at 62+
  // with 20+ years). Optional survivor benefit reduces it to ~90%.
  //   a: { high3, yearsOfService, retirementAge, survivorBenefit }
  function fersAnnuity(a) {
    const high3 = num(a.high3);
    const yos = num(a.yearsOfService);
    const enhanced = (a.retirementAge || 0) >= 62 && yos >= 20;
    const mult = enhanced ? 0.011 : 0.01;
    let annual = high3 * mult * yos;
    if (a.survivorBenefit) annual *= 0.9; // 10% reduction for full survivor
    return {
      multiplier: mult,
      yearlyAnnuity: annual,
      monthlyAnnuity: annual / 12,
      replacementRate: high3 > 0 ? annual / high3 : 0,
    };
  }

  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  const api = {
    PP_PER_YEAR, OASDI_RATE, MEDICARE_RATE, FICA_RATE, FERS_RATE, TSP_BASE_PCT,
    TAX_TABLES, WITHHOLDING_TABLES, DEFAULT_W4,
    bracketTax, bracketDistance, federalWithholding, ilTaxAnnual, fica,
    paycheckBreakdown, straightVsOt, hsaSavings, annualEstimate,
    tspFutureValue, fersAnnuity,
    tableFor, incomeBrackets,
  };
  if (typeof window !== 'undefined') window.TaxCalc = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
