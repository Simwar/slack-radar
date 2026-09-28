import { CONFIG } from "./config";
import { getWatchedChannelIds, recordWatchedChannel } from "./db";
import { joinChannel } from "./slack";

/**
 * Put the bot in the channels it is meant to watch, so nobody has to /invite it
 * to each one by hand.
 *
 * WHY IT LIVES IN THE SWEEP. Joining needs a Slack token, and the agent
 * container does not have one — `SLACK_BOT_TOKEN` is claimed by the messaging
 * adapter and routed to the sidecar. The ingestion jobs carry their own
 * (`RADAR_SLACK_BOT_TOKEN`), so this is the only place in the system that can
 * both read the channel list and call Slack.
 *
 * WHY THE LIST IS A SEPARATE INPUT. `observe_channel_ids` lives in the
 * sidecar's `SLACK_CONFIG`, which reaches neither the agent nor the ingestion
 * containers — checked, not assumed. And `watched_channels` is no help: it is
 * populated when a message is first observed, which cannot happen until the bot
 * is already in the channel. So the list has to be handed to us.
 * `scripts/deploy.sh` sets this from the same WATCHED_CHANNEL_IDS that builds
 * the sidecar config, so one variable still drives both.
 *
 * Private channels cannot be self-joined — conversations.join is public-only —
 * so those still need one manual invite each. That is a Slack limit, not a
 * choice, and it is reported per channel rather than retried silently.
 */

/** Slack error code → what the deployer should actually do about it. */
const HINTS: Record<string, string> = {
  // Easy to hit: `ast project configure` does not prompt for ingestion-scoped
  // inputs (docs/CLI-ISSUES.md #2), so this job is easy to leave tokenless.
  not_authed:
    "no Slack token reached this job — set RADAR_SLACK_BOT_TOKEN, e.g. RADAR_SLACK_BOT_TOKEN=xoxb-... scripts/deploy.sh",
  invalid_auth: "the Slack token was rejected — it may have been revoked or rotated",
  missing_scope:
    "the bot token lacks the channels:join scope — add it and reinstall the Slack app",
  method_not_supported_for_channel_type:
    "private channel — conversations.join is public-only, so invite the bot by hand once",
  channel_not_found:
    "no such channel in this workspace, or it is private and the bot cannot see it",
  is_archived: "the channel is archived",
};

/**
 * Log-safe status, printed every run next to the judge's and the scorer's.
 *
 * Printed even when the feature is off, on purpose. Auto-join exists to make
 * onboarding less fiddly, and an onboarding feature that is silent when
 * misconfigured is the worst kind: "nothing happened" reads identically to
 * "nothing needed to happen", and someone waits for a join that was never
 * going to come.
 */
export function describeAutojoin(): string {
  const n = CONFIG.autojoinChannelIds().length;
  return n
    ? `${n} channel(s) configured`
    : "DISABLED (RADAR_AUTOJOIN_CHANNEL_IDS is empty) — the bot must be invited by hand";
}

export interface JoinStats {
  attempted: number;
  joined: number;
  failed: number;
}

export async function joinConfiguredChannels(): Promise<JoinStats> {
  const empty: JoinStats = { attempted: 0, joined: 0, failed: 0 };

  const configured = CONFIG.autojoinChannelIds();
  if (!configured.length) return empty;

  // A channel already in watched_channels is one the bot is in: the row is
  // written either by the ingest path on the first observed message, or by this
  // function on a successful join. Either way there is nothing to do, and this
  // is what stops a join call per channel on every 15-minute tick.
  const known = await getWatchedChannelIds();
  const todo = configured.filter((id) => !known.has(id));
  if (!todo.length) return empty;

  let joined = 0;
  let failed = 0;

  for (const channelId of todo) {
    const res = await joinChannel(channelId);
    if (res.ok) {
      // watch_since defaults to NOW(), which is the honest horizon: the radar
      // should not reason about discussions that started before it could see
      // them. ON CONFLICT DO NOTHING so an existing row keeps its original
      // watch_since rather than having history quietly re-cut under it.
      await recordWatchedChannel(channelId, res.name);
      joined++;
      console.log(
        `[slack-radar] joined ${res.name ? `#${res.name}` : channelId} — now watching it`,
      );
      continue;
    }
    failed++;
    const hint = HINTS[res.error];
    console.warn(
      `[slack-radar] could not join ${channelId}: ${res.error}${hint ? ` — ${hint}` : ""}`,
    );
  }

  return { attempted: todo.length, joined, failed };
}
