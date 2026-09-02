import { toZonedTime } from "date-fns-tz";
import { CONFIG, isDemoMode } from "./config";
import { markNotified, recordNotification } from "./db";
import { openDM, permalink, postDM, takeLastSlackError } from "./slack";

function parseHHMM(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Realtime DMs are an interruption, so they respect a working window. Anything
 * that lands outside it is not dropped - it stays pending and goes out in the
 * next digest, which is exactly where a non-urgent notification belongs.
 */
export function withinWorkingHours(now: Date): boolean {
  // Demo mode ignores the window: a demo happens when it happens, and an
  // audience watching nothing arrive at 19:30 on a Friday learns the wrong
  // thing about the product.
  if (isDemoMode()) return true;
  const tz = CONFIG.timezone();
  const start = parseHHMM(CONFIG.windowStart());
  const end = parseHHMM(CONFIG.windowEnd());

  const zoned = toZonedTime(now, tz);
  const day = zoned.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;

  const minutes = zoned.getHours() * 60 + zoned.getMinutes();
  return minutes >= start && minutes < end;
}

export interface DeliverableItem {
  matchId: string;
  teamName: string;
  signalType: string;
  urgency: string;
  headline: string;
  rationale: string;
  channelId: string;
  channelName: string | null;
  rootTs: string;
  messageCount: number;
}

const SIGNAL_LABEL: Record<string, string> = {
  decision: "decision forming",
  unanswered_question: "unanswered question",
  incident: "possible incident",
  escalating: "thread escalating",
};

function channelRef(item: DeliverableItem): string {
  return item.channelName ? `#${item.channelName}` : `<#${item.channelId}>`;
}

export async function renderItem(item: DeliverableItem): Promise<string> {
  const link = await permalink(item.channelId, item.rootTs);
  const label = SIGNAL_LABEL[item.signalType] ?? item.signalType;
  return [
    `*${item.headline}*`,
    `${item.rationale}`,
    `_${label}_ · ${channelRef(item)} · ${item.messageCount} messages · <${link}|open thread>`,
  ].join("\n");
}

export function feedbackFooter(): string {
  return `\n:${CONFIG.usefulEmoji()}: if this was worth knowing, :${CONFIG.noiseEmoji()}: if it was not. I tune on that.`;
}

/**
 * Send one urgent item to one lead, now.
 *
 * Returns false when nothing was sent (lead paused, digest-only, DM failed), in
 * which case the match stays pending and the digest will pick it up.
 */
export async function deliverRealtime(
  item: DeliverableItem,
  leadSlackId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const dm = await openDM(leadSlackId);
  if (!dm) return { ok: false, error: takeLastSlackError() ?? "dm_open_failed" };

  const body = `:rotating_light: *Heads up, ${item.teamName}*\n\n${await renderItem(item)}${feedbackFooter()}`;
  const ts = await postDM(dm, body);
  if (!ts) return { ok: false, error: takeLastSlackError() ?? "post_failed" };

  await recordNotification({
    matchId: item.matchId,
    leadSlackId,
    dmChannelId: dm,
    dmTs: ts,
    mode: "realtime",
  });
  return { ok: true };
}

export async function markItemNotified(matchId: string): Promise<void> {
  await markNotified(matchId);
}
