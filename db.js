/*
 * db.js — Dexie schema + data access. window.DB. Fully local IndexedDB.
 *   periods  : normalized E&L periods (PK id "YYYY-PPNN"), indexed year, payDate
 *   settings : key/value (filing status, W-4, IL allowances, projection assumptions)
 */
(function () {
  'use strict';

  const db = new Dexie('TaxPlanner');
  db.version(1).stores({
    periods: 'id, year, payDate, periodStart',
    settings: 'key',
  });

  // Generic placeholders only — the user enters real figures in Settings,
  // which are stored locally (never committed). Keep this repo free of any
  // personal financial data.
  const DEFAULT_SETTINGS = {
    filingStatus: 'MFJ',          // MFJ | Single | HoH
    w4: { deductions: 0, credits: 0 },
    ilAllowances: 0,
    includeHsaInNet: false,
    onboarded: false,
    hourlyContext: { hoursPerPeriod: 80 },
    // Optional household inputs (predictor, not tax-prep). All default 0 so the
    // FEMA-only path is unchanged; the user fills what applies.
    household: {
      spouseWages: 0, spouseWithheld: 0,
      secondJobWages: 0, secondJobWithheld: 0, secondJobIlWithheld: 0,
      interest: 0, dividends: 0, capGains: 0,
      otherAdjustments: 0, itemizedDeductions: 0, taxCredits: 0,
      ilAllowances: null,
    },
    // Scenario knobs
    hsaPerPeriod: 0,
    extraTspPct: 0,
    // Retirement projection assumptions
    tsp: {
      currentBalance: 0,
      annualIncome: 100000,
      contributionPct: 0.10,
      expectedRor: 0.08,
      incomeGrowth: 0.035,
      currentAge: 35,
      retirementAge: 62,
    },
    fers: {
      high3: 100000,
      yearsOfService: 20,
      retirementAge: 62,
      survivorBenefit: true,
    },
  };

  async function getSettings() {
    const rows = await db.settings.toArray();
    const stored = {};
    rows.forEach((r) => (stored[r.key] = r.value));
    return deepMerge(structuredCloneSafe(DEFAULT_SETTINGS), stored);
  }
  async function setSetting(key, value) {
    await db.settings.put({ key, value });
  }
  async function setSettings(obj) {
    await db.transaction('rw', db.settings, async () => {
      for (const [k, v] of Object.entries(obj)) await db.settings.put({ key: k, value: v });
    });
  }

  async function allPeriods() {
    return (await db.periods.toArray()).sort((a, b) =>
      (a.periodStart || '').localeCompare(b.periodStart || '')
    );
  }
  async function getPeriod(id) {
    return db.periods.get(id);
  }
  async function upsertPeriod(p) {
    if (!p.id) throw new Error('period needs an id');
    p.updatedAt = new Date().toISOString();
    await db.periods.put(p);
    return p;
  }
  async function deletePeriod(id) {
    await db.periods.delete(id);
  }
  // Import parsed E&L periods. Existing ids are overwritten unless they were
  // hand-edited (source 'manual') — those are preserved.
  async function importPeriods(parsed) {
    let added = 0, skipped = 0;
    await db.transaction('rw', db.periods, async () => {
      for (const p of parsed) {
        const existing = await db.periods.get(p.id);
        if (existing && existing.source === 'manual') { skipped++; continue; }
        await db.periods.put({ ...p, updatedAt: new Date().toISOString() });
        added++;
      }
    });
    return { added, skipped };
  }

  // YTD rollup for a given paydate-year (the agency buckets by check date).
  async function periodsForYear(year) {
    const all = await allPeriods();
    return all.filter((p) => payYear(p) === year);
  }
  function payYear(p) {
    return p.payDate ? +p.payDate.slice(0, 4) : p.year;
  }

  // Backup / restore (JSON).
  async function exportBackup() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      periods: await db.periods.toArray(),
      settings: await db.settings.toArray(),
    };
  }
  async function importBackup(obj) {
    await db.transaction('rw', db.periods, db.settings, async () => {
      if (obj.periods) { await db.periods.clear(); await db.periods.bulkPut(obj.periods); }
      if (obj.settings) { await db.settings.clear(); await db.settings.bulkPut(obj.settings); }
    });
  }
  async function clearAll() {
    await db.transaction('rw', db.periods, db.settings, async () => {
      await db.periods.clear();
      await db.settings.clear();
    });
  }

  function deepMerge(base, over) {
    for (const k of Object.keys(over)) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
        base[k] = deepMerge(base[k] || {}, over[k]);
      } else base[k] = over[k];
    }
    return base;
  }
  function structuredCloneSafe(o) {
    return JSON.parse(JSON.stringify(o));
  }

  window.DB = {
    db, DEFAULT_SETTINGS,
    getSettings, setSetting, setSettings,
    allPeriods, getPeriod, upsertPeriod, deletePeriod, importPeriods,
    periodsForYear, payYear,
    exportBackup, importBackup, clearAll,
  };
})();
