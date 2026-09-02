/**
 * Serve a single /health endpoint. This platform generates ONE probe from the
 * healthcheck block and uses it for BOTH liveness and readiness, so the check
 * must reflect liveness only: is the process alive and its event loop
 * responsive? A wedged loop can't answer this at all, so liveness still fails
 * and the pod restarts — which is the real value we wanted.
 *
 * We deliberately do NOT gate on Slack/Postgres here. With liveness == readiness,
 * 503-ing on a dependency blip (or a missing SLACK_BOT_TOKEN in this container)
 * restarts the pod on every check → permanent CrashLoopBackOff. Dependency
 * health belongs in observability/logs, not in a probe that also kills the pod.
 *
 * Binds 0.0.0.0, not Bun's default "localhost": the kubelet probes the pod IP,
 * and a loopback-only bind fails with "connection refused".
 */
export function startHealthServer(): void {
  const port = Number(process.env.HEALTH_PORT) || 8080;
  Bun.serve({
    port,
    hostname: '0.0.0.0',
    fetch(req) {
      if (new URL(req.url).pathname !== '/health') return new Response('not found', { status: 404 });
      return new Response('ok', { status: 200 });
    },
  });
  console.log(`[slack-radar] health server listening on :${port}/health`);
}
