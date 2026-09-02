import { buildTracesUrl, getOrCreateAstroTracerProvider } from '@astropods/adapter-core';
import type { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Observability, SamplingStrategyType } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import { trace, type Tracer } from '@opentelemetry/api';

const TRACER_NAME = 'slack-radar-agent';

/**
 * Start the agent container's own OTEL tracer provider.
 *
 * Two separate things are instrumented in this container and both are needed:
 *
 *  - `setupObservability` below covers Mastra's work: agent runs, tool calls,
 *    LLM calls. It only fires when the model actually runs.
 *  - THIS covers everything else, and in slack-radar that is the majority of the
 *    traffic. The whole design point is that observed messages are recorded
 *    WITHOUT running the model, so Mastra sees none of it — ingest would be
 *    completely invisible without a provider of our own.
 *
 * `getOrCreateAstroTracerProvider` (from adapter-core) is used rather than a
 * hand-rolled NodeTracerProvider because it already sets service.name/version
 * from the platform's env vars, registers globally, is idempotent, and installs
 * SIGTERM/SIGINT handlers that flush before exit.
 *
 * ONE BUN QUIRK, measured rather than assumed. This path uses the standard
 * node:http OTLP exporter, and under Bun that transport's request `close`
 * handler fires spuriously and reports a phantom "Request timed out" — the same
 * bug that forced the fetch-based exporter in `scheduler/src/observability.ts`.
 * What was verified against a local collector:
 *
 *   - Spans DO arrive. The POST completes and the collector receives the body.
 *   - `forceFlush()` nonetheless REJECTS with that phantom error.
 *   - Ordinary span emission does not crash the process; only an awaited
 *     `forceFlush()` with no catch does.
 *
 * So: never call `forceFlush()` on this provider from our code without a catch.
 * adapter-core's own signal handlers already wrap it in try/catch, which is why
 * shutdown is safe. Expect phantom export errors in the agent logs; they are
 * noise, not lost telemetry. The scheduler needed the fetch exporter because a
 * cron process exits before a retry can land, and this container does not.
 *
 * No-op unless the platform injects OTEL_EXPORTER_OTLP_ENDPOINT, so local dev
 * stays clean.
 */
export function startAgentTracing(): void {
  const provider = getOrCreateAstroTracerProvider();
  if (!provider) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT!;
  console.log(`[slack-radar] agent OTEL tracing enabled → ${buildTracesUrl(endpoint)}`);
}

export function getAgentTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Wire Mastra OTEL observability so agent runs, tool calls, and LLM calls
 * surface as traces (and drive metrics) on Astro Monitor and Insights.
 *
 * `@astropods/adapter-mastra`'s own `serve()` does this automatically, but
 * slack-radar uses `@astropods/adapter-core`'s lower-level `serve` so it can wrap
 * the adapter with the ingest hook. That bypasses the auto setup, so we
 * replicate it here and call it before serving.
 *
 * Kept deliberately in step with the upstream `setupObservability` in
 * @astropods/adapter-mastra. One difference is intentional: upstream wraps the
 * Observability instance in a `flush()` shim for @mastra/observability 1.5.0,
 * which did not implement it. The installed 1.17.4 does (`Observability.flush`),
 * so the shim is dead weight here. If this agent is ever pinned back to an
 * older @mastra/observability, that shim has to come back or spans stop
 * flushing.
 *
 * No-op unless the platform injects OTEL_EXPORTER_OTLP_ENDPOINT.
 */
export function setupObservability(agent: Agent): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  // Mastra's OtelExporter uses the endpoint verbatim as the OTLP url, so append
  // the traces signal path ourselves.
  const tracesUrl = buildTracesUrl(endpoint);

  const observability = new Observability({
    configs: {
      otel: {
        sampling: { type: SamplingStrategyType.ALWAYS },
        serviceName: process.env.ASTRO_AGENT_NAME ?? agent.name,
        exporters: [
          new OtelExporter({
            provider: {
              custom: { endpoint: tracesUrl, protocol: 'http/protobuf' },
            },
          }),
        ],
      },
    },
  });

  const mastra = new Mastra({ observability });
  mastra.addAgent(agent);
  console.log(`[slack-radar] Mastra OTEL tracing enabled → ${tracesUrl}`);
}
