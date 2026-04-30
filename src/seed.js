/**
 * Seed players into the DB by searching thesportsdb by name.
 *
 * Usage:
 *   node src/seed.js "Lionel Messi" "Erling Haaland" "LeBron James"
 */

require('dotenv').config();
const { searchPlayers } = require('./api/sportsdb');
const { upsertPlayer }  = require('./models/player');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed(names) {
  if (names.length === 0) {
    console.log('Usage: node src/seed.js "Player Name" [...]');
    return;
  }

  for (const name of names) {
    console.log(`Searching for "${name}"…`);
    await sleep(1100);

    const results = await searchPlayers(name);
    if (results.length === 0) {
      console.log(`  not found\n`);
      continue;
    }

    // Pick best match (first result)
    const p = results[0];
    const id = upsertPlayer({
      sportsdb_id: p.idPlayer,
      name:        p.strPlayer,
      team:        p.strTeam,
      sport:       p.strSport,
      nationality: p.strNationality,
      position:    p.strPosition,
    });
    console.log(`  saved: ${p.strPlayer} (${p.strSport} / ${p.strTeam}) → local id ${id}\n`);
  }
}

seed(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
