# Paycheck & Tax Planner

A fully-local, no-server **Progressive Web App** that turns federal
**Earnings & Leave (E&L) statements** into paycheck analysis, real tax-rate
insight, what-if scenarios, and retirement projections. A spinoff of the
Maxiflex Timecard app, built on the same vanilla-JS + Dexie + GitHub Pages
pattern (no build step). All data stays in your browser (IndexedDB).

## What it answers

- **Where my money goes** — per-paycheck waterfall (gross → every deduction →
  net), category breakdown, and year-to-date totals including the **agency
  match** (employer benefits) from your statements.
- **My real tax rate** — federal marginal vs. all-in effective rate, a bracket
  ladder showing exactly where you sit and **how far you are below the next
  jump**, and the **overtime/bonus reality**: what fraction of OT you actually
  keep vs. straight pay (OT stacks on top of your income, so it's taxed at your
  marginal rate).
- **Will I owe?** — annualized estimate vs. the standard deduction → projected
  federal + IL refund or balance due. Plus HSA / extra-TSP **what-if sliders**.
- **The future** — TSP future-value projection and FERS basic-annuity estimate,
  with editable assumptions.

## Files

| File | Role |
| --- | --- |
| `index.html` | App shell; views toggled by `body[data-view]`; registers the SW. |
| `styles.css` | iOS-flavored, dark-first, safe-area insets. |
| `tax.js` | Pure engine `window.TaxCalc`. All formulas ported from `Pay Calculations.xlsx`. Tax tables are editable, year-keyed data. No DOM/DB. |
| `parse.js` | `window.ELParse` — E&L `.doc` (HTML table) → normalized period. Pure. |
| `db.js` | Dexie schema + data access `window.DB`. |
| `app.js` | UI, view router, rendering. Wrapped in an IIFE. |
| `sw.js` / `manifest.json` / `icons/` | PWA plumbing. |
| `scripts/verify.js` | Node harness: checks the engine against the real statements' ground-truth net/withholding. |

## Data privacy

Your statements, spreadsheet, and any backup JSON are **git-ignored** (`data/`,
`*.xlsx`, `*.doc`). Nothing financial is ever committed. The app runs entirely
client-side; there is no network/auth.

## Local development

```
python -m http.server 8766 --directory .
```

Open http://localhost:8766. The service worker needs HTTPS or localhost.

Verify the engine against the real statements (place them in `data/`):

```
node scripts/verify.js
```

## Importing your pay data

Settings → **Import E&L statements (.doc)** — select one or more statement files
(downloaded from your agency's E&L portal). They parse automatically into the
per-pay-period history. You can also **add a paycheck manually** or edit any
imported one. Use **Export / Import backup** to move data between devices.

## Tax tables

Federal withholding (IRS Pub 15-T) and 1040 income-tax brackets, the standard
deduction, the Social-Security wage base, and Illinois figures are seeded for
2023–2026 and are **editable in Settings** so the app survives annual updates.
