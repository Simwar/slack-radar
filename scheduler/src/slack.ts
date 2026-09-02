import { WebClient } from "@slack/web-api";

// Integration- and provider-scoped vars do not reach ingestion containers, so
// the sweep and digest jobs carry their own bot token input.
//
// The SLACK_BOT_TOKEN fallback matters in practice: `ast project configure` does
// not prompt for ingestion-scoped inputs, so RADAR_SLACK_BOT_TOKEN is easy to
// end up without — and the failure is silent in the worst way. The sweep judges
// correctly, writes the match, then cannot open a DM, so a lead is never told
// and the match is already marked raised. Falling back to the adapter's token
// (same xoxb- value) means a half-configured deploy still delivers.
//
// The reliable way to set it explicitly is a deploy var, not configure:
//   RADAR_SLACK_BOT_TOKEN=xoxb-… scripts/deploy.sh
const token = process.env.RADAR_SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error(
    "[slack-radar] no RADAR_SLACK_BOT_TOKEN or SLACK_BOT_TOKEN — matches will be raised but no DM can be sent.",
  );
}
const client = new WebClient(token);

const dmChannelCache = new Map<string, string>();

/**
 * Resolve (and cache) the DM channel for a user. conversations.open is
 * idempotent - it returns the existing DM rather than creating a second one -
 * but it is still a call per lead per run, and the ID never changes.
 */
export async function openDM(userId: string): Promise<string | null> {
  const cached = dmChannelCache.get(userId);
  if (cached) return cached;
  try {
    const res = await client.conversations.open({ users: userId });
    const id = res.channel?.id;
    if (!id) return null;
    dmChannelCache.set(userId, id);
    return id;
  } catch (err) {
    lastSlackError = (err as { data?: { error?: string } })?.data?.error ?? "unknown";
    // user_not_found almost always means a placeholder or mistyped lead ID in
    // the registry, so say so rather than leaving someone to guess at a raw
    // Slack error code in an ingestion log.
    const hint =
      lastSlackError === "user_not_found"
        ? " — that lead ID does not exist in this workspace; fix it with registerTeam"
        : "";
    console.error(`[slack-radar] cannot DM ${userId}: ${lastSlackError}${hint}`);
    return null;
  }
}

/**
 * The Slack error code from the most recent failed call.
 *
 * Delivery happens two layers below the span that should record the failure,
 * and threading a result type through every call site is more churn than this
 * is worth. Read it immediately after a call that returned null.
 */
let lastSlackError: string | null = null;
export function takeLastSlackError(): string | null {
  const e = lastSlackError;
  lastSlackError = null;
  return e;
}

export async function postDM(channelId: string, text: string): Promise<string | null> {
  try {
    const res = await client.chat.postMessage({
      channel: channelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
    return (res.ts as string) ?? null;
  } catch (err) {
    lastSlackError = (err as { data?: { error?: string } })?.data?.error ?? "unknown";
    console.error(`[slack-radar] chat.postMessage failed for ${channelId}: ${lastSlackError}`);
    return null;
  }
}

const permalinkCache = new Map<string, string>();

/**
 * Exact permalink for a message. Falls back to the /archives/ form, which is
 * what the API returns anyway and resolves fine in every Slack client - so a
 * failed lookup costs nothing but precision on edge cases (shared channels).
 */
export async function permalink(channelId: string, ts: string): Promise<string> {
  const key = `${channelId}|${ts}`;
  const cached = permalinkCache.get(key);
  if (cached) return cached;

  try {
    const res = await client.chat.getPermalink({ channel: channelId, message_ts: ts });
    if (res.permalink) {
      permalinkCache.set(key, res.permalink);
      return res.permalink;
    }
  } catch {
    // fall through to the constructed form
  }

  const domain = process.env.SLACK_WORKSPACE_DOMAIN;
  const constructed = domain
    ? `https://${domain}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`
    : `slack://channel?id=${channelId}&message=${ts}`;
  permalinkCache.set(key, constructed);
  return constructed;
}

export async function getReactions(channelId: string, ts: string): Promise<string[]> {
  try {
    const res = await client.reactions.get({ channel: channelId, timestamp: ts, full: true });
    return (res.message?.reactions ?? []).map((r) => r.name).filter((n): n is string => Boolean(n));
  } catch (err) {
    const code = (err as { data?: { error?: string } })?.data?.error;
    // message_not_found means the lead deleted the DM. Nothing to read, ever.
    if (code !== "message_not_found") {
      console.error(`[slack-radar] reactions.get failed for ${channelId}/${ts}:`, code ?? err);
    }
    return [];
  }
}
