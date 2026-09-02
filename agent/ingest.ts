import type { PlatformContext } from '@astropods/adapter-core';
import { getPool, withDbRetry } from './db';

// Slack tops out around 40k characters per message; anything past a couple of
// thousand is boilerplate (pasted logs, stack traces) that adds cost to the
// judge without adding signal.
const MAX_TEXT = 4000;

/**
 * Persist one observed Slack message and fold it into its discussion.
 *
 * This is the whole ingest path. It runs inside the always-on agent container,
 * on the adapter's pre-model hook, and makes NO model call — the sidecar is
 * already streaming us every message in every watched channel, so writing them
 * down costs one INSERT. All the expensive thinking happens later, in the
 * scheduled sweep, on discussions that have gone quiet.
 *
 * Note the sidecar drops anything with a Slack `bot_id` before forwarding, so
 * app-posted messages (alerts, CI, Zapier) never reach us. Discussions kicked
 * off by a bot alert are therefore only seen from the first human reply on.
 */
export async function recordObservedMessage(
  ctx: PlatformContext,
  text: string,
): Promise<void> {
  const channelId = ctx.channelId;
  const ts = ctx.messageId;
  if (!channelId || !ts) return;

  // threadRootId is set only for replies inside an existing thread; a top-level
  // message is its own discussion root.
  const rootTs = ctx.threadRootId || ts;
  const userId = ctx.userId ?? null;
  const postedAt = new Date(parseFloat(ts) * 1000);
  if (Number.isNaN(postedAt.getTime())) return;

  const pool = getPool();

  await withDbRetry(async () => {
    // watch_since is the floor the sweep scores from, so inviting the bot to a
    // channel with a year of history does not produce a year of notifications.
    //
    // It is stamped with THIS MESSAGE'S posted_at, not NOW(). Using NOW() looks
    // equivalent and is not: posted_at comes from the Slack ts, so it is always
    // a beat earlier than the moment we write the row. The sweep then requires
    // `first_message_at >= watch_since`, and the very first message in a newly
    // watched channel failed that test by the width of the delivery lag — it
    // was recorded and then never scored, permanently. Reproduced against
    // Postgres with a 1.5s lag: 0 ripe discussions.
    //
    // Anchoring to posted_at keeps the anti-backfill guarantee (nothing older
    // than the first message we actually saw is in scope) and makes that first
    // message eligible.
    await pool.query(
      `INSERT INTO watched_channels (channel_id, channel_name, watch_since)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel_id) DO UPDATE
         SET last_seen_at = NOW(),
             channel_name = COALESCE(EXCLUDED.channel_name, watched_channels.channel_name)`,
      [channelId, ctx.channelName ?? null, postedAt.toISOString()],
    );

    const inserted = await pool.query(
      `INSERT INTO messages (channel_id, ts, thread_ts, user_id, text, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (channel_id, ts) DO NOTHING`,
      [channelId, ts, rootTs, userId, text.slice(0, MAX_TEXT), postedAt.toISOString()],
    );

    // Redelivery of a message we already have must not inflate message_count —
    // that count is what decides whether a thread looks like it is escalating.
    if (!inserted.rowCount) return;

    await pool.query(
      `INSERT INTO discussions
         (channel_id, root_ts, first_message_at, last_message_at, message_count, participants)
       VALUES ($1, $2, $3, $3, 1, CASE WHEN $4::text IS NULL THEN '{}'::text[] ELSE ARRAY[$4::text] END)
       ON CONFLICT (channel_id, root_ts) DO UPDATE SET
         first_message_at = LEAST(discussions.first_message_at, EXCLUDED.first_message_at),
         last_message_at  = GREATEST(discussions.last_message_at, EXCLUDED.last_message_at),
         message_count    = discussions.message_count + 1,
         participants     = CASE
           WHEN $4::text IS NULL OR $4::text = ANY(discussions.participants)
             THEN discussions.participants
           ELSE array_append(discussions.participants, $4::text)
         END`,
      [channelId, rootTs, postedAt.toISOString(), userId],
    );
  }, 'record message');
}
