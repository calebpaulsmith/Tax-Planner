# Paycheck & Tax Planner

A fully-local, no-server **Progressive Web App** that turns your federal
**Earnings & Leave (E&L)** statements into a trustworthy **tax predictor** —
not tax-prep software. It explains every number, cites the rule, and drives a
few real decisions. All data stays in your browser (IndexedDB); nothing is ever
uploaded.

## What it answers

- **Where my money goes** — per-paycheck waterfall (gross → every deduction →
  net), category breakdown, and YTD totals including the **agency match**.
- **My real tax rate** — a **bracket-fill graphic** (your brackets filling as
  income pours in, with the marginal band and "$ to the next jump"), an all-in
  effective rate, and a "where each gross dollar goes" bar with **category
  toggles**.
- **Overtime reality (OBBBA)** — only the **premium half** of FLSA overtime is
  deductible from federal income tax for 2025–2028; the app estimates your
  qualified-OT and the deduction (prefers your W-2 figure when imported).
- **The three decisions** — should I **increase my HSA** to stay under a
  bracket, **contribute more to TSP**, or switch **Roth ↔ Traditional TSP**?
  Each is a live tool with before/after numbers.
- **Will I owe?** — an annualized federal + IL estimate (refund or balance due),
  sharpened by optional household fields (spouse, 2nd job, investments).
- **A printable Report** of highlights and recommendations.

### Explainable + cited
Every key figure has a **"how is this computed?"** disclosure showing the
plain-English step, the **formula with your actual numbers**, the inputs and
their source, and — only when you expand it — the **rule and citation**
(FLSA/OBBBA, IRS Pub 15-T, the 2025/2026 brackets, Illinois, TSP, HSA). The
citation registry lives in [`cites.js`](cites.js).

## Architecture (PWA now, iOS later)

All math lives in a **pure** engine, [`tax.js`](tax.js) (`window.TaxCalc`) — no
DOM, no DB, no I/O. That makes it portable: the **same engine** can run inside a
native SwiftUI iOS app via **JavaScriptCore**, with native UI on top. The
contract is locked by [`fixtures/test-vectors.json`](fixtures/test-vectors.json),
a self-contained set of `{input, expected}` cases that both the web harness and
a future Swift `XCTest` run — so the engine can never drift across platforms.

| File | Role |
| --- | --- |
| `tax.js` | Pure engine. Tax tables are editable, year-keyed data (2023–2026). |
| `cites.js` | Citation registry (rule → title, url, retrieved date, quote). |
| `parse.js` | Imports E&L `.doc` and **PDF** (E&L AD-334, W-2 form fields, 1040 summary) via pdf.js. |
| `db.js` | Dexie/IndexedDB data layer. No personal data in defaults. |
| `app.js` | UI, router, rendering, explain disclosures, bracket-fill, decisions, report. IIFE. |
| `sw.js` / `manifest.json` / `icons/` | PWA plumbing. |
| `scripts/verify.js` | Node harness — 60 checks vs. statement ground truth + the test vectors. |

## Importing your data

Settings → **Import**:
- **E&L** (`.doc` or PDF) → per-paycheck history. The `.doc` export parses
  exactly; the PDF (USDA AD-334) is best-effort and shows a confirm-and-edit step.
- **W-2** PDF → reads the named form fields (wages, withholding, box 12 D/W,
  state) to fill your household 2nd-job fields.
- **Prior-year 1040** PDF → reads the return summary (AGI / taxable / total tax)
  as a reference to help you fill the optional household fields.

You can also add a paycheck manually, and export/import a JSON backup.

## Data privacy

Your statements, returns, W-2s, 1099s, and any backup are **git-ignored**
(`data/`, `*.xlsx`, `*.doc`, `*.pdf`). Nothing financial is committed; the app
has no network or auth.

## Local development

```
python -m http.server 8766 --directory .
node scripts/verify.js     # 60 checks; place E&L .doc files in data/ for the ground-truth loop
```

Open http://localhost:8766. The service worker needs HTTPS or localhost.

## Tax tables & accuracy

Federal withholding (Pub 15-T), 1040 income-tax + long-term-gains brackets, the
standard deduction, Social-Security wage base, and Illinois figures are seeded
for 2023–2026 from the IRS/IL releases and shown (with sources) in Settings →
Tax tables. The 2026 figures reflect the IRS Rev. Proc. release. This is a
predictor — not tax advice; verify against your actual return.
