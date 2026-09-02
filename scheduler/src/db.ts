import { Pool } from "pg";
import type {
  DiscussionRow,
  JudgedMatch,
  MessageRow,
  PendingDigestRow,
  TeamRow,
} from "./types";

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT ? Number(process.env.POSTGRES_PORT) : 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  connectionTimeoutMillis: 3000,
});

pool.on("error", (err) => console.error("[slack-radar] idle pg client error:", err.message));

const TRANSIENT_PG = new Set(["57P03", "57P01", "57P02", "53300", "08000", "08001", "08003", "08004", "08006"]);
const TRANSIENT_NET = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EPIPE"]);

function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (!code) return true; // connection-terminated errors carry no code; treat as transient
  return TRANSIENT_PG.has(code) || TRANSIENT_NET.has(code);
}

export async function assertConnection(): Promise<void> {
  // The managed Postgres is briefly unavailable during its own redeploys.
  // Retry that; fail fast on genuine misconfig (auth, bad db name).
  const attempts = 6;
  for (let i = 1; ; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (!isTransientDbError(err) || i >= attempts) throw err;
      const delay = Math.min(500 * 2 ** (i - 1), 8000);
      console.warn(
        `[slack-radar] db connect failed (attempt ${i}/${attempts}), retry in ${delay}ms:`,
        (err as Error).message,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Mirrors agent/registry.ts. Effective topics are the seeded list plus what
// leads added over DM, minus what they removed.
const EFFECTIVE_TOPICS_SQL = `
  ARRAY(
    SELECT DISTINCT topic FROM (
      SELECT unnest(t.topics) AS topic
      UNION
      SELECT o.topic FROM team_topic_overrides o
        WHERE o.team_key = t.key AND o.removed = FALSE
    ) s
    WHERE topic NOT IN (
      SELECT topic FROM team_topic_overrides r
        WHERE r.team_key = t.key AND r.removed = TRUE
    )
  )`;

export async function getTeams(): Promise<TeamRow[]> {
  const { rows } = await pool.query<TeamRow>(
    `SELECT t.key, t.name, t.description, t.lead_slack_ids,
            ${EFFECTIVE_TOPICS_SQL} AS topics,
            t.keywords, t.home_channel_ids, t.realtime_enabled, t.min_confidence
       FROM teams t
      ORDER BY t.key`,
  );
  return rows;
}

/**
 * Discussions worth spending a judge call on.
 *
 * "Ripe" means one of two things: the thread has gone quiet for `quietMinutes`
 * (it has said what it is going to say), or it has crossed `burstMessages`
 * while still live (something is kicking off and waiting would be too late).
 *
 * A discussion is re-judged only once it has grown by `escalationFactor` since
 * the last pass, so a thread that rumbles on all day is scored a handful of
 * times, not once per tick.
 */
export async function getRipeDiscussions(opts: {
  quietMinutes: number;
  burstMessages: number;
  minAgeMinutes: number;
  maxAgeHours: number;
  escalationFactor: number;
  limit: number;
}): Promise<DiscussionRow[]> {
  const { rows } = await pool.query<DiscussionRow>(
    `SELECT d.id::text, d.channel_id, w.channel_name, d.root_ts,
            d.first_message_at, d.last_message_at, d.message_count,
            d.participants, d.last_scored_count
       FROM discussions d
       JOIN watched_channels w ON w.channel_id = d.channel_id
      WHERE d.first_message_at >= w.watch_since
        AND d.last_message_at > NOW() - ($4 || ' hours')::interval
        AND d.first_message_at < NOW() - ($3 || ' minutes')::interval
        AND (
              d.last_message_at < NOW() - ($1 || ' minutes')::interval
           OR d.message_count >= $2
        )
        AND (
              d.last_scored_at IS NULL
           OR d.message_count >= GREATEST(d.last_scored_count * $5, d.last_scored_count + 3)
        )
      ORDER BY d.last_message_at DESC
      LIMIT $6`,
    [
      String(opts.quietMinutes),
      opts.burstMessages,
      String(opts.minAgeMinutes),
      String(opts.maxAgeHours),
      opts.escalationFactor,
      opts.limit,
    ],
  );
  return rows;
}

export async function getDiscussionMessages(
  channelId: string,
  rootTs: string,
  limit: number,
): Promise<MessageRow[]> {
  const { rows } = await pool.query<MessageRow>(
    `SELECT ts, user_id, text, posted_at
       FROM messages
      WHERE channel_id = $1 AND thread_ts = $2
      ORDER BY posted_at ASC
      LIMIT $3`,
    [channelId, rootTs, limit],
  );
  return rows;
}

export async function markScored(discussionId: string, messageCount: number): Promise<void> {
  await pool.query(
    `UPDATE discussions SET last_scored_at = NOW(), last_scored_count = $2 WHERE id = $1`,
    [discussionId, messageCount],
  );
}

/**
 * Record a judged match. ON CONFLICT DO NOTHING is deliberate: once a
 * (discussion, team) pair has been raised, a re-score on escalation must not
 * reset notified_at and fire a second DM about the same thread.
 */
export async function insertMatch(
  discussionId: string,
  m: JudgedMatch,
  suppression?: { reason: string },
): Promise<{ id: string } | null> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO discussion_matches
       (discussion_id, team_key, signal_type, confidence, urgency, headline, rationale,
        suppressed, suppressed_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (discussion_id, team_key) DO NOTHING
     RETURNING id::text`,
    [
      discussionId,
      m.team_key,
      m.signal_type,
      m.confidence,
      m.urgency,
      m.headline,
      m.rationale,
      Boolean(suppression),
      suppression?.reason ?? null,
    ],
  );
  return rows[0] ?? null;
}

/**
 * Record a team the judge deliberately did not flag.
 *
 * Written as a suppressed row so every existing query (all of which filter
 * `suppressed = FALSE`) ignores it, while the decision itself survives. This is
 * what makes "why wasn't I told about X?" answerable and recall measurable —
 * previously a decline was a log line that scrolled away.
 */
export async function insertDecline(
  discussionId: string,
  teamKey: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO discussion_matches
       (discussion_id, team_key, signal_type, confidence, urgency, headline, rationale,
        suppressed, suppressed_reason)
     VALUES ($1,$2,'declined',0,'normal','','',TRUE,$3)
     ON CONFLICT (discussion_id, team_key) DO NOTHING`,
    [discussionId, teamKey, reason],
  );
}

export async function markNotified(matchId: string): Promise<void> {
  await pool.query(`UPDATE discussion_matches SET notified_at = NOW() WHERE id = $1`, [matchId]);
}

export async function markDigestSent(matchIds: string[]): Promise<void> {
  if (!matchIds.length) return;
  await pool.query(
    `UPDATE discussion_matches SET digest_sent_at = NOW() WHERE id = ANY($1::bigint[])`,
    [matchIds],
  );
}

export async function recordNotification(row: {
  matchId: string;
  leadSlackId: string;
  dmChannelId: string;
  dmTs: string;
  mode: "realtime" | "digest";
}): Promise<void> {
  await pool.query(
    `INSERT INTO notifications (match_id, lead_slack_id, dm_channel_id, dm_ts, mode)
     VALUES ($1,$2,$3,$4,$5)`,
    [row.matchId, row.leadSlackId, row.dmChannelId, row.dmTs, row.mode],
  );
}

/** Matches raised but not yet delivered by either path. */
export async function getPendingDigestMatches(): Promise<PendingDigestRow[]> {
  const { rows } = await pool.query<PendingDigestRow>(
    `SELECT m.id::text AS match_id, m.team_key, t.name AS team_name, t.lead_slack_ids,
            m.signal_type, m.urgency, m.confidence, m.headline, m.rationale,
            d.channel_id, w.channel_name, d.root_ts, d.message_count
       FROM discussion_matches m
       JOIN teams t ON t.key = m.team_key
       JOIN discussions d ON d.id = m.discussion_id
       LEFT JOIN watched_channels w ON w.channel_id = d.channel_id
      WHERE m.notified_at IS NULL
        AND m.digest_sent_at IS NULL
        AND m.suppressed = FALSE
      ORDER BY t.name, m.confidence DESC`,
  );
  return rows;
}

export async function getLeadPrefs(): Promise<
  Map<string, { realtime: boolean; pausedUntil: Date | null }>
> {
  const { rows } = await pool.query<{
    slack_user_id: string;
    realtime: boolean;
    paused_until: Date | null;
  }>(`SELECT slack_user_id, realtime, paused_until FROM lead_prefs`);
  return new Map(
    rows.map((r) => [r.slack_user_id, { realtime: r.realtime, pausedUntil: r.paused_until }]),
  );
}

/**
 * Per-(team, channel) share of delivered notifications a lead marked as noise.
 *
 * This is the feedback loop. A pairing that keeps getting thumbs-downed has to
 * clear a higher confidence bar next time, which means the system gets quieter
 * where it is wrong without anyone editing a config file. Pairings with too
 * few ratings to mean anything are left alone.
 */
export async function getNoiseRates(
  minSamples: number,
): Promise<Map<string, { rate: number; samples: number }>> {
  const { rows } = await pool.query<{
    team_key: string;
    channel_id: string;
    samples: string;
    noise: string;
  }>(
    `SELECT m.team_key, d.channel_id,
            COUNT(*)::text AS samples,
            COUNT(*) FILTER (WHERE n.feedback = 'noise')::text AS noise
       FROM notifications n
       JOIN discussion_matches m ON m.id = n.match_id
       JOIN discussions d ON d.id = m.discussion_id
      WHERE n.feedback IS NOT NULL
        AND n.created_at > NOW() - INTERVAL '60 days'
      GROUP BY m.team_key, d.channel_id
     HAVING COUNT(*) >= $1`,
    [minSamples],
  );
  return new Map(
    rows.map((r) => [
      `${r.team_key}|${r.channel_id}`,
      { rate: Number(r.noise) / Number(r.samples), samples: Number(r.samples) },
    ]),
  );
}

export async function getUnratedNotifications(
  hours: number,
): Promise<{ id: string; dm_channel_id: string; dm_ts: string }[]> {
  const { rows } = await pool.query<{ id: string; dm_channel_id: string; dm_ts: string }>(
    `SELECT id::text, dm_channel_id, dm_ts
       FROM notifications
      WHERE feedback IS NULL
        AND created_at > NOW() - ($1 || ' hours')::interval`,
    [String(hours)],
  );
  return rows;
}

export async function setFeedback(id: string, feedback: "useful" | "noise"): Promise<void> {
  await pool.query(
    `UPDATE notifications SET feedback = $2, feedback_at = NOW() WHERE id = $1`,
    [id, feedback],
  );
}

/**
 * Drop raw message text past the retention window. The radar only needs recent
 * text to judge live discussions; matches and notifications (which carry no
 * message bodies) are what stay. Keeping a rolling copy of every channel
 * indefinitely is a liability nobody asked for.
 */
export async function purgeOldMessages(days: number): Promise<number> {
  const res = await pool.query(
    `DELETE FROM messages WHERE posted_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return res.rowCount ?? 0;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
