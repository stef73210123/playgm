/**
 * playgm — entry point
 *
 * Starts the cron scheduler that fires the morning refresh job.
 * Default schedule: 07:00 every day (overridable via REFRESH_CRON in .env).
 *
 * Usage:
 *   node src/index.js          # run the scheduler (long-lived process)
 *   node src/jobs/morningRefresh.js   # one-shot manual run
 */

require('dotenv').config();
const cron = require('node-cron');
const { run } = require('./jobs/morningRefresh');

const SCHEDULE = process.env.REFRESH_CRON || '0 7 * * *';

console.log(`playgm scheduler starting — morning refresh cron: "${SCHEDULE}"`);
console.log('Next run:', nextRunDescription(SCHEDULE));

cron.schedule(SCHEDULE, async () => {
  console.log(`[cron] Morning refresh triggered at ${new Date().toISOString()}`);
  try {
    await run();
  } catch (err) {
    console.error('[cron] Refresh error:', err);
  }
});

function nextRunDescription(cronExpr) {
  try {
    // Give a human hint without a heavy library
    const parts = cronExpr.split(' ');
    if (parts.length === 5 && parts[0] !== '*' && parts[1] !== '*') {
      const [min, hour] = parts;
      return `daily at ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }
    return cronExpr;
  } catch {
    return cronExpr;
  }
}
