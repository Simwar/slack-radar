import { toZonedTime } from "date-fns-tz";
import { CONFIG } from "./config";
import { markNotified, recordNotification } from "./db";
import { openDM, permalink, postDM, takeLastSlackError } from "./slack";

function parseHHMM(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Which weekdays realtime DMs may be sent on, parsed from RADAR_WINDOW_DAYS.
 *
 * Ranges wrap, so "5-1" means Fri through Mon. An unparseable value falls back
 * to Mon-Fri rather than to the empty set: a typo here must not silently mute
 * every realtime notification, which is a failure nobody would notice.
 */
function windowDays(): Set<number> {
  const days = new Set<number>();
  for (const part of CONFIG.windowDays().split(",")) {
    const range = part.trim().match(/^([0-6])\s*-\s*([0-6])$/);
    if (range) {
      const from = Number(range[1]);
      const span = (Number(range[2]) - from + 7) % 7;
      for (let i = 0; i <= span; i++) days.add((from + i) % 7);
      continue;
    }
    const one = Number(part.trim());
    if (Number.isInteger(one) && one >= 0 && one <= 6) days.add(one);
  }
  return days.size ? days : new Set([1, 2, 3, 4, 5]);
}

/**
 * Realtime DMs are an interruption, so they respect a working window. Anything
 * that lands outside it is not dropped - it stays pending and goes out in the
 * next digest, which is exactly where a non-urgent notification belongs.
 *
 * Note this gates DELIVERY only. The sweep judges and records matches whatever
 * the day or hour; the window decides whether a match interrupts someone now or
 * waits. So a quiet weekend is not a gap in coverage.
 */
export function withinWorkingHours(now: Date): boolean {
  const tz = CONFIG.timezone();
  const start = parseHHMM(CONFIG.windowStart());
  const end = parseHHMM(CONFIG.windowEnd());

  const zoned = toZonedTime(now, tz);
  if (!windowDays().has(zoned.getDay())) return false;

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
  landed: string | null;
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

/** A Slack blockquote ends at the first newline, so a sentence the model wrapped
 *  would leave half of itself outside the quote. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function renderItem(item: DeliverableItem): Promise<string> {
  const link = await permalink(item.channelId, item.rootTs);
  const label = SIGNAL_LABEL[item.signalType] ?? item.signalType;
  return [
    `*${item.headline}*`,
    `${item.rationale}`,
    // Quoted, on its own line: the rationale is the radar's reasoning about the
    // lead, this is the conversation's own state. Omitted rather than blank for
    // matches raised before the judge produced it.
    ...(item.landed ? [`> ${oneLine(item.landed)}`] : []),
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
