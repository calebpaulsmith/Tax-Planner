/*
 * cites.js — citation registry. window.Cites.
 * Every engine calculation references a rule by id; the UI shows the title +
 * link + retrieved date only when the user expands a "how is this computed?"
 * disclosure. Pure data, no DOM/DB — safe to load in JavaScriptCore too.
 */
(function () {
  'use strict';

  const RETRIEVED = '2026-06-21';

  const CITES = {
    obbbaOvertime: {
      title: 'OBBBA "No Tax on Overtime" deduction (2025–2028)',
      url: 'https://www.irs.gov/newsroom/one-big-beautiful-bill-act-tax-deductions-for-working-americans-and-seniors',
      retrieved: RETRIEVED,
      quote:
        'Deduction for the premium half (the 0.5× above the regular rate) of FLSA-required overtime. ' +
        'Capped at $12,500 (single) / $25,000 (MFJ); phases out above $150,000 / $300,000 MAGI. ' +
        'Above-the-line deduction claimed on the return — payroll withholding does not change.',
    },
    flsaOvertime: {
      title: 'FLSA overtime — Title 5 / OPM (non-exempt rate = 1.5× regular)',
      url: 'https://www.opm.gov/policy-data-oversight/pay-leave/pay-administration/fact-sheets/overtime-pay-title-5/',
      retrieved: RETRIEVED,
      quote:
        'The overtime rate for FLSA non-exempt employees is 1.5 times the hourly regular rate. ' +
        'The "premium" portion is the 0.5× amount above the regular rate.',
    },
    pub15t: {
      title: 'IRS Pub 15-T — Annual Percentage Method (federal withholding)',
      url: 'https://www.irs.gov/publications/p15t',
      retrieved: RETRIEVED,
      quote:
        'Per-paycheck federal withholding = annualize taxable wages, apply the W-4 adjustments and ' +
        'the percentage-method bracket table, then divide by the number of pay periods.',
    },
    brackets2025: {
      title: '2025 federal income tax brackets & standard deduction (OBBBA)',
      url: 'https://www.irs.gov/newsroom/one-big-beautiful-bill-act-tax-deductions-for-working-americans-and-seniors',
      retrieved: RETRIEVED,
      quote: '2025 MFJ standard deduction $31,500 (OBBBA-raised). Seven rates 10%–37%.',
    },
    brackets2026: {
      title: '2026 federal income tax brackets & standard deduction (IRS Rev. Proc.)',
      url: 'https://taxfoundation.org/data/all/federal/2026-tax-brackets/',
      retrieved: RETRIEVED,
      quote:
        '2026 MFJ standard deduction $32,200. MFJ brackets: 10% to $24,800; 12% to $100,800; ' +
        '22% to $211,400; 24% to $403,550; 32% to $512,450; 35% to $768,700; 37% above.',
    },
    fica: {
      title: 'Social Security & Medicare (FICA) rates and wage base',
      url: 'https://www.ssa.gov/oact/cola/cbb.html',
      retrieved: RETRIEVED,
      quote:
        'Social Security (OASDI) 6.2% on wages up to the annual wage base (2025 $176,100; 2026 $183,600). ' +
        'Medicare 1.45% on all wages, plus 0.9% additional above $250,000 MFJ / $200,000 single.',
    },
    fersFrae: {
      title: 'FERS-FRAE employee retirement contribution (4.4%)',
      url: 'https://www.opm.gov/retirement-center/fers-information/',
      retrieved: RETRIEVED,
      quote:
        'FERS Further Revised Annuity Employees contribute 4.4% of basic pay. The basic FERS annuity ' +
        'multiplier is 1.0% per year of service (1.1% if retiring at 62+ with 20+ years).',
    },
    tspLimits: {
      title: 'TSP — contribution limits & Roth vs. traditional',
      url: 'https://www.tsp.gov/bulletins/25-3/',
      retrieved: RETRIEVED,
      quote:
        '2026 elective-deferral limit $24,500 (catch-up $8,000; $11,250 ages 60–63). Traditional ' +
        'contributions reduce current taxable income (not FICA); Roth do not, but grow tax-free. ' +
        'Agency matching contributions always go to the traditional balance.',
    },
    hsaLimits: {
      title: 'HSA contribution limits & triple tax advantage',
      url: 'https://www.irs.gov/pub/irs-drop/n-26-05.pdf',
      retrieved: RETRIEVED,
      quote:
        '2026 HSA limits: $4,400 self-only / $8,750 family (+$1,000 catch-up at 55+). Payroll (cafeteria-plan) ' +
        'HSA contributions are pre-tax for federal income tax, state income tax, AND FICA; direct ' +
        'contributions are deductible for income tax only.',
    },
    ilTax: {
      title: 'Illinois individual income tax (flat 4.95%) & exemption',
      url: 'https://tax.illinois.gov/questionsandanswers/answer.851.html',
      retrieved: RETRIEVED,
      quote:
        'Illinois flat rate 4.95%. Personal exemption allowance $2,850 (2025) / $2,925 (2026) per ' +
        'exemption; Illinois does not tax most retirement income.',
    },
    ltcg: {
      title: 'Long-term capital gains & qualified dividends rates',
      url: 'https://www.irs.gov/taxtopics/tc409',
      retrieved: RETRIEVED,
      quote:
        'Long-term capital gains and qualified dividends are taxed at 0%, 15%, or 20% depending on ' +
        'taxable income, stacked on top of ordinary income.',
    },
    paydateYear: {
      title: 'Wages are taxed in the year the paycheck is dated (W-2 / constructive receipt)',
      url: 'https://www.irs.gov/government-entities/federal-state-local-governments/constructive-receipt-of-income-under-cash-basis',
      retrieved: RETRIEVED,
      quote:
        'Under constructive receipt, wages count for the tax year of the pay date — so a pay period ' +
        'ending in December but paid in January is W-2 income for the new year.',
    },
  };

  function get(id) {
    return CITES[id] || null;
  }

  const api = { CITES, get };
  if (typeof window !== 'undefined') window.Cites = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
