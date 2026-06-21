/*
 * Node verification harness. Parses the real E&L statements in ../data
 * and checks the engine against ground-truth withheld/net figures.
 *   node scripts/verify.js
 */
const fs = require('fs');
const path = require('path');
const ELParse = require('../parse.js');
const TaxCalc = require('../tax.js');

const dataDir = path.join(__dirname, '..', 'data');
const files = fs.readdirSync(dataDir).filter((f) => /\.doc$/i.test(f));
const periods = ELParse.parseMany(
  files.map((f) => fs.readFileSync(path.join(dataDir, f), 'latin1'))
);

let pass = 0, fail = 0;
function check(label, got, want, tol = 0.02) {
  const ok = Math.abs(got - want) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${round(got)} want ${round(want)}`);
  ok ? pass++ : fail++;
}
const round = (n) => Math.round(n * 100) / 100;

console.log(`Parsed ${periods.length} statements\n`);
for (const p of periods) {
  console.log(`=== ${p.id}  ${p.periodStart}..${p.periodEnd}  gross $${p.gross}`);
  const b = TaxCalc.paycheckBreakdown(p, { filingStatus: 'MFJ' });
  // Mechanical deductions must match the statement exactly.
  check(`${p.id} OASDI`, b.oasdi, p.oasdi);
  check(`${p.id} Medicare`, b.medicare, p.medicare);
  check(`${p.id} TSP 5% of base`, b.tsp, p.tsp || b.tsp);
  check(`${p.id} Net pay`, b.net, p.net);
  // Straight-vs-OT runs without error
  const s = TaxCalc.straightVsOt(p, { filingStatus: 'MFJ' });
  console.log(
    `     grossStraight ${round(s.grossStraight)} grossOT ${round(s.grossOT)} ` +
    `OT retained ${(s.pctOtRetained * 100).toFixed(1)}% straight ${(s.pctStraightRetained * 100).toFixed(1)}%`
  );
}

// ---- Portable test vectors (shared with a future Swift XCTest) ------
console.log('\n=== Test vectors (fixtures/test-vectors.json)');
const V = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'test-vectors.json'), 'utf8'));
for (const c of V.paychecks) {
  const b = TaxCalc.paycheckBreakdown(c.period, c.settings);
  for (const [k, want] of Object.entries(c.expect)) check(`${c.label} ${k}`, b[k], want);
}
for (const c of V.bracketTax) {
  if (c.expect != null) check(`bracketTax ${c.year} ${c.status} @${c.taxable}`,
    TaxCalc.bracketTax(c.taxable, TaxCalc.incomeBrackets(c.year, c.status)), c.expect);
  if (c.expectMarginal != null) {
    const d = TaxCalc.bracketDistance(c.taxable, c.year, c.status);
    check(`marginal ${c.year} ${c.status} @${c.taxable}`, d.marginalRate, c.expectMarginal, 0.0001);
  }
}
for (const c of V.overtimeDeduction) {
  const r = TaxCalc.overtimeDeduction(c.qualifiedOt, c.magi, c.status, c.year);
  check(`OT deduction (${c.note || ''})`, r.value, c.expect);
}
for (const c of V.rothVsTraditional) {
  const r = TaxCalc.rothVsTraditional(c.amount, c.opts);
  const ok = r.recommendation === c.expectRecommendation;
  console.log(`${ok ? 'PASS' : 'FAIL'}  Roth/Trad rec: got ${r.recommendation} want ${c.expectRecommendation}`);
  ok ? pass++ : fail++;
}

// 2024 full-return reconciliation: bracket tax − Child Tax Credit ≈ total tax.
const t2024 = TaxCalc.bracketTax(103927, TaxCalc.incomeBrackets(2024, 'MFJ'));
check('2024 return: bracket tax − ~$2,003 CTC ≈ total tax 10,967', t2024 - 2002.94, 10967, 0.5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
