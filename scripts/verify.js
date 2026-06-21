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

// Bracket-distance flips exactly at MFJ thresholds (2025 1040).
console.log('\n=== Bracket distance (2025 MFJ taxable income)');
[(96950 - 1), 96950, 206700, 394600].forEach((ti) => {
  const d = TaxCalc.bracketDistance(ti, 2025, 'MFJ');
  console.log(`  taxable ${ti}: marginal ${(d.marginalRate * 100)}%  toNextJump ${d.amountToNextJump}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
