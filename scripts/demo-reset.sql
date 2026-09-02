-- Reset slack-radar to a clean pre-demo state.
--
-- WHY THIS EXISTS: matches are raise-once. `UNIQUE(discussion_id, team_key)`
-- plus `ON CONFLICT DO NOTHING` guarantees a lead is never told about the same
-- thread twice — which is correct in production and ruinous in rehearsal. The
-- second time you post your demo message, nothing happens, and it looks broken.
-- Run this between every rehearsal and again immediately before going live.
--
-- KEEPS the registry: teams, team_topic_overrides. Those are your demo setup
-- and re-bootstrapping from TEAMS_CONFIG only happens when the table is empty.
--
-- CLEARS everything observed or derived, including watched_channels — so
-- watch_since is re-stamped from the first message of the new run and nothing
-- from the rehearsal is in scope.
--
-- Usage against the local dev Postgres:
--   docker exec -i <postgres-container> psql -U <user> -d <db> < scripts/demo-reset.sql
-- Find the container with `docker ps | grep postgres`.

BEGIN;

-- Order matters only for readability; the FKs cascade from discussions and
-- discussion_matches, but being explicit makes the row counts below honest.
DELETE FROM notifications;
DELETE FROM discussion_matches;
DELETE FROM discussions;
DELETE FROM messages;
DELETE FROM watched_channels;

-- Delivery preferences a lead set during a rehearsal ("mute me for the
-- afternoon") would silently suppress the live run. This is the single most
-- confusing way for a demo to fail, so it is cleared too.
DELETE FROM lead_prefs;

COMMIT;

-- Confirm the reset and show what survived. teams should be non-zero; if it is
-- zero, no team has been registered yet — nothing can ever be notified.
SELECT 'teams (kept)'          AS table, COUNT(*) AS rows FROM teams
UNION ALL SELECT 'topic overrides (kept)', COUNT(*) FROM team_topic_overrides
UNION ALL SELECT 'messages',               COUNT(*) FROM messages
UNION ALL SELECT 'discussions',            COUNT(*) FROM discussions
UNION ALL SELECT 'matches',                COUNT(*) FROM discussion_matches
UNION ALL SELECT 'notifications',          COUNT(*) FROM notifications
UNION ALL SELECT 'watched channels',       COUNT(*) FROM watched_channels
UNION ALL SELECT 'lead prefs',             COUNT(*) FROM lead_prefs;
