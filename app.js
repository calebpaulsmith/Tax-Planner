/*
 * app.js — UI layer, view router, rendering. Wrapped in an IIFE to avoid
 * the classic <script> top-level `const` collision (see the timecard app).
 */
(function () {
  'use strict';
  const T = window.TaxCalc;

  const state = {
    settings: null,
    periods: [],
    currentId: null,
    taxYear: null,
  };

  // ---- tiny DOM/format helpers -------------------------------------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const usd = (n, dp = 0) =>
    (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const pct = (n, dp = 1) => (n * 100).toFixed(dp) + '%';
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  // category color tokens
  const CAT = [
    ['net', 'Take-home', 'var(--net)'],
    ['federalTax', 'Federal tax', 'var(--fed)'],
    ['stateTax', 'IL tax', 'var(--state)'],
    ['socialSecurity', 'Social Security', 'var(--ss)'],
    ['medicare', 'Medicare', 'var(--medicare)'],
    ['fersRetirement', 'FERS pension', 'var(--fers)'],
    ['tsp', 'TSP', 'var(--tsp)'],
    ['health', 'Health/dental', 'var(--health)'],
    ['hsa', 'HSA/pre-tax', 'var(--hsa)'],
  ];

  // ==================================================================
  // BOOT
  // ==================================================================
  async function boot() {
    state.settings = await DB.getSettings();
    state.periods = await DB.allPeriods();
    if (state.periods.length) {
      state.currentId = state.periods[state.periods.length - 1].id;
      state.taxYear = DB.payYear(currentPeriod());
    }
    wireNav();
    wireSettings();
    wireScenarios();
    wireModal();
    renderAll();
  }

  function currentPeriod() {
    return state.periods.find((p) => p.id === state.currentId) || null;
  }

  // ==================================================================
  // YTD rollup — bucketed by PAYDATE year (the W-2 / tax year), summing
  // per-period actuals. (The E&L "YTD" column is the agency leave-year,
  // which differs because PP25/26 checks land in January.)
  // ==================================================================
  function ytdRollup(taxYear) {
    const inYear = state.periods.filter((p) => DB.payYear(p) === taxYear);
    const acc = {
      gross: 0, fedWithheld: 0, ilWithheld: 0, oasdi: 0, medicare: 0,
      fers: 0, tsp: 0, rothTsp: 0, health: 0, hsa: 0, net: 0, taxableWages: 0,
      agency: { oasdi: 0, medicare: 0, retirement: 0, fehb: 0, tspBasic: 0, tspMatching: 0 },
      count: inYear.length, maxPp: 0,
    };
    for (const p of inYear) {
      const b = T.paycheckBreakdown(p, state.settings);
      acc.gross += b.gross;
      acc.fedWithheld += b.fedTax;
      acc.ilWithheld += b.ilTax;
      acc.oasdi += b.oasdi;
      acc.medicare += b.medicare;
      acc.fers += b.retirement;
      acc.tsp += b.tsp;
      acc.rothTsp += b.rothTsp;
      acc.health += b.fehb + b.dental;
      acc.hsa += b.hsa;
      acc.net += b.net;
      acc.taxableWages += b.agi - b.fehb - b.dental; // gross - health - hsa - traditional tsp
      acc.maxPp = Math.max(acc.maxPp, p.pp || 0);
      for (const k of Object.keys(acc.agency)) acc.agency[k] += (p.agency && p.agency[k]) || 0;
    }
    acc.periodsElapsed = acc.count || 1;
    acc.year = taxYear;
    return acc;
  }

  // ==================================================================
  // RENDER
  // ==================================================================
  function renderAll() {
    renderPeriodSelect();
    if (!state.periods.length) { renderEmpty(); return; }
    renderDashboard();
    renderTaxRate();
    renderScenarios();
    renderProjections();
  }

  function renderEmpty() {
    const msg = '<div class="empty">No paychecks yet.<br>Go to <b>Settings → Import E&amp;L statements</b> or add one manually.</div>';
    $('#adviceCards').innerHTML = '';
    ['#paycheckHero', '#waterfall', '#categoryBreakdown', '#ytdTotals', '#rateGauges', '#bracketLadder', '#otReality', '#scenarioResult', '#annualEstimate', '#tspProjection', '#fersProjection'].forEach((s) => { if ($(s)) $(s).innerHTML = ''; });
    $('#paycheckHero').innerHTML = msg;
  }

  function renderPeriodSelect() {
    const sel = $('#periodSelect');
    sel.innerHTML = state.periods
      .slice().reverse()
      .map((p) => `<option value="${p.id}" ${p.id === state.currentId ? 'selected' : ''}>${p.id}${p.source === 'manual' ? ' ✎' : ''}</option>`)
      .join('');
    sel.onchange = () => { state.currentId = sel.value; state.taxYear = DB.payYear(currentPeriod()); renderAll(); };
  }

  // ---- DASHBOARD ---------------------------------------------------
  function renderDashboard() {
    const p = currentPeriod();
    const b = T.paycheckBreakdown(p, state.settings);
    $('#dashPeriodLabel').textContent = `${p.periodStart} → ${p.periodEnd}`;

    // hero
    $('#paycheckHero').innerHTML =
      `<div class="ph-net">${usd(b.net, 2)}</div>
       <div class="ph-sub">take-home from <b>${usd(b.gross, 2)}</b> gross<br>
       you keep <b>${pct(b.net / b.gross)}</b> of this check · ${usd(b.totalDeductions, 2)} withheld</div>`;

    // waterfall: gross minus each deduction down to net
    const steps = [
      ['Gross', b.gross, 'var(--accent)'],
      ['Federal tax', -b.fedTax, 'var(--fed)'],
      ['IL tax', -b.ilTax, 'var(--state)'],
      ['Social Security', -b.oasdi, 'var(--ss)'],
      ['Medicare', -b.medicare, 'var(--medicare)'],
      ['FERS pension', -b.retirement, 'var(--fers)'],
      ['TSP + Roth', -(b.tsp + b.rothTsp), 'var(--tsp)'],
      ['Health/dental', -(b.fehb + b.dental), 'var(--health)'],
    ];
    if (b.hsa) steps.push(['HSA/pre-tax', -b.hsa, 'var(--hsa)']);
    const maxV = b.gross;
    $('#waterfall').innerHTML = steps.map(([label, v, color]) => {
      const w = Math.min(100, (Math.abs(v) / maxV) * 100);
      return `<div class="wf-row"><div class="wf-label">${label}</div>
        <div class="wf-bar-wrap"><div class="wf-bar" style="width:${w}%;background:${color}"></div></div>
        <div class="wf-amt">${v < 0 ? '−' : ''}${usd(Math.abs(v), 2)}</div></div>`;
    }).join('') +
      `<div class="wf-row total"><div class="wf-label">Net pay</div>
        <div class="wf-bar-wrap"><div class="wf-bar" style="width:${(b.net / maxV) * 100}%;background:var(--net)"></div></div>
        <div class="wf-amt">${usd(b.net, 2)}</div></div>`;

    // category stacked bar + legend
    renderCategoryStack($('#categoryBreakdown'), b.categories, b.gross);

    // YTD
    renderYtd();
    renderAdvice(p, b);
  }

  function renderCategoryStack(host, cats, total) {
    const segs = CAT.filter(([k]) => (cats[k] || 0) > 0)
      .map(([k, , color]) => `<div class="cat-seg" style="width:${(cats[k] / total) * 100}%;background:${color}" title="${k}"></div>`).join('');
    const legend = CAT.filter(([k]) => (cats[k] || 0) > 0).map(([k, label, color]) =>
      `<div class="cat-item"><span class="cat-dot" style="background:${color}"></span>${label}
        <span class="cv">${usd(cats[k], 0)} · ${pct(cats[k] / total, 0)}</span></div>`).join('');
    host.innerHTML = `<div class="cat-stack">${segs}</div><div class="cat-legend">${legend}</div>`;
  }

  function renderYtd() {
    const y = ytdRollup(state.taxYear);
    $('#ytdYearLabel').textContent = `${state.taxYear} tax year · ${y.count} checks`;
    const agencyMatch = y.agency.oasdi + y.agency.medicare + y.agency.retirement + y.agency.fehb + y.agency.tspBasic + y.agency.tspMatching;
    const items = [
      ['Gross', usd(y.gross), ''],
      ['Take-home', usd(y.net), pct(y.net / (y.gross || 1)) + ' kept'],
      ['Federal tax', usd(y.fedWithheld), ''],
      ['IL tax', usd(y.ilWithheld), ''],
      ['Social Security', usd(y.oasdi), 'you paid'],
      ['Medicare', usd(y.medicare), 'you paid'],
      ['FERS + TSP', usd(y.fers + y.tsp + y.rothTsp), 'retirement saved'],
      ['Agency added', usd(agencyMatch), 'match + benefits'],
    ];
    $('#ytdTotals').innerHTML = items.map(([l, v, s]) =>
      `<div class="ytd-item"><div class="yl">${l}</div><div class="yv">${v}</div>${s ? `<div class="ys">${s}</div>` : ''}</div>`).join('');
  }

  function renderAdvice(p, b) {
    const cards = [];
    const ann = T.annualEstimate(ytdToEstimateInput(), state.settings);
    const dist = T.bracketDistance(ann.taxableIncome, ann.year, state.settings.filingStatus);
    const s = T.straightVsOt(p, state.settings);

    // 1. marginal / bracket distance
    if (dist.nextRate != null) {
      cards.push({ cls: 'warn', icon: '⛰️',
        html: `Your next dollars are taxed at <b>${pct(dist.marginalRate, 0)}</b>. You're <b>${usd(dist.amountToNextJump)}</b> of taxable income below the <b>${pct(dist.nextRate, 0)}</b> bracket.` });
    }
    // 2. OT reality
    if (s.grossOT > 1) {
      cards.push({ cls: '', icon: '⏱️',
        html: `On this check you kept <b>${pct(s.pctOtRetained)}</b> of overtime/bonus vs <b>${pct(s.pctStraightRetained)}</b> of straight pay — each OT dollar nets about <b>${usd(s.pctOtRetained, 2)}</b>.` });
    }
    // 3. HSA opportunity
    if (b.hsa === 0) {
      const save = T.hsaSavings(300, dist.marginalRate, b.ilActualRate || 0.0495);
      cards.push({ cls: 'good', icon: '💊',
        html: `You're not contributing to an HSA. At your rates, <b>$300</b>/check pre-tax would save about <b>${usd(save)}</b> per check in combined tax.` });
    }
    // 4. owe / refund pace
    const bal = ann.totalBalance;
    cards.push({ cls: bal >= 0 ? 'good' : 'bad', icon: bal >= 0 ? '✅' : '⚠️',
      html: `On pace to <b>${bal >= 0 ? 'get a refund of' : 'owe'} ${usd(Math.abs(bal))}</b> for ${ann.year} (federal + IL), based on ${ytdRollup(state.taxYear).count} checks annualized.` });

    $('#adviceCards').innerHTML = cards.map((c) =>
      `<div class="advice ${c.cls}"><div class="ai">${c.icon}</div><div class="at">${c.html}</div></div>`).join('');
  }

  function ytdToEstimateInput() {
    const y = ytdRollup(state.taxYear);
    return {
      year: state.taxYear,
      taxableWages: y.taxableWages,
      fedWithheld: y.fedWithheld,
      ilWithheld: y.ilWithheld,
      periodsElapsed: y.periodsElapsed,
      ilAllowances: state.settings.ilAllowances,
    };
  }

  // ---- TAX RATE ----------------------------------------------------
  function renderTaxRate() {
    const ann = T.annualEstimate(ytdToEstimateInput(), state.settings);
    const status = state.settings.filingStatus;
    const dist = T.bracketDistance(ann.taxableIncome, ann.year, status);
    const y = ytdRollup(state.taxYear);
    const totalTaxRate = y.gross > 0 ? (y.fedWithheld + y.ilWithheld + y.oasdi + y.medicare) / y.gross : 0;

    $('#rateGauges').innerHTML =
      `<div class="gauge marginal"><div class="gv">${pct(dist.marginalRate, 0)}</div><div class="gl">Federal marginal rate</div></div>
       <div class="gauge effective"><div class="gv">${pct(totalTaxRate)}</div><div class="gl">All-in effective rate<br><span class="faint">fed+IL+FICA ÷ gross</span></div></div>`;

    // bracket ladder
    const brackets = dist.brackets;
    const widths = brackets.map((br, i) => (brackets[i + 1] ? brackets[i + 1].min - br.min : br.min * 0.25 + 60000));
    const maxW = Math.max(...widths);
    const colors = ['#3b82f6', '#22c55e', '#eab308', '#f59e0b', '#fb923c', '#ef4444', '#dc2626'];
    let rows = brackets.map((br, i) => {
      const active = dist.marginalRate === br.rate && ann.taxableIncome >= br.min;
      const w = (widths[i] / maxW) * 100;
      let marker = '';
      if (active && brackets[i + 1]) {
        const into = (ann.taxableIncome - br.min) / (brackets[i + 1].min - br.min);
        marker = `<div class="bl-marker" style="left:${Math.min(99, into * 100)}%"></div>`;
      }
      const top = brackets[i + 1] ? usd(brackets[i + 1].min) : '+';
      return `<div class="bl-row ${active ? 'active' : ''}">
        <div class="bl-rate">${pct(br.rate, 0)}</div>
        <div class="bl-bar-wrap"><div class="bl-bar" style="width:${w}%;background:${colors[i] || '#dc2626'}"></div>${marker}</div>
        <div class="bl-range">${usd(br.min)}–${top}</div></div>`;
    }).join('');
    const youHere = dist.nextRate != null
      ? `You're <b>${usd(dist.amountToNextJump)}</b> of taxable income below the ${pct(dist.nextRate, 0)} bracket. Income above the line is taxed at ${pct(dist.marginalRate, 0)}.`
      : `You're in the top bracket.`;
    $('#bracketLadder').innerHTML = rows + `<div class="bl-youhere">${youHere} <span class="faint">(taxable income ≈ ${usd(ann.taxableIncome)})</span></div>`;

    // OT reality from current period (or most recent with OT)
    const otP = [...state.periods].reverse().find((p) => T.straightVsOt(p, state.settings).grossOT > 1) || currentPeriod();
    const s = T.straightVsOt(otP, state.settings);
    $('#otReality').innerHTML =
      `<div class="ot-compare">
        <div class="ot-box straight"><div class="obv">${pct(s.pctStraightRetained)}</div><div class="obl">of straight pay kept</div><div class="obs">${usd(s.netHourlyStraightRate, 2)}/hr net</div></div>
        <div class="ot-box ot"><div class="obv">${s.grossOT > 1 ? pct(s.pctOtRetained) : '—'}</div><div class="obl">of OT/bonus kept</div><div class="obs">${s.grossOT > 1 ? usd(s.netHourlyOtRate, 2) + '/hr net' : 'no OT this check'}</div></div>
      </div>
      <div class="ot-note">${s.grossOT > 1
        ? `That overtime stacks on top of your salary, so it's taxed at your <b>${pct(T.bracketDistance(ann.taxableIncome, ann.year, status).marginalRate, 0)}</b> federal marginal rate plus IL ${pct(0.0495,2)} and FICA ${pct(T.FICA_RATE,2)}. Every extra OT dollar nets you about <b>${usd(s.pctOtRetained, 2)}</b> — not the ${usd(s.pctStraightRetained,2)} your average rate suggests.`
        : `Showing your most recent check with no overtime. Pick a period with OT to see the retained rate.`}</div>`;
  }

  // ---- SCENARIOS ---------------------------------------------------
  function wireScenarios() {
    $('#hsaSlider').addEventListener('input', renderScenarios);
    $('#tspSlider').addEventListener('input', renderScenarios);
  }
  function renderScenarios() {
    if (!state.periods.length) return;
    const p = currentPeriod();
    const base = T.paycheckBreakdown(p, state.settings);
    const hsa = num($('#hsaSlider').value);
    const extraTspPct = num($('#tspSlider').value) / 100;
    $('#hsaOut').textContent = usd(hsa);
    $('#tspOut').textContent = (extraTspPct * 100).toFixed(0) + '%';

    // scenario period: add HSA pre-tax + extra TSP (reduces taxable, no extra match modeled)
    const baseSalary = base.retirement > 0 ? base.retirement / T.FERS_RATE : base.gross;
    const scenP = { ...p, hsa: (p.hsa || 0) + hsa, tsp: base.tsp + baseSalary * extraTspPct,
      // recompute taxes in scenario rather than using stored actuals
      fedTax: undefined, ilTax: undefined, oasdi: undefined, medicare: undefined };
    const sc = T.paycheckBreakdown(scenP, state.settings);

    const deltaNet = sc.net - base.net;
    const dist = T.bracketDistance(T.annualEstimate(ytdToEstimateInput(), state.settings).taxableIncome, state.taxYear, state.settings.filingStatus);
    const taxSaved = T.hsaSavings(hsa, dist.marginalRate, base.ilActualRate || 0.0495) + (baseSalary * extraTspPct) * (dist.marginalRate + (base.ilActualRate || 0.0495));

    $('#scenarioResult').innerHTML =
      `<div class="sr-item"><div class="srl">New take-home / check</div><div class="srv">${usd(sc.net, 2)}</div></div>
       <div class="sr-item"><div class="srl">Change in take-home</div><div class="srv ${deltaNet >= 0 ? 'good' : 'bad'}">${deltaNet >= 0 ? '+' : '−'}${usd(Math.abs(deltaNet), 2)}</div></div>
       <div class="sr-item"><div class="srl">Tax saved / check</div><div class="srv good">${usd(taxSaved, 2)}</div></div>
       <div class="sr-item"><div class="srl">Extra retirement / check</div><div class="srv">${usd(baseSalary * extraTspPct + 0, 2)}</div></div>`;

    renderAnnualEstimate();
  }

  function renderAnnualEstimate() {
    const ann = T.annualEstimate(ytdToEstimateInput(), state.settings);
    const bal = ann.totalBalance;
    $('#annualEstimate').innerHTML =
      `<div class="ae-headline"><div class="aev" style="color:${bal >= 0 ? 'var(--good)' : 'var(--bad)'}">${bal >= 0 ? 'Refund ' : 'Owe '}${usd(Math.abs(bal))}</div>
        <div class="ael">projected for ${ann.year} (federal ${usd(ann.federalBalance)} · IL ${usd(ann.stateBalance)})</div></div>
       <div class="ae-grid">
        <div class="ae-cell"><span>Projected taxable income</span><b>${usd(ann.taxableIncome)}</b></div>
        <div class="ae-cell"><span>Standard deduction</span><b>${usd(ann.standardDeduction)}</b></div>
        <div class="ae-cell"><span>Federal tax owed</span><b>${usd(ann.federalTax)}</b></div>
        <div class="ae-cell"><span>Federal withheld (proj.)</span><b>${usd(ann.federalWithheld)}</b></div>
        <div class="ae-cell"><span>IL tax owed</span><b>${usd(ann.stateTax)}</b></div>
        <div class="ae-cell"><span>IL withheld (proj.)</span><b>${usd(ann.stateWithheld)}</b></div>
       </div>
       <p class="hint">Annualized from ${ytdRollup(state.taxYear).count} imported checks. Add other income or credits in Settings for a sharper estimate.</p>`;
  }

  // ---- PROJECTIONS -------------------------------------------------
  function renderProjections() {
    const a = state.settings.tsp;
    const proj = T.tspFutureValue(a);
    $('#tspYears').textContent = `${proj.years} yrs to age ${a.retirementAge}`;
    $('#tspProjection').innerHTML =
      `<div class="proj-hero"><div class="pv">${usd(proj.valueAtRetirement)}</div><div class="pl">projected TSP at age ${a.retirementAge}</div></div>
       <div class="proj-grid">
        <div class="pg-cell"><span>Today's balance grows to</span><b>${usd(proj.fvCurrentBalance)}</b></div>
        <div class="pg-cell"><span>From new contributions</span><b>${usd(proj.valueAtRetirement - proj.fvCurrentBalance)}</b></div>
        <div class="pg-cell"><span>Assumed return</span><b>${pct(a.expectedRor, 0)}/yr</b></div>
        <div class="pg-cell"><span>Contribution</span><b>${pct(a.contributionPct, 0)} of pay</b></div>
       </div>` + lineChart(proj.series.map((s) => s.balance), 'var(--tsp)');

    const f = state.settings.fers;
    const fers = T.fersAnnuity(f);
    $('#fersProjection').innerHTML =
      `<div class="proj-hero"><div class="pv" style="color:var(--fers)">${usd(fers.yearlyAnnuity)}/yr</div><div class="pl">${usd(fers.monthlyAnnuity)}/mo · ${pct(fers.replacementRate)} of high-3</div></div>
       <div class="proj-grid">
        <div class="pg-cell"><span>Multiplier</span><b>${pct(fers.multiplier, 1)}</b></div>
        <div class="pg-cell"><span>Years of service</span><b>${f.yearsOfService}</b></div>
        <div class="pg-cell"><span>High-3 salary</span><b>${usd(f.high3)}</b></div>
        <div class="pg-cell"><span>Survivor benefit</span><b>${f.survivorBenefit ? 'Yes (−10%)' : 'No'}</b></div>
       </div>`;
  }

  function lineChart(values, color) {
    if (!values.length) return '';
    const W = 640, H = 180, pad = 6;
    const max = Math.max(...values), min = Math.min(0, ...values);
    const x = (i) => pad + (i / (values.length - 1)) * (W - 2 * pad);
    const yv = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - 2 * pad);
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${yv(v).toFixed(1)}`).join(' ');
    const area = `${pad},${H - pad} ` + pts + ` ${W - pad},${H - pad}`;
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polygon points="${area}" fill="${color}" opacity="0.12"></polygon>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5"></polyline>
    </svg>`;
  }

  // ==================================================================
  // SETTINGS + IMPORT + MODAL
  // ==================================================================
  function wireNav() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      document.body.dataset.view = t.dataset.go;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
  }

  function wireSettings() {
    // populate
    const s = state.settings;
    $('#setFilingStatus').value = s.filingStatus;
    $('#setIlAllowances').value = s.ilAllowances;
    $('#setW4Deductions').value = s.w4.deductions;
    $('#setW4Credits').value = s.w4.credits;
    $('#setIncludeHsa').checked = !!s.includeHsaInNet;

    const save = async (patch) => { Object.assign(state.settings, patch); await DB.setSettings(patch); renderAll(); };
    $('#setFilingStatus').onchange = (e) => save({ filingStatus: e.target.value });
    $('#setIlAllowances').onchange = (e) => save({ ilAllowances: num(e.target.value) });
    $('#setW4Deductions').onchange = (e) => save({ w4: { ...s.w4, deductions: num(e.target.value) } });
    $('#setW4Credits').onchange = (e) => save({ w4: { ...s.w4, credits: num(e.target.value) } });
    $('#setIncludeHsa').onchange = (e) => save({ includeHsaInNet: e.target.checked });

    renderAssumptions();

    // import EL
    $('#importElBtn').onclick = () => $('#importElInput').click();
    $('#importElInput').onchange = onImportEl;
    $('#addManualBtn').onclick = () => openPeriodModal(null);
    $('#exportBackupBtn').onclick = onExportBackup;
    $('#importBackupBtn').onclick = () => $('#importBackupInput').click();
    $('#importBackupInput').onchange = onImportBackup;
    $('#clearAllBtn').onclick = onClearAll;
  }

  function renderAssumptions() {
    const s = state.settings;
    const fields = [
      ['tsp.currentBalance', 'TSP balance today ($)', s.tsp.currentBalance],
      ['tsp.annualIncome', 'Annual income ($)', s.tsp.annualIncome],
      ['tsp.contributionPct', 'TSP contribution (%)', s.tsp.contributionPct * 100],
      ['tsp.expectedRor', 'Expected return (%)', s.tsp.expectedRor * 100],
      ['tsp.incomeGrowth', 'Income growth (%/yr)', s.tsp.incomeGrowth * 100],
      ['tsp.currentAge', 'Current age', s.tsp.currentAge],
      ['tsp.retirementAge', 'Retirement age', s.tsp.retirementAge],
      ['fers.high3', 'FERS high-3 salary ($)', s.fers.high3],
      ['fers.yearsOfService', 'Years of service at retirement', s.fers.yearsOfService],
    ];
    $('#assumptionsForm').innerHTML = fields.map(([k, label, v]) =>
      `<label>${label}<input type="number" data-k="${k}" value="${v}" step="any"></label>`).join('') +
      `<label class="checkbox"><input type="checkbox" data-k="fers.survivorBenefit" ${s.fers.survivorBenefit ? 'checked' : ''}> FERS survivor benefit (−10%)</label>`;
    $$('#assumptionsForm input').forEach((inp) => inp.onchange = async () => {
      const [grp, key] = inp.dataset.k.split('.');
      let val = inp.type === 'checkbox' ? inp.checked : num(inp.value);
      if (['contributionPct', 'expectedRor', 'incomeGrowth'].includes(key)) val = val / 100;
      state.settings[grp][key] = val;
      await DB.setSetting(grp, state.settings[grp]);
      renderProjections();
    });
  }

  async function onImportEl(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    $('#importStatus').textContent = `Reading ${files.length} file(s)…`;
    try {
      const texts = await Promise.all(files.map(readFileText));
      const parsed = ELParse.parseMany(texts);
      if (!parsed.length) { $('#importStatus').textContent = 'No valid statements found.'; return; }
      const res = await DB.importPeriods(parsed);
      state.periods = await DB.allPeriods();
      if (!state.currentId) { state.currentId = state.periods[state.periods.length - 1].id; state.taxYear = DB.payYear(currentPeriod()); }
      $('#importStatus').textContent = `Imported ${res.added} (${res.skipped} manual kept).`;
      toast(`Imported ${res.added} statement(s)`);
      renderAll();
    } catch (err) {
      $('#importStatus').textContent = 'Import failed: ' + err.message;
    }
    e.target.value = '';
  }
  function readFileText(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsText(file);
    });
  }

  async function onExportBackup() {
    const data = await DB.exportBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `taxplanner-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    toast('Backup downloaded');
  }
  async function onImportBackup(e) {
    const file = e.target.files[0]; if (!file) return;
    try {
      const obj = JSON.parse(await readFileText(file));
      await DB.importBackup(obj);
      state.settings = await DB.getSettings();
      state.periods = await DB.allPeriods();
      state.currentId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
      state.taxYear = state.currentId ? DB.payYear(currentPeriod()) : null;
      wireSettings(); renderAll(); toast('Backup restored');
    } catch (err) { toast('Restore failed: ' + err.message); }
    e.target.value = '';
  }
  async function onClearAll() {
    if (!confirm('Delete all paychecks and settings? This cannot be undone.')) return;
    await DB.clearAll();
    state.settings = await DB.getSettings();
    state.periods = []; state.currentId = null; state.taxYear = null;
    wireSettings(); renderAll(); toast('All data cleared');
  }

  // ---- period modal (manual add / edit) ----------------------------
  const PFIELDS = [
    ['year', 'Year', 'number'], ['pp', 'Pay period #', 'number'],
    ['periodStart', 'Period start', 'date'], ['periodEnd', 'Period end', 'date'],
    ['gross', 'Gross pay', 'number'], ['hours', 'Hours', 'number'],
    ['fehb', 'FEHB (health)', 'number'], ['dental', 'Dental', 'number'],
    ['hsa', 'HSA/pre-tax', 'number'], ['retirement', 'FERS retirement', 'number'],
    ['tsp', 'TSP', 'number'], ['rothTsp', 'Roth TSP', 'number'],
    ['oasdi', 'Social Security', 'number'], ['medicare', 'Medicare', 'number'],
    ['fedTax', 'Federal tax', 'number'], ['ilTax', 'IL tax', 'number'],
  ];
  function wireModal() {
    $('#periodModalClose').onclick = closePeriodModal;
    $('#periodModal').addEventListener('click', (e) => { if (e.target.id === 'periodModal') closePeriodModal(); });
    $('#periodSaveBtn').onclick = savePeriodModal;
    $('#periodDeleteBtn').onclick = deletePeriodModal;
  }
  let editingId = null;
  function openPeriodModal(id) {
    editingId = id;
    const p = id ? state.periods.find((x) => x.id === id) : {};
    $('#periodModalTitle').textContent = id ? `Edit ${id}` : 'Add paycheck';
    $('#periodDeleteBtn').style.display = id ? '' : 'none';
    $('#periodForm').innerHTML = PFIELDS.map(([k, label, type]) =>
      `<label class="${k === 'periodStart' || k === 'periodEnd' ? 'full' : ''}">${label}
        <input data-k="${k}" type="${type}" value="${p[k] != null ? p[k] : ''}" step="any"></label>`).join('');
    $('#periodModal').hidden = false;
  }
  function closePeriodModal() { $('#periodModal').hidden = true; }
  async function savePeriodModal() {
    const obj = { source: 'manual' };
    $$('#periodForm input').forEach((inp) => {
      const k = inp.dataset.k;
      obj[k] = inp.type === 'number' ? num(inp.value) : inp.value;
    });
    if (!obj.year || !obj.pp) { toast('Year and pay period # are required'); return; }
    obj.id = `${obj.year}-PP${String(obj.pp).padStart(2, '0')}`;
    if (obj.periodEnd) { const d = new Date(obj.periodEnd); d.setDate(d.getDate() + 12); obj.payDate = d.toISOString().slice(0, 10); }
    obj.ytd = obj.ytd || {}; obj.agency = obj.agency || {};
    await DB.upsertPeriod(obj);
    state.periods = await DB.allPeriods();
    state.currentId = obj.id; state.taxYear = DB.payYear(obj);
    closePeriodModal(); renderAll(); toast('Saved ' + obj.id);
  }
  async function deletePeriodModal() {
    if (!editingId || !confirm('Delete ' + editingId + '?')) return;
    await DB.deletePeriod(editingId);
    state.periods = await DB.allPeriods();
    state.currentId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
    state.taxYear = state.currentId ? DB.payYear(currentPeriod()) : null;
    closePeriodModal(); renderAll(); toast('Deleted');
  }

  // expose for the period selector's edit affordance (long-press not needed; add edit btn)
  window.__editPeriod = openPeriodModal;

  boot();
})();
