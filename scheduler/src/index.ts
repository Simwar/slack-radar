import { assertConnection, closePool } from "./db";
import { resolveBackend, resolveJudgeModel } from "./model";
import { getTracer, shutdownTracing, startTracing } from "./observability";
import { runSweep } from "./sweep";

async function main() {
  startTracing();

  try {
    await getTracer().startActiveSpan("discussion_sweep", async (span) => {
      try {
        // Backend and model on the ROOT span, so a cost or latency change can be
        // attributed to a model switch without opening a child span.
        span.setAttribute("gen_ai.provider.name", resolveBackend());
        span.setAttribute("gen_ai.request.model", resolveJudgeModel());

        // Retries transient DB unavailability with backoff; throws (job fails,
        // reruns next tick) only on a genuine connection/config error.
        await assertConnection();
        const stats = await runSweep();
        span.setAttribute("radar.teams", stats.teams);
        span.setAttribute("radar.ripe_discussions", stats.ripeDiscussions);
        span.setAttribute("radar.purged_messages", stats.purgedMessages);
        span.setAttribute("radar.feedback_rated", stats.feedbackRated);
        span.setAttribute("radar.tuned_pairings", stats.tunedPairings);
        // True means there was more ripe work than the per-run cap allowed, so
        // coverage this run was incomplete. Alert on this, not on the log line.
        span.setAttribute("radar.capped_out", stats.cappedOut);
      } catch (err) {
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  } finally {
    await closePool();
    await shutdownTracing();
  }

  console.log("[slack-radar] sweep complete");
}

main().catch((err) => {
  console.error("[slack-radar] fatal error:", err);
  process.exit(1);
});
