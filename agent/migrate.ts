import { getPool, withDbRetry } from './db';

// Arbitrary constant so concurrent/repeat boots serialize the DDL under a
// Postgres advisory lock instead of racing on CREATE INDEX IF NOT EXISTS.
const MIGRATION_LOCK_KEY = 7719034;

const DDL = `
-- Teams and their leads. THIS TABLE IS THE SOURCE OF TRUTH: bootstrapped once
-- from the TEAMS_CONFIG deploy input when empty, then edited live over Slack.
-- Nothing in the repo describes a real deployment (this is a blueprint).
CREATE TABLE IF NOT EXISTS teams (
  key               TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  lead_slack_ids    TEXT[] NOT NULL DEFAULT '{}',
  topics            TEXT[] NOT NULL DEFAULT '{}',
  keywords          TEXT[] NOT NULL DEFAULT '{}',
  -- Channels the team already lives in. A discussion in one of these is not
  -- news to them, so it is never matched to this team.
  home_channel_ids  TEXT[] NOT NULL DEFAULT '{}',
  realtime_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  min_confidence    REAL NOT NULL DEFAULT 0.6,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Slack-authored additions/removals, kept OUT of teams.topics so a re-bootstrap
-- (or a TEAMS_CONFIG change) never clobbers what a lead tuned by DM.
-- Effective topics = teams.topics + overrides(removed=false) - overrides(removed=true).
CREATE TABLE IF NOT EXISTS team_topic_overrides (
  id          BIGSERIAL PRIMARY KEY,
  team_key    TEXT NOT NULL REFERENCES teams(key) ON DELETE CASCADE,
  topic       TEXT NOT NULL,
  removed     BOOLEAN NOT NULL DEFAULT FALSE,
  added_by    TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_key, topic)
);

-- Per-lead delivery preferences, set by DMing the agent. A row is created
-- lazily the first time a lead changes something; absence means defaults.
CREATE TABLE IF NOT EXISTS lead_prefs (
  slack_user_id  TEXT PRIMARY KEY,
  realtime       BOOLEAN NOT NULL DEFAULT TRUE,
  paused_until   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every channel the bot has observed a message in. watch_since is the floor
-- for scoring: a channel added today must not surface last month's threads.
CREATE TABLE IF NOT EXISTS watched_channels (
  channel_id    TEXT PRIMARY KEY,
  channel_name  TEXT,
  watch_since   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Raw observed messages. Written by the agent container with no LLM call.
CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  user_id     TEXT,
  text        TEXT NOT NULL DEFAULT '',
  posted_at   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(channel_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(channel_id, thread_ts);

-- A discussion is a thread root plus its replies, or a standalone top-level
-- message. Aggregates are maintained on write so the sweep can pick ripe ones
-- with a single indexed query instead of scanning messages.
CREATE TABLE IF NOT EXISTS discussions (
  id                 BIGSERIAL PRIMARY KEY,
  channel_id         TEXT NOT NULL,
  root_ts            TEXT NOT NULL,
  first_message_at   TIMESTAMPTZ NOT NULL,
  last_message_at    TIMESTAMPTZ NOT NULL,
  message_count      INTEGER NOT NULL DEFAULT 0,
  participants       TEXT[] NOT NULL DEFAULT '{}',
  last_scored_at     TIMESTAMPTZ,
  -- message_count at the last scoring pass, so a thread is only re-judged
  -- once it has meaningfully grown (escalation) rather than on every tick.
  last_scored_count  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(channel_id, root_ts)
);
CREATE INDEX IF NOT EXISTS idx_discussions_ripe ON discussions(last_message_at, last_scored_at);

-- One row per (discussion, team) the judge accepted. notified_at is set when
-- it goes out as a realtime DM; digest_sent_at when it goes out in a rollup.
CREATE TABLE IF NOT EXISTS discussion_matches (
  id             BIGSERIAL PRIMARY KEY,
  discussion_id  BIGINT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  team_key       TEXT NOT NULL REFERENCES teams(key) ON DELETE CASCADE,
  signal_type    TEXT NOT NULL,
  confidence     REAL NOT NULL,
  urgency        TEXT NOT NULL,
  headline       TEXT NOT NULL,
  rationale      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at    TIMESTAMPTZ,
  digest_sent_at TIMESTAMPTZ,
  suppressed     BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(discussion_id, team_key)
);
-- Why a match was recorded but never delivered. Populated for both kinds of
-- skip: the judge declining a candidate outright, and a match landing below the
-- team's confidence bar. Without this there is no record of what was considered
-- and rejected, so "why wasn't I told about X?" is unanswerable and recall
-- cannot be measured — the one failure mode the thumbs-down loop cannot see.
ALTER TABLE discussion_matches ADD COLUMN IF NOT EXISTS suppressed_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_matches_skipped
  ON discussion_matches(created_at) WHERE suppressed = TRUE;

CREATE INDEX IF NOT EXISTS idx_matches_pending
  ON discussion_matches(team_key) WHERE notified_at IS NULL AND digest_sent_at IS NULL;

-- One row per DM actually sent, so feedback reactions can be traced back to
-- the match that caused them.
CREATE TABLE IF NOT EXISTS notifications (
  id             BIGSERIAL PRIMARY KEY,
  match_id       BIGINT REFERENCES discussion_matches(id) ON DELETE CASCADE,
  lead_slack_id  TEXT NOT NULL,
  dm_channel_id  TEXT NOT NULL,
  dm_ts          TEXT NOT NULL,
  mode           TEXT NOT NULL,          -- 'realtime' | 'digest'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  feedback       TEXT,                   -- 'useful' | 'noise'
  feedback_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_unrated
  ON notifications(created_at) WHERE feedback IS NULL;
`;

export async function runMigrations(): Promise<void> {
  await withDbRetry(async () => {
    const client = await getPool().connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      try {
        await client.query(DDL);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }, 'migration');
  console.log('[slack-radar] schema ready');
}
