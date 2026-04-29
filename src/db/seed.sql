-- ============================================================
-- PlayGM Static-Reference Seed (run AFTER schema.sql)
-- ============================================================
-- Loads the static / design-driven reference data that is NOT
-- populated from TheSportsDB. Sports data (leagues, teams,
-- players, games, standings) comes from `npm run populate`.
--
-- Tables seeded here:
--   scout_card_definitions   → 150-card library (mirror of src/data/scoutCardLibrary.ts)
--   avatar_items             → avatar catalog (mirror of src/data/avatarCatalog.ts)
--   trivia_questions         → SAMPLE only; real content lives in Cowork
--                               and is synced via a separate one-way job.
--
-- This file is a *minimal* seed kit — the Scout-card and avatar tables
-- are loaded from a small representative subset for first-boot testing.
-- The full library import is generated from the TS source in a later
-- migration (see DATA_ARCHITECTURE.md → "How to apply the schema").
-- ============================================================

-- ─── Scout Card Definitions (representative sample) ────────────────────────
INSERT INTO scout_card_definitions (id, name, flavor, rarity, affinity_tag, category, logic) VALUES
  ('ab_scouts_choice_1', 'Scout''s Choice Lvl 1', 'Highlights one recommended player per position during drafts.', 'rare',      'Ability:Draft',     'ABILITY',   '{"highlights":1,"perPosition":true,"level":1}'),
  ('ab_scouts_choice_2', 'Scout''s Choice Lvl 2', 'Highlights two recommended players per position.',                 'rare',      'Ability:Draft',     'ABILITY',   '{"highlights":2,"perPosition":true,"level":2}'),
  ('ab_scouts_choice_3', 'Scout''s Choice Lvl 3', 'Top three picks highlighted with ratings.',                        'legendary', 'Ability:Draft',     'ABILITY',   '{"highlights":3,"perPosition":true,"level":3}'),
  ('ab_radar',           'The Radar',             'Reveals which free agents are playing tonight.',                    'rare',      'Ability:FreeAgent', 'ABILITY',   '{"revealTonightLineup":true}'),
  ('ab_vault',           'The Vault',             'Reduces your card cooldown by 12 hours when played.',                'legendary', 'Ability:Cooldown',  'ABILITY',   '{"reduceCooldownHours":12}'),
  ('ab_energy_drink',    'Energy Drink',          'Restores +1 energy to a card of your choice.',                       'rare',      'Ability:Energy',    'ABILITY',   '{"restoreEnergy":1}'),
  ('attr_jersey_23',     'Jersey #23',            'Boosts any player wearing #23 by +5% Rating this week.',             'rare',      'Jersey:23',         'ATTRIBUTE', '{"jerseyNumber":23,"nerBoostPct":5}'),
  ('attr_jersey_30',     'Jersey #30',            'Boosts any player wearing #30 by +5% Rating this week.',             'rare',      'Jersey:30',         'ATTRIBUTE', '{"jerseyNumber":30,"nerBoostPct":5}'),
  ('attr_city_boston',   'City: Boston',          'Players whose team plays in Boston earn +5% Rating.',                'common',    'City:Boston',       'ATTRIBUTE', '{"city":"Boston","nerBoostPct":5}'),
  ('role_starter',       'Starter',               'A starting-lineup player earns +10% Rating this week.',              'common',    'Role:Starter',      'ROLE',      '{"role":"starter","nerBoostPct":10}'),
  ('event_playoffs',     'Playoff Hunter',        'A player on a team in the playoff hunt earns +15% Rating.',          'rare',      'Event:Playoff',     'EVENT',     '{"playoffHunt":true,"nerBoostPct":15}')
ON CONFLICT (id) DO UPDATE
  SET name        = EXCLUDED.name,
      flavor      = EXCLUDED.flavor,
      rarity      = EXCLUDED.rarity,
      logic       = EXCLUDED.logic;

-- ─── Avatar Items (default Scout + a starter purchase) ─────────────────────
INSERT INTO avatar_items (id, name, emoji, category, price_pp, rarity, description, is_default) VALUES
  ('avatar_scout_default', 'The Scout',     '🦊',  'alternateAvatar', 0,    'common', 'Default Scout the Fox avatar.',                  TRUE),
  ('avatar_scout_pro',     'Pro Scout',     '🦊',  'alternateAvatar', 250,  'rare',   'Scout in pro-team kit.',                         FALSE),
  ('jersey_home_blue',     'Home Blue',     '👕',  'jersey',          50,   'common', 'Classic home jersey overlay.',                   FALSE),
  ('headband_red',         'Game-Day Red',  '🩹',  'headband',        25,   'common', 'Red headband for grind days.',                   FALSE),
  ('frame_gold',           'Gold Frame',    '🏆',  'frame',           500,  'legendary', 'Earned by reaching MVP rank.',                FALSE),
  ('badge_first_draft',    'First Draft',   '🎯',  'badge',           0,    'common', 'Earned: completed first weekly draft.',          FALSE)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, emoji = EXCLUDED.emoji, price_pp = EXCLUDED.price_pp;

-- ─── Trivia Questions (SAMPLE — real content lives in Cowork) ─────────────
-- The `source_question_id` is null here because these are local samples;
-- real Cowork-sourced rows will carry the Cowork id. The Cowork sync job
-- upserts on source_question_id; these samples will not collide.
INSERT INTO trivia_questions (sport, category, question, choices, correct_idx, difficulty) VALUES
  ('basketball', 'rules',   'How many points does a 3-pointer score?',                                       '["1","2","3","4"]', 2, 'easy'),
  ('basketball', 'history', 'Which team has won the most NBA championships?',                                '["Lakers","Celtics","Bulls","Warriors"]', 1, 'medium'),
  ('football',   'rules',   'How many points is a touchdown worth?',                                          '["4","5","6","7"]', 2, 'easy'),
  ('football',   'rules',   'How many players are on the field for one team in football?',                    '["9","10","11","12"]', 2, 'easy'),
  ('baseball',   'rules',   'How many strikes result in an out in baseball?',                                  '["2","3","4","5"]', 1, 'easy'),
  ('hockey',     'rules',   'How many players from one team are on the ice during regular play?',             '["4","5","6","7"]', 2, 'easy'),
  ('soccer',     'rules',   'How many players are on the field for one team in soccer?',                      '["9","10","11","12"]', 2, 'easy')
ON CONFLICT DO NOTHING;
