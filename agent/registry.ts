import { getPool, withDbRetry } from './db';

export interface TeamRow {
  key: string;
  name: string;
  description: string;
  lead_slack_ids: string[];
  topics: string[];
  keywords: string[];
  home_channel_ids: string[];
  realtime_enabled: boolean;
  min_confidence: number;
}

/**
 * Effective topics = the seeded teams.topics, plus anything a lead added over
 * DM, minus anything a lead removed. Kept as one SQL expression so every
 * caller (agent tools and the scheduler's prefilter) sees the same view.
 */
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

/** Shape accepted by both TEAMS_CONFIG and the agent's registerTeam tool. */
export interface SeedTeam {
  key: string;
  name?: string;
  description?: string;
  leads?: string[];
  topics?: string[];
  keywords?: string[];
  home_channels?: string[];
  realtime?: boolean;
  min_confidence?: number;
}

const SLACK_USER_RE = /^U[A-Z0-9]+$/i;
const SLACK_CHANNEL_RE = /^[CGD][A-Z0-9]+$/i;

/**
 * IDs from this project's own teams.example.yml.
 *
 * Rejecting these is not paranoia, it is the observed failure: the example file
 * exists so people can paste it into TEAMS_CONFIG, and pasting it verbatim
 * bootstraps a team whose lead is fictional. Everything then works perfectly
 * right up to `conversations.open`, which returns user_not_found — a match is
 * raised, nothing is delivered, and the only trace is one log line in the
 * ingestion workload. The shape is valid, so SLACK_USER_RE cannot catch it.
 *
 * A real ID cannot be verified from this container (the agent holds no Slack
 * token), but the placeholders can be, and they are what actually gets used.
 */
const PLACEHOLDER_ID_RE = /^(U|C|G|D)0*(EXAMPLE|TEST|XXX|1234|0{4,})/i;

/**
 * Create or update a team. The single write path for the registry, used by the
 * TEAMS_CONFIG bootstrap and by the agent's registerTeam tool, so a team made
 * over Slack is indistinguishable from a seeded one.
 *
 * COALESCE on every optional column means a partial update is genuinely partial:
 * "add Ana as a lead" over Slack must not blank out the team's topics because
 * the tool call did not mention them.
 */
export async function upsertTeam(t: SeedTeam): Promise<void> {
  if (!t?.key) throw new Error('team key is required');

  // Reject malformed IDs rather than storing them: a bad lead ID fails later at
  // conversations.open, by which point the match is already marked delivered
  // and nobody is ever told.
  const leads = (t.leads ?? []).map((l) => l.trim()).filter(Boolean);
  const badLeads = leads.filter((l) => !SLACK_USER_RE.test(l));
  if (badLeads.length) {
    throw new Error(
      `not Slack user IDs: ${badLeads.join(', ')}. A lead must be an ID like U012ABCDEF, not a handle — find it via the member's Slack profile, "Copy member ID".`,
    );
  }
  const placeholderLeads = leads.filter((l) => PLACEHOLDER_ID_RE.test(l));
  if (placeholderLeads.length) {
    throw new Error(
      `${placeholderLeads.join(', ')} looks like a placeholder from teams.example.yml, not a real user. Slack will reject it with user_not_found and no notification will ever arrive. Replace it with a real Slack user ID ("Copy member ID" on the member's profile).`,
    );
  }

  const allChannels = (t.home_channels ?? []).map((c) => c.trim()).filter(Boolean);
  const badChannels = allChannels.filter((c) => !SLACK_CHANNEL_RE.test(c));
  if (badChannels.length) throw new Error(`not Slack channel IDs: ${badChannels.join(', ')}`);

  // Placeholder home channels are DROPPED, not fatal — unlike a placeholder
  // lead. The failure modes are not comparable: a fake lead means nobody can
  // ever be notified, while a fake home channel only means the team is not
  // quietened somewhere it should be. Rejecting the whole team over the latter
  // would leave a deployment with no registry at all, which is strictly worse.
  const placeholderChannels = allChannels.filter((c) => PLACEHOLDER_ID_RE.test(c));
  const channels = allChannels.filter((c) => !PLACEHOLDER_ID_RE.test(c));
  if (placeholderChannels.length) {
    console.warn(
      `[slack-radar] team ${t.key}: ignoring placeholder home_channels ${placeholderChannels.join(', ')} — replace them with real channel IDs or this team will not be quietened in its own channels`,
    );
  }

  await withDbRetry(
    () =>
      getPool().query(
        // Every placeholder is explicitly cast. Without it Postgres infers '{}'
        // as text rather than text[] and the whole statement fails with
        // "column lead_slack_ids is of type text[] but expression is of type
        // text" — which only shows up at runtime, never at typecheck.
        `INSERT INTO teams (key, name, description, lead_slack_ids, topics, keywords,
                            home_channel_ids, realtime_enabled, min_confidence, updated_at)
         VALUES ($1::text,
                 COALESCE($2::text, $1::text),
                 COALESCE($3::text, ''),
                 COALESCE($4::text[], '{}'::text[]),
                 COALESCE($5::text[], '{}'::text[]),
                 COALESCE($6::text[], '{}'::text[]),
                 COALESCE($7::text[], '{}'::text[]),
                 COALESCE($8::boolean, TRUE),
                 COALESCE($9::real, 0.6),
                 NOW())
         ON CONFLICT (key) DO UPDATE SET
           name             = COALESCE($2::text, teams.name),
           description      = COALESCE($3::text, teams.description),
           lead_slack_ids   = COALESCE($4::text[], teams.lead_slack_ids),
           topics           = COALESCE($5::text[], teams.topics),
           keywords         = COALESCE($6::text[], teams.keywords),
           home_channel_ids = COALESCE($7::text[], teams.home_channel_ids),
           realtime_enabled = COALESCE($8::boolean, teams.realtime_enabled),
           min_confidence   = COALESCE($9::real, teams.min_confidence),
           updated_at       = NOW()`,
        [
          t.key,
          t.name ?? null,
          t.description?.trim() ?? null,
          leads.length ? leads : null,
          t.topics?.length ? t.topics.map(String) : null,
          t.keywords?.length ? t.keywords.map((k) => String(k).toLowerCase()) : null,
          channels.length ? channels : null,
          t.realtime ?? null,
          t.min_confidence ?? null,
        ],
      ),
    `upsert team ${t.key}`,
  );
}

export async function listTeams(): Promise<TeamRow[]> {
  const { rows } = await withDbRetry(
    () =>
      getPool().query<TeamRow>(
        `SELECT t.key, t.name, t.description, t.lead_slack_ids,
                ${EFFECTIVE_TOPICS_SQL} AS topics,
                t.keywords, t.home_channel_ids, t.realtime_enabled, t.min_confidence
           FROM teams t
          ORDER BY t.key`,
      ),
    'list teams',
  );
  return rows;
}

export async function teamsForLead(slackUserId: string): Promise<TeamRow[]> {
  const all = await listTeams();
  return all.filter((t) => t.lead_slack_ids.includes(slackUserId));
}

export async function addTopics(
  teamKey: string,
  topics: string[],
  addedBy: string,
): Promise<number> {
  let n = 0;
  for (const topic of topics.map((t) => t.trim()).filter(Boolean)) {
    const res = await withDbRetry(
      () =>
        getPool().query(
          `INSERT INTO team_topic_overrides (team_key, topic, removed, added_by, updated_at)
           VALUES ($1, $2, FALSE, $3, NOW())
           ON CONFLICT (team_key, topic) DO UPDATE
             SET removed = FALSE, added_by = EXCLUDED.added_by, updated_at = NOW()`,
          [teamKey, topic, addedBy],
        ),
      'add topic',
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

export async function removeTopics(
  teamKey: string,
  topics: string[],
  removedBy: string,
): Promise<number> {
  let n = 0;
  for (const topic of topics.map((t) => t.trim()).filter(Boolean)) {
    const res = await withDbRetry(
      () =>
        getPool().query(
          `INSERT INTO team_topic_overrides (team_key, topic, removed, added_by, updated_at)
           VALUES ($1, $2, TRUE, $3, NOW())
           ON CONFLICT (team_key, topic) DO UPDATE
             SET removed = TRUE, added_by = EXCLUDED.added_by, updated_at = NOW()`,
          [teamKey, topic, removedBy],
        ),
      'remove topic',
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

export async function setLeadPrefs(
  slackUserId: string,
  prefs: { realtime?: boolean; pauseHours?: number },
): Promise<void> {
  const pausedUntil =
    prefs.pauseHours && prefs.pauseHours > 0
      ? new Date(Date.now() + prefs.pauseHours * 3600_000).toISOString()
      : null;
  await withDbRetry(
    () =>
      getPool().query(
        `INSERT INTO lead_prefs (slack_user_id, realtime, paused_until, updated_at)
         VALUES ($1, COALESCE($2, TRUE), $3, NOW())
         ON CONFLICT (slack_user_id) DO UPDATE SET
           realtime     = COALESCE($2, lead_prefs.realtime),
           paused_until = CASE WHEN $4 THEN $3 ELSE lead_prefs.paused_until END,
           updated_at   = NOW()`,
        [slackUserId, prefs.realtime ?? null, pausedUntil, prefs.pauseHours !== undefined],
      ),
    'set lead prefs',
  );
}

export interface MatchSummary {
  team_key: string;
  signal_type: string;
  urgency: string;
  confidence: number;
  headline: string;
  rationale: string;
  channel_id: string;
  root_ts: string;
  last_message_at: Date;
  message_count: number;
}

export async function recentMatches(
  teamKeys: string[],
  hours: number,
  limit = 20,
): Promise<MatchSummary[]> {
  const { rows } = await withDbRetry(
    () =>
      getPool().query<MatchSummary>(
        `SELECT m.team_key, m.signal_type, m.urgency, m.confidence, m.headline, m.rationale,
                d.channel_id, d.root_ts, d.last_message_at, d.message_count
           FROM discussion_matches m
           JOIN discussions d ON d.id = m.discussion_id
          WHERE ($1::text[] IS NULL OR m.team_key = ANY($1))
            AND m.created_at > NOW() - ($2 || ' hours')::interval
            AND m.suppressed = FALSE
          ORDER BY m.created_at DESC
          LIMIT $3`,
        [teamKeys.length ? teamKeys : null, String(hours), limit],
      ),
    'recent matches',
  );
  return rows;
}

export interface SkippedItem {
  team_key: string;
  signal_type: string;
  confidence: number;
  headline: string;
  suppressed_reason: string | null;
  channel_id: string;
  root_ts: string;
  created_at: Date;
  root_text: string | null;
}

/**
 * Discussions the radar considered and did NOT notify anyone about, with the
 * reason. Backs "why didn't you tell me about X?".
 *
 * This is the recall side of the ledger. Precision has the thumbs-down loop;
 * without this, a lead who suspects the radar missed something has no way to
 * find out whether it was never seen, seen and declined, or scored just under
 * the bar — and neither does anyone tuning it.
 */
export async function skippedItems(
  query: string | null,
  hours: number,
  limit = 15,
): Promise<SkippedItem[]> {
  const { rows } = await withDbRetry(
    () =>
      getPool().query<SkippedItem>(
        `SELECT m.team_key, m.signal_type, m.confidence, m.headline, m.suppressed_reason,
                d.channel_id, d.root_ts, m.created_at,
                (SELECT text FROM messages
                  WHERE channel_id = d.channel_id AND ts = d.root_ts) AS root_text
           FROM discussion_matches m
           JOIN discussions d ON d.id = m.discussion_id
          WHERE m.suppressed = TRUE
            AND m.created_at > NOW() - ($2 || ' hours')::interval
            AND (
                  $1::text IS NULL
               OR EXISTS (SELECT 1 FROM messages mm
                           WHERE mm.channel_id = d.channel_id
                             AND mm.thread_ts = d.root_ts
                             AND mm.text ILIKE '%' || $1 || '%')
            )
          ORDER BY m.created_at DESC
          LIMIT $3`,
        [query, String(hours), limit],
      ),
    'skipped items',
  );
  return rows;
}

export interface MessageHit {
  channel_id: string;
  thread_ts: string;
  text: string;
  posted_at: Date;
}

/**
 * Plain substring search over observed messages. Deliberately not semantic:
 * this backs a "did anyone mention X?" question from a lead, where an exact
 * term match is what they mean and an embedding index is not worth its upkeep.
 */
export async function searchMessages(
  query: string,
  hours: number,
  limit = 15,
): Promise<MessageHit[]> {
  const { rows } = await withDbRetry(
    () =>
      getPool().query<MessageHit>(
        `SELECT channel_id, thread_ts, text, posted_at
           FROM messages
          WHERE text ILIKE '%' || $1 || '%'
            AND posted_at > NOW() - ($2 || ' hours')::interval
          ORDER BY posted_at DESC
          LIMIT $3`,
        [query, String(hours), limit],
      ),
    'search messages',
  );
  return rows;
}
