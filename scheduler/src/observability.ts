import { trace, type Tracer } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "slack-radar-scheduler";
const EXPORT_TIMEOUT_MS = 8000;

/**
 * OTLP/HTTP trace exporter that POSTs via `fetch` instead of the OpenTelemetry
 * SDK's `node:http` transport. Under Bun, that transport's request `close`
 * handler fires spuriously and reports a phantom "Request timed out", aborting
 * the export from this short-lived cron process (the long-lived agent survives
 * it). Bun implements `fetch` natively, so this path is reliable.
 */
class FetchTraceExporter implements SpanExporter {
  constructor(private readonly url: string) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const body = JsonTraceSerializer.serializeRequest(spans);
    if (!body) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new TextDecoder().decode(body),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    })
      .then((res) => {
        resultCallback(
          res.ok
            ? { code: ExportResultCode.SUCCESS }
            : {
                code: ExportResultCode.FAILED,
                error: new Error(`OTLP export failed: HTTP ${res.status}`),
              },
        );
      })
      .catch((error: unknown) => {
        resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
      });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

let provider: NodeTracerProvider | null = null;

/**
 * Start OTEL tracing for the sweep and digest jobs so its runs surface as traces (and
 * drive metrics) on Astro Monitor and Insights. No-op unless the platform
 * injects OTEL_EXPORTER_OTLP_ENDPOINT, so local runs stay clean.
 */
export function startTracing(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || provider) return;

  const url = `${endpoint.replace(/\/+$/, "")}/v1/traces`;
  provider = new NodeTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: process.env.ASTRO_AGENT_NAME ?? "slack-radar",
      [ATTR_SERVICE_VERSION]: process.env.ASTRO_AGENT_BUILD ?? "dev",
    }),
    spanProcessors: [new BatchSpanProcessor(new FetchTraceExporter(url))],
  });
  provider.register();
  console.log(`[slack-radar] scheduler OTEL tracing enabled → ${url}`);
}

/**
 * Flush and shut down the tracer. Critical for this short-lived cron process:
 * without it the batch processor drops spans when the process exits.
 */
export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  try {
    await provider.forceFlush();
    await provider.shutdown();
  } catch (err) {
    console.error("[slack-radar] tracer shutdown failed:", err);
  }
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}
