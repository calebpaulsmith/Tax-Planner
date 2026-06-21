/*
 * app.js — UI layer, view router, rendering. Wrapped in an IIFE.
 * Reads the pure engine (window.TaxCalc), citations (window.Cites), parser
 * (window.ELParse), and data layer (window.DB). All math lives in the engine;
 * this file only renders it and exposes the "how is this computed?" traces.
 */
(function () {
  'use strict';
  const T = window.TaxCalc;
  const C = window.Cites;

  const state = { settings: null, periods: [], currentId: null, taxYear: null,
    dollarOff: {} /* category -> hidden */ };

  // ---- helpers -----------------------------------------------------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const usd = (n, dp = 0) => (n < 0 ? '-' : '') + '$' +
    Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const pct = (n, dp = 1) => (n * 100).toFixed(dp) + '%';
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  let toastTimer;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2800); }

  // ---- explainability registry + modal -----------------------------
  let EXPLAINS = {}, exId = 0;
  function explain(title, steps) {
    if (!steps || !steps.length) return '';
    const id = 'x' + (++exId);
    EXPLAINS[id] = { title, steps };
    return `<button class="info-btn" data-x="${id}" aria-label="How is this computed?">i</button>`;
  }
  function openExplain(id) {
    const e = EXPLAINS[id]; if (!e) return;
    $('#explainTitle').textContent = e.title;
    $('#explainBody').innerHTML = e.steps.map((s, i) => {
      const inputs = (s.inputs || []).map((inp) => `${inp.name} = ${typeof inp.value === 'number' ? usd(inp.value, 2) : inp.value}${inp.source ? ` <span class="faint">(${inp.source})</span>` : ''}`).join(' · ');
      const cite = s.cite && C ? citeHtml(s.cite, i) : '';
      return `<div class="xstep">
        <div class="xlabel"><span>${s.label}</span><span class="xval">${typeof s.value === 'number' ? usd(s.value, 2) : s.value}</span></div>
        ${s.plain ? `<div class="xplain">${s.plain}</div>` : ''}
        ${s.formula ? `<div class="xformula">${s.formula}</div>` : ''}
        ${inputs ? `<div class="xinputs">${inputs}</div>` : ''}
        ${cite}</div>`;
    }).join('');
    $('#explainModal').hidden = false;
  }
  function citeHtml(id, i) {
    const c = C.get(id); if (!c) return '';
    return `<div class="xcite">
      <button class="xcite-toggle" data-cite="${id}" data-i="${i}">▸ Rule &amp; source</button>
      <div class="xcite-body" id="cb-${id}-${i}" hidden>
        <div><b>${c.title}</b></div>
        <div class="xq">"${c.quote}"</div>
        <div><a href="${c.url}" target="_blank" rel="noopener">${c.url}</a></div>
        <div class="xret">Retrieved ${c.retrieved}</div>
      </div></div>`;
  }

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
  async function boot() {
    state.settings = await DB.getSettings();
    state.periods = await DB.allPeriods();
    if (state.periods.length) { state.currentId = state.periods[state.periods.length - 1].id; state.taxYear = DB.payYear(currentPeriod()); }
    wireNav(); wireSettings(); wireModals(); wireOnboarding();
    if (!state.periods.length && !state.settings.onboarded) { document.body.dataset.view = 'onboarding'; }
    renderAll();
  }
  function currentPeriod() { return state.periods.find((p) => p.id === state.currentId) || null; }

  // ---- YTD rollup (by paydate / tax year) --------------------------
  function ytdRollup(taxYear) {
    const inYear = state.periods.filter((p) => DB.payYear(p) === taxYear);
    const acc = { gross: 0, fedWithheld: 0, ilWithheld: 0, oasdi: 0, medicare: 0, fers: 0, tsp: 0, rothTsp: 0,
      health: 0, hsa: 0, net: 0, taxableWages: 0, qualifiedOt: 0,
      agency: { oasdi: 0, medicare: 0, retirement: 0, fehb: 0, tspBasic: 0, tspMatching: 0 }, count: inYear.length };
    for (const p of inYear) {
      const b = T.paycheckBreakdown(p, state.settings);
      acc.gross += b.gross; acc.fedWithheld += b.fedTax; acc.ilWithheld += b.ilTax;
      acc.oasdi += b.oasdi; acc.medicare += b.medicare; acc.fers += b.retirement;
      acc.tsp += b.tsp; acc.rothTsp += b.rothTsp; acc.health += b.fehb + b.dental; acc.hsa += b.hsa;
      acc.net += b.net; acc.taxableWages += b.agi - b.fehb - b.dental; acc.qualifiedOt += b.qualifiedOt;
      for (const k of Object.keys(acc.agency)) acc.agency[k] += (p.agency && p.agency[k]) || 0;
    }
    acc.periodsElapsed = acc.count || 1; acc.year = taxYear;
    return acc;
  }
  function estimateInput() {
    const y = ytdRollup(state.taxYear);
    return { year: state.taxYear, taxableWages: y.taxableWages, fedWithheld: y.fedWithheld,
      ilWithheld: y.ilWithheld, periodsElapsed: y.periodsElapsed, qualifiedOt: y.qualifiedOt };
  }

  // ==================================================================
  function renderAll() {
    EXPLAINS = {}; exId = 0;
    renderPeriodSelect();
    if (!state.periods.length) { renderEmpty(); return; }
    renderDashboard(); renderRate(); renderPlan(); renderReport();
  }
  function renderEmpty() {
    $('#adviceCards').innerHTML = '';
    $('#paycheckHero').innerHTML = '<div class="empty">No paychecks yet.<br>Go to <b>Settings → Import</b> or add one manually.</div>';
    ['#waterfall', '#categoryBreakdown', '#ytdTotals', '#bracketFill', '#dollarBar', '#otReality', '#decisionTools', '#annualEstimate', '#tspProjection', '#fersProjection', '#reportBody'].forEach((s) => { if ($(s)) $(s).innerHTML = ''; });
  }
  function renderPeriodSelect() {
    const sel = $('#periodSelect');
    sel.innerHTML = state.periods.slice().reverse().map((p) =>
      `<option value="${p.id}" ${p.id === state.currentId ? 'selected' : ''}>${p.id}${p.source === 'manual' ? ' ✎' : ''}</option>`).join('');
    sel.onchange = () => { state.currentId = sel.value; state.taxYear = DB.payYear(currentPeriod()); renderAll(); };
  }

  // ---- MONEY -------------------------------------------------------
  function renderDashboard() {
    const p = currentPeriod();
    const b = T.paycheckBreakdown(p, state.settings);
    $('#dashPeriodLabel').textContent = `${p.periodStart || ''} → ${p.periodEnd || ''}`;
    $('#paycheckHero').innerHTML =
      `<div class="ph-net">${usd(b.net, 2)}</div>
       <div class="ph-sub">take-home from <b>${usd(b.gross, 2)}</b> gross ${explain('This paycheck', b.steps)}<br>
       you keep <b>${pct(b.net / b.gross)}</b> of this check · ${usd(b.totalDeductions, 2)} withheld</div>`;

    const steps = [['Gross', b.gross, 'var(--accent)'], ['Federal tax', -b.fedTax, 'var(--fed)'],
      ['IL tax', -b.ilTax, 'var(--state)'], ['Social Security', -b.oasdi, 'var(--ss)'],
      ['Medicare', -b.medicare, 'var(--medicare)'], ['FERS pension', -b.retirement, 'var(--fers)'],
      ['TSP + Roth', -(b.tsp + b.rothTsp), 'var(--tsp)'], ['Health/dental', -(b.fehb + b.dental), 'var(--health)']];
    if (b.hsa) steps.push(['HSA/pre-tax', -b.hsa, 'var(--hsa)']);
    const maxV = b.gross;
    $('#waterfall').innerHTML = steps.map(([label, v, color]) =>
      `<div class="wf-row"><div class="wf-label">${label}</div>
        <div class="wf-bar-wrap"><div class="wf-bar" style="width:${Math.min(100, Math.abs(v) / maxV * 100)}%;background:${color}"></div></div>
        <div class="wf-amt">${v < 0 ? '−' : ''}${usd(Math.abs(v), 2)}</div></div>`).join('') +
      `<div class="wf-row total"><div class="wf-label">Net pay</div>
        <div class="wf-bar-wrap"><div class="wf-bar" style="width:${b.net / maxV * 100}%;background:var(--net)"></div></div>
        <div class="wf-amt">${usd(b.net, 2)}</div></div>`;

    renderCategoryStack($('#categoryBreakdown'), b.categories, b.gross);
    renderYtd(); renderAdvice(p, b);
  }
  function renderCategoryStack(host, cats, total) {
    const segs = CAT.filter(([k]) => (cats[k] || 0) > 0).map(([k, , color]) =>
      `<div class="cat-seg" style="width:${cats[k] / total * 100}%;background:${color}"></div>`).join('');
    const legend = CAT.filter(([k]) => (cats[k] || 0) > 0).map(([k, label, color]) =>
      `<div class="cat-item"><span class="cat-dot" style="background:${color}"></span>${label}<span class="cv">${usd(cats[k], 0)} · ${pct(cats[k] / total, 0)}</span></div>`).join('');
    host.innerHTML = `<div class="cat-stack">${segs}</div><div class="cat-legend">${legend}</div>`;
  }
  function renderYtd() {
    const y = ytdRollup(state.taxYear);
    $('#ytdYearLabel').textContent = `${state.taxYear} tax year · ${y.count} checks`;
    const agency = y.agency.oasdi + y.agency.medicare + y.agency.retirement + y.agency.fehb + y.agency.tspBasic + y.agency.tspMatching;
    const items = [['Gross', usd(y.gross), ''], ['Take-home', usd(y.net), pct(y.net / (y.gross || 1)) + ' kept'],
      ['Federal tax', usd(y.fedWithheld), ''], ['IL tax', usd(y.ilWithheld), ''],
      ['Social Security', usd(y.oasdi), 'you paid'], ['Medicare', usd(y.medicare), 'you paid'],
      ['FERS + TSP', usd(y.fers + y.tsp + y.rothTsp), 'retirement saved'], ['Agency added', usd(agency), 'match + benefits']];
    $('#ytdTotals').innerHTML = items.map(([l, v, s]) => `<div class="ytd-item"><div class="yl">${l}</div><div class="yv">${v}</div>${s ? `<div class="ys">${s}</div>` : ''}</div>`).join('');
  }
  function renderAdvice(p, b) {
    const cards = []; const ann = T.annualEstimate(estimateInput(), state.settings);
    const dist = T.bracketDistance(ann.ordinaryTaxable, ann.year, state.settings.filingStatus);
    const s = T.straightVsOt(p, state.settings);
    if (dist.nextRate != null) cards.push({ cls: 'warn', icon: '⛰️', html: `Your next dollars are taxed at <b>${pct(dist.marginalRate, 0)}</b>. You're <b>${usd(dist.amountToNextJump)}</b> of taxable income below the <b>${pct(dist.nextRate, 0)}</b> bracket.` });
    if (ann.overtimeDeduction > 0) cards.push({ cls: 'good', icon: '⏱️', explainSteps: ann.overtimeDeductionSteps, html: `About <b>${usd(ann.overtimeDeduction)}</b> of your overtime is the deductible <b>premium half</b> — the new "No Tax on Overtime" deduction cuts your federal taxable income by that much (2025–2028).` });
    else if (s.grossOT > 1) cards.push({ cls: '', icon: '⏱️', html: `You kept <b>${pct(s.pctOtRetained)}</b> of overtime/bonus vs <b>${pct(s.pctStraightRetained)}</b> of straight pay on this check.` });
    if (b.hsa === 0) { const save = T.hsaSavings(300, dist.marginalRate, b.ilActualRate || 0.0495); cards.push({ cls: 'good', icon: '💊', html: `No HSA contribution detected. At your rates, <b>$300</b>/check pre-tax would save about <b>${usd(save)}</b> per check in combined tax.` }); }
    const bal = ann.totalBalance; cards.push({ cls: bal >= 0 ? 'good' : 'bad', icon: bal >= 0 ? '✅' : '⚠️', explainSteps: ann.steps, html: `On pace to <b>${bal >= 0 ? 'get a refund of' : 'owe'} ${usd(Math.abs(bal))}</b> for ${ann.year} (federal + IL).` });
    $('#adviceCards').innerHTML = cards.map((c) => `<div class="advice ${c.cls}"><div class="ai">${c.icon}</div><div class="at">${c.html} ${c.explainSteps ? explain('How this is computed', c.explainSteps) : ''}</div></div>`).join('');
  }

  // ---- RATE: bracket-fill + dollar toggles + OT --------------------
  function renderRate() {
    const ann = T.annualEstimate(estimateInput(), state.settings);
    const status = state.settings.filingStatus;
    const dist = T.bracketDistance(ann.ordinaryTaxable, ann.year, status);
    const ti = ann.ordinaryTaxable;
    const colors = ['#3b82f6', '#22c55e', '#eab308', '#f59e0b', '#fb923c', '#ef4444', '#dc2626'];
    const br = dist.brackets;
    const rows = br.map((b, i) => {
      const top = br[i + 1] ? br[i + 1].min : b.min + 120000;
      const span = top - b.min;
      const fill = Math.max(0, Math.min(1, (ti - b.min) / span));
      const active = dist.marginalRate === b.rate && ti >= b.min;
      const partial = fill > 0 && fill < 1;
      return `<div class="bf-row ${active ? 'active' : ''} ${partial ? 'partial' : ''}">
        <div class="bf-rate">${pct(b.rate, 0)}</div>
        <div class="bf-track"><div class="bf-fill" style="width:${fill * 100}%;background:${colors[i] || '#dc2626'}"></div></div>
        <div class="bf-amt">${usd(b.min)}${br[i + 1] ? '–' + usd(br[i + 1].min) : '+'}</div></div>`;
    }).join('');
    const cap = dist.nextRate != null
      ? `You're <b>${usd(dist.amountToNextJump)}</b> below the ${pct(dist.nextRate, 0)} bracket. <span class="faint">Taxable income ≈ ${usd(ti)}.</span>`
      : `You're in the top bracket.`;
    $('#bracketFill').innerHTML = rows + `<div class="bf-caption">${cap} ${explain('How taxable income is computed', ann.steps)}</div>`;

    renderDollarBar();

    // OT reality + OBBBA
    const otP = [...state.periods].reverse().find((x) => T.straightVsOt(x, state.settings).grossOT > 1) || currentPeriod();
    const s = T.straightVsOt(otP, state.settings);
    const otDed = T.overtimeDeduction(ann.qualifiedOvertime, ann.magi, status, ann.year);
    $('#otReality').innerHTML =
      `<div class="ot-compare">
        <div class="ot-box straight"><div class="obv">${pct(s.pctStraightRetained)}</div><div class="obl">of straight pay kept</div></div>
        <div class="ot-box ot"><div class="obv">${s.grossOT > 1 ? pct(s.pctOtRetained) : '—'}</div><div class="obl">of OT/bonus kept</div></div>
      </div>
      <div class="ot-note">The half-time <b>premium</b> of your FLSA overtime is now deductible from federal income tax (OBBBA, 2025–2028). Estimated qualified OT this year: <b>${usd(ann.qualifiedOvertime)}</b> → deduction <b>${usd(otDed.value)}</b> ${explain('Overtime deduction (OBBBA)', otDed.steps)}<br><span class="faint">Straight-time hours stay fully taxed; only the 0.5× premium qualifies. The authoritative figure is your W-2 qualified-OT box.</span></div>`;
  }
  function renderDollarBar() {
    const b = T.paycheckBreakdown(currentPeriod(), state.settings);
    const total = b.gross;
    $('#dollarToggles').innerHTML = CAT.map(([k, label, color]) =>
      `<button class="chip ${state.dollarOff[k] ? '' : 'on'}" data-cat="${k}" style="${state.dollarOff[k] ? '' : `border-color:${color}`}">${label}</button>`).join('');
    const shown = CAT.filter(([k]) => !state.dollarOff[k] && (b.categories[k] || 0) > 0);
    const segs = shown.map(([k, , color]) => `<div class="db-seg" style="width:${b.categories[k] / total * 100}%;background:${color}"></div>`).join('');
    const legend = shown.map(([k, label, color]) => `<div class="db-item"><span class="cat-dot" style="background:${color}"></span>${label}<span class="cv">${pct(b.categories[k] / total, 1)}</span></div>`).join('');
    $('#dollarBar').innerHTML = `<div class="db-stack">${segs}</div><div class="db-legend">${legend}</div>`;
    $$('#dollarToggles .chip').forEach((c) => c.onclick = () => { const k = c.dataset.cat; state.dollarOff[k] = !state.dollarOff[k]; renderDollarBar(); });
  }

  // ---- PLAN: decisions + estimate + projections --------------------
  function renderPlan() { renderDecisions(); renderAnnualEstimate(); renderProjections(); }

  function renderDecisions() {
    const p = currentPeriod();
    const base = T.paycheckBreakdown(p, state.settings);
    const ann = T.annualEstimate(estimateInput(), state.settings);
    const status = state.settings.filingStatus;
    const dist = T.bracketDistance(ann.ordinaryTaxable, ann.year, status);
    const baseSalary = base.retirement > 0 ? base.retirement / T.FERS_RATE : base.gross;
    const ilRate = base.ilActualRate || 0.0495;
    const host = $('#decisionTools');

    // 1. HSA to bracket
    const hsaPP = state.settings.hsaPerPeriod || 0;
    const toBracket = dist.amountIntoBracket; // $ into current bracket = amount to drop below the floor
    const hsaNeededYr = Math.max(0, toBracket);
    const hsaSaveCheck = T.hsaSavings(hsaPP, dist.marginalRate, ilRate);
    // 2. TSP
    const tspPP = state.settings.extraTspPct || 0;
    const extraTspAmt = baseSalary * (tspPP / 100);
    const tspSaveCheck = extraTspAmt * (dist.marginalRate + ilRate);
    // 3. Roth vs Trad
    const rvt = T.rothVsTraditional(baseSalary * 0.05 * 26, { marginalNow: dist.marginalRate, stateRate: ilRate,
      retireRate: (state.settings.roth && state.settings.roth.retireRate) || 0.12,
      years: (state.settings.tsp.retirementAge - state.settings.tsp.currentAge), ror: state.settings.tsp.expectedRor });

    host.innerHTML = `
      <div class="decision">
        <h3>1 · Increase HSA to dodge a bracket? ${explain('HSA tax savings', [{ label: 'Combined tax rate saved', plain: 'Pre-tax HSA via payroll avoids federal + IL income tax AND FICA.', formula: `${pct(dist.marginalRate, 0)} fed + ${pct(ilRate, 2)} IL + 7.65% FICA`, value: dist.marginalRate + ilRate + 0.0765, cite: 'hsaLimits' }])}</h3>
        <div class="dsub">You're <b>${usd(dist.amountToNextJump)}</b> below the ${dist.nextRate != null ? pct(dist.nextRate, 0) : '—'} bracket and <b>${usd(toBracket)}</b> into the ${pct(dist.marginalRate, 0)} bracket.</div>
        <div class="dctrl"><span>HSA per paycheck</span><output>${usd(hsaPP)}</output><input type="range" id="hsaSlider" min="0" max="800" step="25" value="${hsaPP}"></div>
        <div class="dresult">
          <div class="dcell"><div class="dl">Tax saved / check</div><div class="dv good">${usd(hsaSaveCheck, 2)}</div></div>
          <div class="dcell"><div class="dl">Saved / year</div><div class="dv good">${usd(hsaSaveCheck * 26)}</div></div>
        </div>
        <div class="dverdict">To pull your taxable income below the <b>${pct(dist.marginalRate, 0)}</b> bracket entirely you'd shelter about <b>${usd(hsaNeededYr)}</b>/yr (HSA + traditional TSP combined). HSA family cap this year: <b>${usd(taxYearHsaCap())}</b>.</div>
      </div>

      <div class="decision">
        <h3>2 · Contribute more to TSP? ${explain('Traditional TSP tax savings', [{ label: 'Tax saved now', plain: 'Traditional TSP lowers federal + IL taxable income now (not FICA).', formula: `contribution × (${pct(dist.marginalRate, 0)} + ${pct(ilRate, 2)})`, value: dist.marginalRate + ilRate, cite: 'tspLimits' }])}</h3>
        <div class="dsub">Extra <i>traditional</i> TSP beyond your current 5%.</div>
        <div class="dctrl"><span>Extra TSP (% of base)</span><output>${tspPP}%</output><input type="range" id="tspSlider" min="0" max="20" step="1" value="${tspPP}"></div>
        <div class="dresult">
          <div class="dcell"><div class="dl">Extra saved / check</div><div class="dv">${usd(extraTspAmt / 26, 2)}</div></div>
          <div class="dcell"><div class="dl">Tax saved / year</div><div class="dv good">${usd(tspSaveCheck)}</div></div>
        </div>
        <div class="dverdict">2026 TSP elective-deferral limit: <b>$24,500</b>. Every extra traditional dollar avoids tax at your <b>${pct(dist.marginalRate, 0)}</b> federal rate today.</div>
      </div>

      <div class="decision">
        <h3>3 · Roth vs Traditional TSP? ${explain('Roth vs Traditional', rvt.steps)}</h3>
        <div class="dsub">Comparing your 5% contribution (${usd(baseSalary * 0.05 * 26)}/yr) over ${state.settings.tsp.retirementAge - state.settings.tsp.currentAge} years.</div>
        <div class="dresult">
          <div class="dcell"><div class="dl">Traditional: tax saved now</div><div class="dv good">${usd(rvt.taxSavedNow)}</div></div>
          <div class="dcell"><div class="dl">Roth value at retirement</div><div class="dv">${usd(rvt.rothAfterTax)}</div></div>
        </div>
        <div class="dverdict">If your tax rate in retirement is <b>lower</b> than today's ${pct(dist.marginalRate, 0)}, <b>traditional wins</b>; if higher, Roth wins. Current call: <b>${rvt.recommendation === 'traditional' ? 'Traditional' : rvt.recommendation === 'roth' ? 'Roth' : 'Toss-up'}</b>. <span class="faint">Set your expected retirement rate in Settings.</span></div>
      </div>`;

    $('#hsaSlider').oninput = (e) => { state.settings.hsaPerPeriod = num(e.target.value); DB.setSetting('hsaPerPeriod', state.settings.hsaPerPeriod); renderDecisions(); };
    $('#tspSlider').oninput = (e) => { state.settings.extraTspPct = num(e.target.value); DB.setSetting('extraTspPct', state.settings.extraTspPct); renderDecisions(); };
  }
  function taxYearHsaCap() { return state.taxYear >= 2026 ? 8750 : 8550; }

  function renderAnnualEstimate() {
    const ann = T.annualEstimate(estimateInput(), state.settings);
    const bal = ann.totalBalance;
    $('#annualEstimate').innerHTML =
      `<div class="ae-headline"><div class="aev" style="color:${bal >= 0 ? 'var(--good)' : 'var(--bad)'}">${bal >= 0 ? 'Refund ' : 'Owe '}${usd(Math.abs(bal))}</div>
        <div class="ael">projected for ${ann.year} (federal ${usd(ann.federalBalance)} · IL ${usd(ann.stateBalance)}) ${explain('Annual estimate', ann.steps)}</div></div>
       <div class="ae-grid">
        <div class="ae-cell"><span>Projected taxable income</span><b>${usd(ann.taxableIncome)}</b></div>
        <div class="ae-cell"><span>Deduction used</span><b>${usd(ann.deductionUsed)}</b></div>
        <div class="ae-cell"><span>Overtime deduction</span><b>${usd(ann.overtimeDeduction)}</b></div>
        <div class="ae-cell"><span>Marginal rate</span><b>${pct(ann.marginalRate, 0)}</b></div>
        <div class="ae-cell"><span>Federal tax owed</span><b>${usd(ann.federalTax)}</b></div>
        <div class="ae-cell"><span>IL tax owed</span><b>${usd(ann.stateTax)}</b></div>
       </div>
       <p class="hint">Annualized from ${ytdRollup(state.taxYear).count} checks. Add spouse/2nd-job/investment income in Settings → Household to sharpen it.</p>`;
  }
  function renderProjections() {
    const a = state.settings.tsp; const proj = T.tspFutureValue(a);
    $('#tspProjection').innerHTML =
      `<div class="proj-hero"><div class="pv">${usd(proj.valueAtRetirement)}</div><div class="pl">projected TSP at age ${a.retirementAge}</div></div>
       <div class="proj-grid">
        <div class="pg-cell"><span>Today's balance grows to</span><b>${usd(proj.fvCurrentBalance)}</b></div>
        <div class="pg-cell"><span>From new contributions</span><b>${usd(proj.valueAtRetirement - proj.fvCurrentBalance)}</b></div>
       </div>` + lineChart(proj.series.map((s) => s.balance), 'var(--tsp)');
    const f = state.settings.fers; const fers = T.fersAnnuity(f);
    $('#fersProjection').innerHTML =
      `<div class="proj-hero" style="margin-top:14px"><div class="pv" style="color:var(--fers)">${usd(fers.yearlyAnnuity)}/yr</div><div class="pl">FERS pension · ${usd(fers.monthlyAnnuity)}/mo · ${pct(fers.replacementRate)} of high-3</div></div>`;
  }
  function lineChart(values, color) {
    if (!values.length) return '';
    const W = 640, H = 150, pad = 6, max = Math.max(...values), min = Math.min(0, ...values);
    const x = (i) => pad + i / (values.length - 1) * (W - 2 * pad);
    const yv = (v) => H - pad - (v - min) / (max - min || 1) * (H - 2 * pad);
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${yv(v).toFixed(1)}`).join(' ');
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polygon points="${pad},${H - pad} ${pts} ${W - pad},${H - pad}" fill="${color}" opacity="0.12"></polygon><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5"></polyline></svg>`;
  }

  // ---- REPORT ------------------------------------------------------
  function renderReport() {
    const ann = T.annualEstimate(estimateInput(), state.settings);
    const y = ytdRollup(state.taxYear);
    const status = state.settings.filingStatus;
    const dist = T.bracketDistance(ann.ordinaryTaxable, ann.year, status);
    const allInRate = y.gross > 0 ? (y.fedWithheld + y.ilWithheld + y.oasdi + y.medicare) / y.gross : 0;
    const bal = ann.totalBalance;
    const recs = [];
    if (dist.amountToNextJump != null) recs.push({ cls: 'warn', t: `You have <b>${usd(dist.amountToNextJump)}</b> of room before the ${pct(dist.nextRate, 0)} bracket — pre-tax HSA/TSP keeps income in the ${pct(dist.marginalRate, 0)} band.` });
    if (ann.overtimeDeduction > 0) recs.push({ cls: 'good', t: `Claim the <b>${usd(ann.overtimeDeduction)}</b> overtime deduction at filing — it's not in your withholding (OBBBA).` });
    recs.push({ cls: bal >= 0 ? 'good' : 'warn', t: bal >= 0 ? `On track for a <b>${usd(bal)}</b> refund — consider dialing withholding down or shifting to Roth TSP.` : `On track to owe <b>${usd(-bal)}</b> — increase withholding or pre-tax contributions before year-end.` });
    $('#reportBody').innerHTML = `
      <div class="rep-headline"><div class="rh-big" style="color:${bal >= 0 ? 'var(--good)' : 'var(--bad)'}">${bal >= 0 ? 'Refund ' : 'Owe '}${usd(Math.abs(bal))}</div><div class="rh-sub">projected ${ann.year} · ${status}</div></div>
      <div class="rep-grid">
        <div class="rep-stat"><div class="rl">All-in effective rate</div><div class="rv">${pct(allInRate)}</div></div>
        <div class="rep-stat"><div class="rl">Federal marginal</div><div class="rv">${pct(dist.marginalRate, 0)}</div></div>
        <div class="rep-stat"><div class="rl">YTD gross</div><div class="rv">${usd(y.gross)}</div></div>
        <div class="rep-stat"><div class="rl">YTD take-home</div><div class="rv">${usd(y.net)}</div></div>
        <div class="rep-stat"><div class="rl">Projected taxable</div><div class="rv">${usd(ann.taxableIncome)}</div></div>
        <div class="rep-stat"><div class="rl">Overtime deduction</div><div class="rv">${usd(ann.overtimeDeduction)}</div></div>
      </div>
      <div class="rep-section-title">What to do</div>
      ${recs.map((r) => `<div class="rep-rec ${r.cls}"><div>${r.t}</div></div>`).join('')}
      <p class="hint">Predictions, not tax advice. Figures annualized from ${y.count} paychecks${state.settings.household && (state.settings.household.spouseWages || state.settings.household.secondJobWages) ? ' + your household entries' : ''}. Tax tables &amp; rules cited in each "how is this computed?" panel.</p>`;
  }

  // ==================================================================
  // NAV / MODALS / SETTINGS / IMPORT
  // ==================================================================
  function wireNav() { $$('.tab').forEach((t) => t.addEventListener('click', () => { document.body.dataset.view = t.dataset.go; window.scrollTo({ top: 0 }); })); }

  function wireModals() {
    $('#explainClose').onclick = () => ($('#explainModal').hidden = true);
    $('#explainModal').addEventListener('click', (e) => { if (e.target.id === 'explainModal') $('#explainModal').hidden = true; });
    document.addEventListener('click', (e) => {
      const ib = e.target.closest('.info-btn'); if (ib) { openExplain(ib.dataset.x); return; }
      const ct = e.target.closest('.xcite-toggle'); if (ct) { const el = document.getElementById(`cb-${ct.dataset.cite}-${ct.dataset.i}`); if (el) el.hidden = !el.hidden; }
    });
    $('#printReportBtn').onclick = () => window.print();
    // period modal
    $('#periodModalClose').onclick = () => ($('#periodModal').hidden = true);
    $('#periodSaveBtn').onclick = savePeriodModal;
    $('#periodDeleteBtn').onclick = deletePeriodModal;
    // confirm modal
    $('#confirmClose').onclick = () => ($('#confirmModal').hidden = true);
    $('#confirmCancelBtn').onclick = () => ($('#confirmModal').hidden = true);
  }

  function wireOnboarding() {
    $('#obImportBtn').onclick = () => $('#obImportInput').click();
    $('#obImportInput').onchange = (e) => onImport(e, true);
    $('#obStartBtn').onclick = async () => {
      const salary = num($('#obSalary').value); const status = $('#obFiling').value;
      await DB.setSettings({ filingStatus: status, onboarded: true });
      state.settings.filingStatus = status; state.settings.onboarded = true;
      if (salary > 0) {
        const gross = salary / 26; const retirement = gross * T.FERS_RATE;
        const period = { id: `${new Date().getFullYear()}-PP01`, source: 'manual', year: new Date().getFullYear(), pp: 1,
          gross, hours: 80, fehb: 0, dental: 0, hsa: 0, retirement, tsp: gross * 0.05, rothTsp: 0, ytd: {}, agency: {} };
        await DB.upsertPeriod(period); state.periods = await DB.allPeriods(); state.currentId = period.id; state.taxYear = DB.payYear(period);
      }
      document.body.dataset.view = 'dashboard'; wireSettings(); renderAll();
      if (!salary) toast('Import a statement to see real numbers');
    };
    $('#obFiling').onchange = (e) => { state.settings.filingStatus = e.target.value; };
  }

  function wireSettings() {
    const s = state.settings;
    $('#setFilingStatus').value = s.filingStatus; $('#setIlAllowances').value = s.ilAllowances;
    $('#setW4Deductions').value = s.w4.deductions; $('#setW4Credits').value = s.w4.credits;
    $('#setIncludeHsa').checked = !!s.includeHsaInNet;
    const save = async (patch) => { Object.assign(state.settings, patch); await DB.setSettings(patch); renderAll(); };
    $('#setFilingStatus').onchange = (e) => save({ filingStatus: e.target.value });
    $('#setIlAllowances').onchange = (e) => save({ ilAllowances: num(e.target.value) });
    $('#setW4Deductions').onchange = (e) => save({ w4: { ...s.w4, deductions: num(e.target.value) } });
    $('#setW4Credits').onchange = (e) => save({ w4: { ...s.w4, credits: num(e.target.value) } });
    $('#setIncludeHsa').onchange = (e) => save({ includeHsaInNet: e.target.checked });
    renderHousehold(); renderAssumptions(); renderTaxTables();
    $('#importBtn').onclick = () => $('#importInput').click();
    $('#importInput').onchange = (e) => onImport(e, false);
    $('#addManualBtn').onclick = () => openPeriodModal(null);
    $('#exportBackupBtn').onclick = onExportBackup;
    $('#importBackupBtn').onclick = () => $('#importBackupInput').click();
    $('#importBackupInput').onchange = onImportBackup;
    $('#clearAllBtn').onclick = onClearAll;
  }
  function renderHousehold() {
    const h = state.settings.household || {};
    const fields = [['spouseWages', 'Spouse wages ($/yr)'], ['spouseWithheld', 'Spouse fed withheld ($/yr)'],
      ['secondJobWages', '2nd job wages ($/yr)'], ['secondJobWithheld', '2nd job fed withheld ($/yr)'],
      ['interest', 'Interest income ($/yr)'], ['dividends', 'Dividends ($/yr)'], ['capGains', 'Long-term cap gains ($/yr)'],
      ['itemizedDeductions', 'Itemized deductions ($, if > standard)'], ['taxCredits', 'Tax credits e.g. Child Tax Credit ($/yr)']];
    $('#householdForm').innerHTML = fields.map(([k, l]) => `<label>${l}<input type="number" data-hk="${k}" value="${h[k] || ''}" step="any"></label>`).join('');
    $$('#householdForm input').forEach((inp) => inp.onchange = async () => { state.settings.household[inp.dataset.hk] = num(inp.value); await DB.setSetting('household', state.settings.household); renderAll(); });
  }
  function renderAssumptions() {
    const s = state.settings;
    const fields = [['tsp.currentBalance', 'TSP balance today ($)', s.tsp.currentBalance], ['tsp.annualIncome', 'Annual income ($)', s.tsp.annualIncome],
      ['tsp.contributionPct', 'TSP contribution (%)', s.tsp.contributionPct * 100], ['tsp.expectedRor', 'Expected return (%)', s.tsp.expectedRor * 100],
      ['tsp.currentAge', 'Current age', s.tsp.currentAge], ['tsp.retirementAge', 'Retirement age', s.tsp.retirementAge],
      ['fers.high3', 'FERS high-3 salary ($)', s.fers.high3], ['fers.yearsOfService', 'Years of service at retirement', s.fers.yearsOfService]];
    $('#assumptionsForm').innerHTML = fields.map(([k, l, v]) => `<label>${l}<input type="number" data-k="${k}" value="${v}" step="any"></label>`).join('') +
      `<label class="checkbox"><input type="checkbox" data-k="fers.survivorBenefit" ${s.fers.survivorBenefit ? 'checked' : ''}> FERS survivor benefit (−10%)</label>`;
    $$('#assumptionsForm input').forEach((inp) => inp.onchange = async () => {
      const [g, k] = inp.dataset.k.split('.'); let v = inp.type === 'checkbox' ? inp.checked : num(inp.value);
      if (['contributionPct', 'expectedRor', 'incomeGrowth'].includes(k)) v = v / 100;
      state.settings[g][k] = v; await DB.setSetting(g, state.settings[g]); renderPlan();
    });
  }
  function renderTaxTables() {
    const yr = state.taxYear || 2026; const t = T.tableFor(yr);
    $('#taxTableEditor').innerHTML = `<p class="hint">Showing ${yr}. Standard deduction (${state.settings.filingStatus}): <b>${usd(t.standardDeduction[state.settings.filingStatus])}</b> · IL exemption ${usd(t.ilExemptionPerAllowance)} · SS wage base ${usd(t.ssWageBase)}. These ship pre-loaded and cited; edit in code/backup if the IRS revises them. ${explain('Tax table sources', [
      { label: 'Federal brackets & standard deduction', plain: 'Year-keyed from the IRS releases.', formula: `${yr} ${state.settings.filingStatus} std deduction = ${usd(t.standardDeduction[state.settings.filingStatus])}`, value: t.standardDeduction[state.settings.filingStatus], cite: yr >= 2026 ? 'brackets2026' : 'brackets2025' },
      { label: 'Illinois', plain: 'Flat 4.95% with a per-exemption allowance.', formula: `exemption = ${usd(t.ilExemptionPerAllowance)}`, value: t.ilExemptionPerAllowance, cite: 'ilTax' },
    ])}</p>`;
  }

  // ---- import (PDF + .doc), with confirm step ----------------------
  function readText(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); }); }
  function readBuf(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file); }); }

  async function onImport(e, fromOnboarding) {
    const files = Array.from(e.target.files || []); if (!files.length) return;
    const status = fromOnboarding ? null : $('#importStatus');
    if (status) status.textContent = `Reading ${files.length} file(s)…`;
    const elPeriods = []; let other = null;
    try {
      for (const f of files) {
        if (/\.pdf$/i.test(f.name)) {
          const buf = await readBuf(f); const res = await ELParse.parseAnyPdf(buf, f.name);
          if (res.type === 'el' && res.data) elPeriods.push(res.data);
          else if (res.type === 'w2' || res.type === '1040') other = res;
        } else { const txt = await readText(f); const p = ELParse.parse(txt); if (p.id) elPeriods.push(p); }
      }
      if (elPeriods.length) {
        const lowConf = elPeriods.some((p) => p.lowConfidence);
        if (lowConf && elPeriods.length === 1) { openConfirmEl(elPeriods[0]); }
        else {
          const r = await DB.importPeriods(elPeriods.filter((p) => p.id));
          state.periods = await DB.allPeriods();
          if (!state.currentId && state.periods.length) { state.currentId = state.periods[state.periods.length - 1].id; state.taxYear = DB.payYear(currentPeriod()); }
          if (status) status.textContent = `Imported ${r.added} statement(s).`;
          toast(`Imported ${r.added} statement(s)`);
        }
      }
      if (other) openConfirmOther(other);
      if (fromOnboarding) { state.settings.onboarded = true; await DB.setSetting('onboarded', true); document.body.dataset.view = 'dashboard'; wireSettings(); }
      renderAll();
    } catch (err) { if (status) status.textContent = 'Import failed: ' + err.message; toast('Import failed: ' + err.message); }
    e.target.value = '';
  }

  function openConfirmEl(p) {
    $('#confirmTitle').textContent = 'Confirm imported paycheck';
    $('#confirmHint').textContent = 'PDF parsing is approximate — check these against your statement, then save.';
    const f = [['id', 'ID'], ['gross', 'Gross'], ['fedTax', 'Federal tax'], ['ilTax', 'IL tax'], ['oasdi', 'Social Security'], ['medicare', 'Medicare'], ['retirement', 'FERS'], ['tsp', 'TSP'], ['fehb', 'FEHB'], ['dental', 'Dental'], ['net', 'Net']];
    $('#confirmBody').innerHTML = f.map(([k, l]) => `<label>${l}<input data-ck="${k}" value="${p[k] != null ? p[k] : ''}"></label>`).join('');
    $('#confirmSaveBtn').onclick = async () => {
      $$('#confirmBody input').forEach((inp) => { const k = inp.dataset.ck; p[k] = k === 'id' ? inp.value : num(inp.value); });
      if (!p.id) { toast('Need a valid ID like 2025-PP25'); return; }
      await DB.upsertPeriod(p); state.periods = await DB.allPeriods(); state.currentId = p.id; state.taxYear = DB.payYear(p);
      $('#confirmModal').hidden = true; renderAll(); toast('Saved ' + p.id);
    };
    $('#confirmModal').hidden = false;
  }
  function openConfirmOther(res) {
    const d = res.data;
    if (res.type === 'w2') {
      $('#confirmTitle').textContent = 'W-2 imported';
      $('#confirmHint').textContent = 'Apply this W-2 to your household 2nd-job fields (your FEMA pay already comes from the E&L imports).';
      const f = [['box1Wages', 'Box 1 wages'], ['fedWithheld', 'Fed withheld'], ['stateWithheld', 'IL withheld'], ['tspTraditional', 'TSP (box 12 D)'], ['hsa', 'HSA (box 12 W)'], ['qualifiedOt', 'Qualified OT (box 14)']];
      $('#confirmBody').innerHTML = f.map(([k, l]) => `<label>${l}<input data-ck="${k}" value="${d[k] != null ? d[k] : ''}"></label>`).join('');
      $('#confirmSaveBtn').textContent = 'Apply to 2nd job';
      $('#confirmSaveBtn').onclick = async () => {
        const vals = {}; $$('#confirmBody input').forEach((inp) => vals[inp.dataset.ck] = num(inp.value));
        state.settings.household.secondJobWages = vals.box1Wages; state.settings.household.secondJobWithheld = vals.fedWithheld; state.settings.household.secondJobIlWithheld = vals.stateWithheld;
        await DB.setSetting('household', state.settings.household);
        $('#confirmModal').hidden = true; wireSettings(); renderAll(); toast('Applied W-2 to household');
      };
    } else {
      $('#confirmTitle').textContent = 'Last year\'s 1040';
      $('#confirmHint').textContent = 'Reference only — use these to fill the optional Household fields. (This app predicts; it does not refile your return.)';
      const f = [['agi', 'AGI'], ['taxableIncome', 'Taxable income'], ['totalTax', 'Total tax']];
      $('#confirmBody').innerHTML = f.map(([k, l]) => `<label>${l}<input value="${d[k] != null ? usd(d[k]) : '—'}" disabled></label>`).join('');
      $('#confirmSaveBtn').textContent = 'Got it';
      $('#confirmSaveBtn').onclick = () => ($('#confirmModal').hidden = true);
    }
    $('#confirmModal').hidden = false;
  }

  async function onExportBackup() {
    const data = await DB.exportBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `taxplanner-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url); toast('Backup downloaded');
  }
  async function onImportBackup(e) {
    const file = e.target.files[0]; if (!file) return;
    try { const obj = JSON.parse(await readText(file)); await DB.importBackup(obj);
      state.settings = await DB.getSettings(); state.periods = await DB.allPeriods();
      state.currentId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
      state.taxYear = state.currentId ? DB.payYear(currentPeriod()) : null;
      wireSettings(); renderAll(); toast('Backup restored');
    } catch (err) { toast('Restore failed: ' + err.message); }
    e.target.value = '';
  }
  async function onClearAll() {
    if (!confirm('Delete all paychecks and settings? Cannot be undone.')) return;
    await DB.clearAll(); state.settings = await DB.getSettings(); state.periods = []; state.currentId = null; state.taxYear = null;
    document.body.dataset.view = 'onboarding'; wireSettings(); renderAll(); toast('All data cleared');
  }

  // ---- manual period modal -----------------------------------------
  const PFIELDS = [['year', 'Year', 'number'], ['pp', 'Pay period #', 'number'], ['periodStart', 'Period start', 'date'], ['periodEnd', 'Period end', 'date'],
    ['gross', 'Gross pay', 'number'], ['hours', 'Hours', 'number'], ['fehb', 'FEHB', 'number'], ['dental', 'Dental', 'number'],
    ['hsa', 'HSA/pre-tax', 'number'], ['retirement', 'FERS retirement', 'number'], ['tsp', 'TSP', 'number'], ['rothTsp', 'Roth TSP', 'number'],
    ['oasdi', 'Social Security', 'number'], ['medicare', 'Medicare', 'number'], ['fedTax', 'Federal tax', 'number'], ['ilTax', 'IL tax', 'number'],
    ['overtime', 'Overtime pay', 'number'], ['flsa', 'FLSA OT pay', 'number']];
  let editingId = null;
  function openPeriodModal(id) {
    editingId = id; const p = id ? state.periods.find((x) => x.id === id) : {};
    $('#periodModalTitle').textContent = id ? `Edit ${id}` : 'Add paycheck';
    $('#periodDeleteBtn').style.display = id ? '' : 'none';
    $('#periodForm').innerHTML = PFIELDS.map(([k, l, t]) => `<label class="${k === 'periodStart' || k === 'periodEnd' ? 'full' : ''}">${l}<input data-k="${k}" type="${t}" value="${p[k] != null ? p[k] : ''}" step="any"></label>`).join('');
    $('#periodModal').hidden = false;
  }
  async function savePeriodModal() {
    const obj = { source: 'manual' };
    $$('#periodForm input').forEach((inp) => { obj[inp.dataset.k] = inp.type === 'number' ? num(inp.value) : inp.value; });
    if (!obj.year || !obj.pp) { toast('Year and pay period # required'); return; }
    obj.id = `${obj.year}-PP${String(obj.pp).padStart(2, '0')}`;
    if (obj.periodEnd) { const d = new Date(obj.periodEnd); d.setDate(d.getDate() + 12); obj.payDate = d.toISOString().slice(0, 10); }
    obj.ytd = obj.ytd || {}; obj.agency = obj.agency || {};
    await DB.upsertPeriod(obj); state.periods = await DB.allPeriods(); state.currentId = obj.id; state.taxYear = DB.payYear(obj);
    $('#periodModal').hidden = true; renderAll(); toast('Saved ' + obj.id);
  }
  async function deletePeriodModal() {
    if (!editingId || !confirm('Delete ' + editingId + '?')) return;
    await DB.deletePeriod(editingId); state.periods = await DB.allPeriods();
    state.currentId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
    state.taxYear = state.currentId ? DB.payYear(currentPeriod()) : null;
    $('#periodModal').hidden = true; renderAll(); toast('Deleted');
  }

  boot();
})();
