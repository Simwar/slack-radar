import { assertConnection, closePool } from "./db";
import { runDigest } from "./digest";
import { getTracer, shutdownTracing, startTracing } from "./observability";

async function main() {
  startTracing();

  try {
    await getTracer().startActiveSpan("lead_digest", async (span) => {
      try {
        await assertConnection();
        const stats = await runDigest();
        span.setAttribute("radar.leads_total", stats.leadsTotal);
        span.setAttribute("radar.leads_sent", stats.leadsSent);
        span.setAttribute("radar.leads_failed", stats.leadsFailed);
        span.setAttribute("radar.matches_delivered", stats.matchesDelivered);
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

  console.log("[slack-radar] digest complete");
}

main().catch((err) => {
  console.error("[slack-radar] fatal error:", err);
  process.exit(1);
});
