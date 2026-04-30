const fetch = require('node-fetch');
require('dotenv').config();

const API_KEY = process.env.SPORTSDB_API_KEY || '3';
const BASE = `https://www.thesportsdb.com/api/v1/json/${API_KEY}`;

// Thin wrapper — respects the free-tier rate limit (≈1 req/s)
async function get(endpoint) {
  const url = `${BASE}/${endpoint}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`sportsdb ${endpoint} → HTTP ${res.status}`);
  return res.json();
}

// Lookup a player by their sportsdb id
async function lookupPlayer(sportsdbId) {
  const data = await get(`lookupplayer.php?id=${sportsdbId}`);
  return data.players ? data.players[0] : null;
}

// Search players by name — used when seeding new players
async function searchPlayers(name) {
  const data = await get(`searchplayers.php?p=${encodeURIComponent(name)}`);
  return data.player || [];
}

// Last 5 events for a team (used to find a player's most recent result)
async function lastTeamEvents(teamId) {
  const data = await get(`eventslast.php?id=${teamId}`);
  return data.results || [];
}

// Lookup a single event by id
async function lookupEvent(eventId) {
  const data = await get(`lookupevent.php?id=${eventId}`);
  return data.events ? data.events[0] : null;
}

// All events for a player (v2, requires paid key — falls back gracefully)
async function playerEvents(sportsdbId) {
  try {
    const data = await get(`searchevents.php?id=${sportsdbId}`);
    return data.event || [];
  } catch {
    return [];
  }
}

module.exports = { lookupPlayer, searchPlayers, lastTeamEvents, lookupEvent, playerEvents };
