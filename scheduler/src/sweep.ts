import {
  getDiscussionMessages,
  getLeadPrefs,
  getNoiseRates,
  getRipeDiscussions,
  getTeams,
  insertDecline,
  insertMatch,
  markScored,
  purgeOldMessages,
} from "./db";
import { CONFIG, isDemoMode } from "./config";
import { collectFeedback } from "./feedback";
import { judgeDiscussion } from "./judge";
import { describeJudge } from "./model";
import { deliverRealtime, markItemNotified, withinWorkingHours } from "./notify";
import { SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "./observability";
import { shortlistTeams } from "./prefilter";
import type { DiscussionRow, TeamRow } from "./types";


/** Run `fn` over `items` with bounded concurrency, preserving no order. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Confidence a match must clear for this team in this channel.
 *
 * Starts at the team's configured floor and rises with the share of past
 * notifications from this pairing that the lead marked as noise. A team that
 * has thumbs-downed everything from #random ends up effectively deaf to it
 * without anyone having to notice and edit a config.
 */
function effectiveThreshold(
  team: TeamRow,
  channelId: string,
  noiseRates: Map<string, { rate: number; samples: number }>,
): number {
  const entry = noiseRates.get(`${team.key}|${channelId}`);
  if (!entry) return team.min_confidence;
  return Math.min(0.95, team.min_confidence + entry.rate * CONFIG.noisePenalty());
}

async function processDiscussion(
  discussion: DiscussionRow,
  teams: TeamRow[],
  noiseRates: Map<string, { rate: number; samples: number }>,
  leadPrefs: Map<string, { realtime: boolean; pausedUntil: Date | null }>,
  now: Date,
): Promise<void> {
  await getTracer().startActiveSpan(
    "score_discussion",
    {
      attributes: {
        "discussion.id": discussion.id,
        "discussion.channel": discussion.channel_id,
        "discussion.messages": discussion.message_count,
      },
    },
    async (span) => {
      try {
        const messages = await getDiscussionMessages(
          discussion.channel_id,
          discussion.root_ts,
          CONFIG.maxMessages(),
        );
        if (!messages.length) {
          // Retention purged the text out from under an old discussion row.
          await markScored(discussion.id, discussion.message_count);
          span.setAttribute("discussion.outcome", "no_text");
          return;
        }

        const candidates = shortlistTeams(
          messages.map((m) => m.text).join("\n"),
          discussion.channel_id,
          teams,
          { minScore: CONFIG.prefilterMinScore(), maxTeams: CONFIG.prefilterMaxTeams() },
        );
        span.setAttribute("discussion.candidates", candidates.length);

        if (!candidates.length) {
          await markScored(discussion.id, discussion.message_count);
          span.setAttribute("discussion.outcome", "no_candidates");
          return;
        }

        const outcome = await judgeDiscussion(
          discussion,
          messages,
          candidates,
          CONFIG.maxTranscriptChars(),
        );
        // A judge that returned nothing usable is still a completed pass: mark
        // it so the next tick does not spend another call on the same text.
        await markScored(discussion.id, discussion.message_count);

        // Persist the judge's declines before anything else, so a discussion
        // that matched nothing still leaves a record of what was considered.
        for (const d of outcome?.declined ?? []) {
          try {
            await insertDecline(discussion.id, d.team_key, d.reason);
          } catch (err) {
            console.error(`[slack-radar] failed to record decline for ${d.team_key}:`, err);
          }
        }

        if (!outcome || !outcome.matches.length) {
          span.setAttribute("discussion.outcome", "no_match");
          return;
        }

        const teamsByKey = new Map(teams.map((t) => [t.key, t]));
        let raised = 0;
        let sent = 0;

        for (const match of outcome.matches) {
          const team = teamsByKey.get(match.team_key);
          if (!team) continue;

          const threshold = effectiveThreshold(team, discussion.channel_id, noiseRates);
          const belowBar = match.confidence < threshold;

          // Record the verdict either way. A below-bar match is stored
          // suppressed rather than dropped, so the decision is auditable later;
          // every read path filters suppressed = FALSE, so it cannot notify.
          const inserted = await insertMatch(
            discussion.id,
            match,
            belowBar
              ? {
                  reason: `confidence ${match.confidence.toFixed(2)} below this team's bar of ${threshold.toFixed(
                    2,
                  )} for this channel`,
                }
              : undefined,
          );
          if (belowBar) {
            console.log(
              `[slack-radar] discussion ${discussion.id}: ${team.key} scored ${match.confidence.toFixed(
                2,
              )} < ${threshold.toFixed(2)}, recorded as skipped`,
            );
            continue;
          }
          // Null means this pair was already raised on an earlier pass. Re-sending
          // is the single most annoying thing this agent could do, so we stop here.
          if (!inserted) continue;
          raised++;

          const urgent =
            match.urgency === "high" && team.realtime_enabled && withinWorkingHours(now);
          if (!urgent) continue;

          const item = {
            matchId: inserted.id,
            teamName: team.name,
            signalType: match.signal_type,
            urgency: match.urgency,
            headline: match.headline,
            rationale: match.rationale,
            channelId: discussion.channel_id,
            channelName: discussion.channel_name,
            rootTs: discussion.root_ts,
            messageCount: discussion.message_count,
          };

          let delivered = false;
          const failures: string[] = [];
          for (const leadId of team.lead_slack_ids) {
            const prefs = leadPrefs.get(leadId);
            if (prefs && !prefs.realtime) continue;
            if (prefs?.pausedUntil && prefs.pausedUntil > now) continue;
            const res = await deliverRealtime(item, leadId);
            if (res.ok) delivered = true;
            else failures.push(`${leadId}:${res.error}`);
          }
          // A registry pointing at a lead who does not exist produces a
          // perfect run that notifies nobody. Recorded on the span so it shows
          // up in traces instead of only in the ingestion workload's logs.
          if (failures.length) {
            span.setAttribute("radar.delivery_failures", failures);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `could not DM: ${failures.join(", ")}`,
            });
          }
          // Only mark it delivered if it actually reached someone. Otherwise it
          // stays pending and the digest picks it up.
          if (delivered) {
            await markItemNotified(inserted.id);
            sent++;
          }
        }

        span.setAttribute("discussion.outcome", raised ? "matched" : "below_threshold");
        span.setAttribute("discussion.matches_raised", raised);
        span.setAttribute("discussion.realtime_sent", sent);
      } catch (err) {
        // Deliberately not marking scored: a thrown error is a transient
        // failure (API blip, Slack 5xx) and the discussion should be retried.
        span.recordException(err as Error);
        console.error(`[slack-radar] discussion ${discussion.id} failed:`, err);
      } finally {
        span.end();
      }
    },
  );
}

export interface SweepStats {
  teams: number;
  ripeDiscussions: number;
  cappedOut: boolean;
  purgedMessages: number;
  feedbackRated: number;
  tunedPairings: number;
}

export async function runSweep(): Promise<SweepStats> {
  const now = new Date();
  console.log(`[slack-radar] judge ${describeJudge()}`);
  if (isDemoMode()) {
    // Deliberately shouty. Left on in production this makes the radar judge
    // half-formed threads and DM people at 03:00.
    console.warn(
      `[slack-radar] *** DEMO_MODE IS ON *** quiet=${CONFIG.quietMinutes()}min burst=${CONFIG.burstMessages()} ` +
        `min-age=${CONFIG.minAgeMinutes()}min, working-hours gate BYPASSED. Turn this off before real use.`,
    );
  }

  const purged = await purgeOldMessages(CONFIG.retentionDays());
  if (purged) console.log(`[slack-radar] purged ${purged} message(s) past retention`);

  const rated = await collectFeedback(CONFIG.feedbackHours(), CONFIG.feedbackMaxChecks());
  if (rated) console.log(`[slack-radar] recorded feedback on ${rated} notification(s)`);

  const teams = await getTeams();
  if (!teams.length) {
    console.warn("[slack-radar] no teams in the registry — nothing to match against");
    return {
      teams: 0,
      ripeDiscussions: 0,
      cappedOut: false,
      purgedMessages: purged,
      feedbackRated: rated,
      tunedPairings: 0,
    };
  }

  const [noiseRates, leadPrefs] = await Promise.all([
    getNoiseRates(CONFIG.noiseMinSamples()),
    getLeadPrefs(),
  ]);

  const discussions = await getRipeDiscussions({
    quietMinutes: CONFIG.quietMinutes(),
    burstMessages: CONFIG.burstMessages(),
    minAgeMinutes: CONFIG.minAgeMinutes(),
    maxAgeHours: CONFIG.maxAgeHours(),
    escalationFactor: CONFIG.escalationFactor(),
    limit: CONFIG.maxDiscussions(),
  });

  console.log(
    `[slack-radar] ${discussions.length} ripe discussion(s), ${teams.length} team(s), ${noiseRates.size} tuned pairing(s)`,
  );
  // A full batch means there is more work than the cap allows. Say so rather
  // than quietly looking like full coverage.
  if (discussions.length === CONFIG.maxDiscussions()) {
    console.warn(
      `[slack-radar] hit SWEEP_MAX_DISCUSSIONS (${CONFIG.maxDiscussions()}) — older ripe discussions deferred to the next run`,
    );
  }

  await mapLimit(discussions, CONFIG.concurrency(), (d) =>
    processDiscussion(d, teams, noiseRates, leadPrefs, now),
  );

  return {
    teams: teams.length,
    ripeDiscussions: discussions.length,
    cappedOut: discussions.length === CONFIG.maxDiscussions(),
    purgedMessages: purged,
    feedbackRated: rated,
    tunedPairings: noiseRates.size,
  };
}
