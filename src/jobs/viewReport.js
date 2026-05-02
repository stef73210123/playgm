#!/usr/bin/env node
/**
 * Print the diff report for a given date (defaults to today).
 * Usage:
 *   npm run report              # today
 *   npm run report -- 2026-05-01
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const reportsDir = path.resolve(process.env.REPORTS_DIR || './reports');
const filePath   = path.join(reportsDir, `${date}.json`);

if (!fs.existsSync(filePath)) {
  console.log(`No diff report found for ${date}.`);
  console.log(`Expected path: ${filePath}`);
  console.log('Run "npm run refresh" to generate one.');
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(filePath, 'utf8'));

console.log(`\n=== DFF Diff Report — ${report.date} ===`);
console.log(`Refreshed at : ${report.refreshed_at}`);
console.log(`Players      : ${report.total_players} total, ${report.updated} updated, ${report.failed} failed`);

if (!report.changes || report.changes.length === 0) {
  console.log('\nNo stat changes detected.\n');
  process.exit(0);
}

console.log(`\n── Changes (${report.changes.length} player${report.changes.length > 1 ? 's' : ''}) ──────────────────────────`);
report.changes.forEach(({ player, diff }) => {
  console.log(`\n  ${player}`);
  diff.forEach(({ field, from, to }) => {
    const label = field.replace(/_/g, ' ');
    console.log(`    ${label.padEnd(22)} ${String(from ?? '—').padStart(10)} → ${to ?? '—'}`);
  });
});
console.log('\n────────────────────────────────────────────\n');
