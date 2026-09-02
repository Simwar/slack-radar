import {
  getLeadPrefs,
  getPendingDigestMatches,
  markDigestSent,
  recordNotification,
} from "./db";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { CONFIG } from "./config";
import { feedbackFooter, renderItem, type DeliverableItem } from "./notify";
import { getTracer } from "./observability";
import { openDM, postDM } from "./slack";
import type { PendingDigestRow } from "./types";


function toItem(row: PendingDigestRow): DeliverableItem {
  return {
    matchId: row.match_id,
    teamName: row.team_name,
    signalType: row.signal_type,
    urgency: row.urgency,
    headline: row.headline,
    rationale: row.rationale,
    channelId: row.channel_id,
    channelName: row.channel_name,
    rootTs: row.root_ts,
    messageCount: row.message_count,
  };
}

/**
 * The default delivery path.
 *
 * Everything the sweep raised that was not urgent enough to interrupt for lands
 * here, batched per lead. One message with five things in it is read; five
 * messages spread across an afternoon are muted.
 */
export interface DigestStats {
  leadsTotal: number;
  leadsSent: number;
  leadsFailed: number;
  matchesDelivered: number;
}

export async function runDigest(): Promise<DigestStats> {
  const empty: DigestStats = { leadsTotal: 0, leadsSent: 0, leadsFailed: 0, matchesDelivered: 0 };
  const pending = await getPendingDigestMatches();
  if (!pending.length) {
    console.log("[slack-radar] nothing pending — no digests to send");
    return empty;
  }

  const prefs = await getLeadPrefs();
  const now = new Date();

  // Fan the per-team matches out to per-lead inboxes. One match with two leads
  // becomes two deliveries of the same item.
  const byLead = new Map<string, PendingDigestRow[]>();
  for (const row of pending) {
    for (const leadId of row.lead_slack_ids) {
      const p = prefs.get(leadId);
      if (p?.pausedUntil && p.pausedUntil > now) continue;
      const list = byLead.get(leadId) ?? [];
      list.push(row);
      byLead.set(leadId, list);
    }
  }

  const deliveredMatchIds = new Set<string>();
  let sentCount = 0;
  let failedCount = 0;

  for (const [leadId, rows] of byLead) {
    // Per-lead span: a digest that silently reaches four of five leads is the
    // failure this makes visible. Without it, one failed conversations.open
    // looks identical to a lead having nothing pending.
    await getTracer().startActiveSpan(
      "send_digest",
      { attributes: { "radar.lead_id": leadId, "radar.pending_items": rows.length } },
      async (span) => {
        try {
          // Count what actually reached someone. Basing this on "did the call
          // return" would report a lead as notified when conversations.open or
          // chat.postMessage had quietly failed.
          const delivered = await sendOneDigest(leadId, rows, deliveredMatchIds, span);
          if (delivered) sentCount++;
          else failedCount++;
        } catch (err) {
          failedCount++;
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          console.error(`[slack-radar] digest to ${leadId} failed:`, err);
        } finally {
          span.end();
        }
      },
    );
  }

  await markDigestSent([...deliveredMatchIds]);

  return {
    leadsTotal: byLead.size,
    leadsSent: sentCount,
    leadsFailed: failedCount,
    matchesDelivered: deliveredMatchIds.size,
  };
}

/** Returns true only if a digest message actually landed. */
async function sendOneDigest(
  leadId: string,
  rows: PendingDigestRow[],
  deliveredMatchIds: Set<string>,
  span: Span,
): Promise<boolean> {
  {
    const dm = await openDM(leadId);
    if (!dm) {
      span.setAttribute("radar.digest.outcome", "dm_open_failed");
      return false;
    }

    // Highest confidence first: if the digest gets truncated, what survives is
    // what the judge was surest about.
    const sorted = [...rows].sort((a, b) => b.confidence - a.confidence);
    const shown = sorted.slice(0, CONFIG.digestMaxItems());
    const hidden = sorted.length - shown.length;

    const byTeam = new Map<string, PendingDigestRow[]>();
    for (const row of shown) {
      const list = byTeam.get(row.team_name) ?? [];
      list.push(row);
      byTeam.set(row.team_name, list);
    }

    const sections: string[] = [];
    for (const [teamName, teamRows] of byTeam) {
      const bullets: string[] = [];
      for (const row of teamRows) {
        bullets.push(await renderItem(toItem(row)));
      }
      sections.push(`*${teamName}*\n\n${bullets.join("\n\n")}`);
    }

    const count = shown.length;
    const header = `:satellite_antenna: *${count} discussion${count === 1 ? "" : "s"} on your radar*`;
    const tail = hidden
      ? `\n\n_${hidden} lower-confidence item${hidden === 1 ? "" : "s"} not shown. Ask me "what did I miss" for the full list._`
      : "";

    const ts = await postDM(dm, `${header}\n\n${sections.join("\n\n")}${tail}${feedbackFooter()}`);
    if (!ts) {
      span.setAttribute("radar.digest.outcome", "post_failed");
      return false;
    }

    // One notification row per item in the digest, all pointing at the same
    // message. A reaction on the digest is feedback on everything in it, which
    // is coarse but honest: that is genuinely all the lead told us.
    for (const row of shown) {
      await recordNotification({
        matchId: row.match_id,
        leadSlackId: leadId,
        dmChannelId: dm,
        dmTs: ts,
        mode: "digest",
      });
      deliveredMatchIds.add(row.match_id);
    }
    // Items past the cap are still marked sent. They stay queryable via
    // "what did I miss" and are not worth carrying into tomorrow's digest.
    for (const row of sorted) deliveredMatchIds.add(row.match_id);

    span.setAttribute("radar.digest.outcome", "sent");
    span.setAttribute("radar.digest.items_shown", shown.length);
    span.setAttribute("radar.digest.items_hidden", hidden);
    console.log(`[slack-radar] digest sent to ${leadId}: ${shown.length} item(s), ${hidden} hidden`);
    return true;
  }
}
