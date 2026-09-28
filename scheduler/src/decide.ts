import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { z } from "zod";
import { CONFIG } from "./config";
import { getTracer } from "./observability";
import { eligibleTeams } from "./prefilter";
import type { DiscussionRow, MessageRow, TeamRow } from "./types";

/**
 * Impact scoring with the gateway's decision model (jev-1-13-0).
 *
 * WHY THIS LAYER EXISTS. The lexical prefilter is a hard gate: a discussion
 * that matters but never uses a team's keywords scores 0 and never reaches the
 * judge at all. No prompt change can close that hole, because the judge is
 * never called. This scores impact — is something unanswered, is a choice being
 * made, is a customer affected — instead of vocabulary, so a thread can be
 * admitted on what is happening in it rather than on whether it said the word
 * "gateway".
 *
 * IT IS NOT A SECOND JUDGE. The decisions API returns typed answers only: a
 * probability, an option, a level. It emits no free text, so every prose field
 * a notification needs (headline, rationale, landed, the declined reasons) still
 * comes from the judge. This decides WHETHER to spend a judge call, and hands
 * the judge its numbers as evidence.
 *
 * Plain fetch, not an SDK: the OpenAI SDKs have no decisions method, and the
 * gateway's chat, embeddings and Responses endpoints reject decision models.
 */

/* ------------------------------ the answers ------------------------------ */

const Noul = z.object({ kind: z.literal("noul"), value: z.number() });
const ChoiceAnswer = z.object({
  kind: z.literal("choice"),
  value: z.string(),
  confidence: z.number().default(0),
  probabilities: z.record(z.string(), z.number()).default({}),
});
const ScoreAnswer = z.object({
  kind: z.literal("score"),
  value: z.number(),
  confidence: z.number().default(0),
  legend: z.record(z.string(), z.string()).default({}),
});

const DecisionResponse = z.object({
  answers: z.object({
    unanswered: Noul,
    customer_affecting: Noul,
    decision_forming: Noul,
    post_type: ChoiceAnswer,
    owner: ChoiceAnswer,
    urgency: ScoreAnswer,
  }),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

/** Flattened for storage and for the judge prompt. Persisted as JSONB. */
export interface ImpactScores {
  unanswered: number;
  customer_affecting: number;
  decision_forming: number;
  post_type: string;
  post_type_confidence: number;
  /** A team key, or "nobody". */
  owner: string;
  owner_confidence: number;
  /** Expected level, 0 = "not at all" … 2 = "within the hour". */
  urgency: number;
  urgency_label: string;
}

export const NO_OWNER = "nobody";

const POST_TYPES: Record<string, string> = {
  discussion: "A genuine discussion between people",
  approval_request: "A request to approve, review or sign off on something",
  ci_alert: "An automated CI, build, deploy or monitoring notification",
  status_update: "A routine status update, standup or announcement",
};

const URGENCY_LEVELS = [
  "Nobody needs to see this",
  "Worth knowing in the next digest",
  "Would want to see it within the hour",
];

/* ------------------------------- the gate -------------------------------- */

/**
 * Whether this discussion is worth a judge call.
 *
 * Both rules are deliberately asymmetric: they only fire when the model is
 * close to certain, and anything hedged escalates. The codebase already leans
 * this way in prefilter.ts — "it is fine to hand the judge a weak candidate,
 * and expensive to drop a real one" — and a drop here means a lead is never
 * told, which is the one failure the thumbs-down loop cannot see.
 *
 * The noise rule carries a second condition on purpose. README scenario 8 says
 * a thread kicked off by a CI alert is legitimate from the first human reply
 * onward, so "this looks like a CI alert" is not on its own a reason to drop —
 * an alert about a customer-affecting outage is exactly scenario 1. It has to
 * look like noise AND carry no impact signal.
 */
export function impactVerdict(s: ImpactScores): { drop: boolean; reason: string } {
  const maxImpact = Math.max(s.unanswered, s.customer_affecting, s.decision_forming);
  const noiseTypes = new Set(
    CONFIG
      .jevNoiseTypes()
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );

  if (
    noiseTypes.has(s.post_type) &&
    s.post_type_confidence >= CONFIG.jevNoiseMinConfidence() &&
    maxImpact < CONFIG.jevNoiseMaxImpact()
  ) {
    return {
      drop: true,
      reason: `looks like ${s.post_type} (confidence ${s.post_type_confidence.toFixed(
        2,
      )}) and no impact signal above ${maxImpact.toFixed(2)}`,
    };
  }

  if (maxImpact < CONFIG.jevImpactFloor()) {
    return { drop: true, reason: `no impact signal above ${maxImpact.toFixed(2)}` };
  }

  return { drop: false, reason: "" };
}

/* ------------------------------ the request ------------------------------ */

export function impactEnabled(): boolean {
  return Boolean(process.env.ASTRO_GATEWAY_URL && process.env.ASTRO_GATEWAY_API_KEY);
}

/**
 * Log-safe one-liner, printed once per sweep next to the judge's.
 *
 * This is the handover surface: someone who deploys without a `provider:
 * gateway` model entry gets a radar that quietly behaves like the old one, and
 * this line is the difference between "less precise for no visible reason" and
 * a sentence saying why.
 */
export function describeImpact(): string {
  if (!impactEnabled()) return "DISABLED (no gateway url/key) — lexical prefilter only";
  return `${CONFIG.jevModel()} via gateway — active`;
}

/**
 * Anonymised to the same person1/person2 labels the judge sees.
 *
 * Identity is deliberately withheld here too: whether a lead is already in the
 * thread is a Postgres fact (recent authors ∩ lead_slack_ids), checked exactly
 * in prefilter.ts. Asking a model to infer it from an anonymised transcript is how
 * you get a 0.48 — a calibrated way of saying "you did not tell me".
 */
function renderState(
  discussion: DiscussionRow,
  messages: MessageRow[],
  maxChars: number,
): Record<string, unknown> {
  const alias = new Map<string, string>();
  const label = (id: string | null) => {
    if (!id) return "someone";
    if (!alias.has(id)) alias.set(id, `person${alias.size + 1}`);
    return alias.get(id)!;
  };

  const transcript: string[] = [];
  let used = 0;
  for (const m of messages) {
    const line = `${label(m.user_id)}: ${m.text}`;
    if (used + line.length > maxChars) {
      transcript.push("[…truncated…]");
      break;
    }
    transcript.push(line);
    used += line.length;
  }

  return {
    channel: discussion.channel_name ? `#${discussion.channel_name}` : discussion.channel_id,
    message_count: discussion.message_count,
    participant_count: discussion.participants.length,
    minutes_since_last_message: Math.round(
      (Date.now() - discussion.last_message_at.getTime()) / 60000,
    ),
    transcript,
  };
}

/**
 * One decisions call per ripe discussion, asking every question at once.
 *
 * Six named questions in one request rather than six requests: the decisions
 * API keys answers by question name, so the marginal cost of another question
 * is a few completion tokens rather than another round trip.
 *
 * Returns null on ANY failure, which the caller must treat as "carry on with
 * the lexical result". A scoring layer that swallowed every discussion when the
 * gateway blipped would look exactly like a quiet week.
 */
export async function scoreImpact(
  discussion: DiscussionRow,
  messages: MessageRow[],
  teams: TeamRow[],
  engaged: string[],
): Promise<ImpactScores | null> {
  if (!impactEnabled()) return null;

  // Only teams that could actually be told: the same eligibility the lexical
  // prefilter applies, so the owner question cannot name a team we would refuse
  // to notify anyway.
  const selectable = eligibleTeams(teams, discussion.channel_id, engaged).slice(
    0,
    CONFIG.jevMaxTeams(),
  );
  if (!selectable.length) return null;

  const ownerCriteria: Record<string, string> = { [NO_OWNER]: "No team here owns this subject" };
  for (const t of selectable) {
    ownerCriteria[t.key] = t.description || t.topics.join("; ") || t.name;
  }

  return getTracer().startActiveSpan(
    "score_impact",
    {
      attributes: {
        "gen_ai.operation.name": "decisions",
        "gen_ai.provider.name": "astro-gateway",
        "gen_ai.request.model": CONFIG.jevModel(),
        "radar.discussion_id": discussion.id,
        "radar.jev.selectable_teams": selectable.length,
      },
    },
    async (span: Span) => {
      try {
        const res = await fetch(`${process.env.ASTRO_GATEWAY_URL}/v1/decisions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.ASTRO_GATEWAY_API_KEY}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(CONFIG.jevTimeoutMs()),
          body: JSON.stringify({
            model: CONFIG.jevModel(),
            state: renderState(discussion, messages, CONFIG.jevMaxTranscriptChars()),
            questions: {
              unanswered: {
                kind: "noul",
                instructions:
                  "Has someone asked a question here that nobody has answered? Count genuine questions about how something works, why something is happening, or what should be done. Do NOT count a routine request to review, approve, merge or sign off on something.",
              },
              customer_affecting: {
                kind: "noul",
                instructions:
                  "Is something described here affecting customers or users right now — broken, degraded, or behaving unexpectedly?",
              },
              decision_forming: {
                kind: "noul",
                instructions:
                  "Is this conversation converging on a technical, product or process choice that will be acted on? Do NOT count social plans, scheduling, lunch, or personal arrangements.",
              },
              post_type: {
                kind: "choice",
                instructions: "What kind of thread is this?",
                criteria: POST_TYPES,
              },
              owner: {
                kind: "choice",
                instructions:
                  "Which team's area does this thread fall in? Answer 'nobody' unless the subject clearly belongs to one of them.",
                criteria: ownerCriteria,
              },
              urgency: {
                kind: "score",
                instructions:
                  "If a team lead owned this area and was not in this channel, how urgently would they want to see this?",
                criteria: URGENCY_LEVELS,
              },
            },
          }),
        });

        if (!res.ok) {
          // 4xx here is usually a key that predates decision models being
          // enabled on the account; the body names the problem.
          const body = (await res.text()).slice(0, 300);
          span.setAttribute("radar.jev.outcome", `http_${res.status}`);
          console.warn(`[slack-radar] impact scoring HTTP ${res.status}: ${body}`);
          return null;
        }

        const parsed = DecisionResponse.safeParse(await res.json());
        if (!parsed.success) {
          span.setAttribute("radar.jev.outcome", "schema_invalid");
          console.error(
            `[slack-radar] impact scoring returned unexpected shape: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          );
          return null;
        }

        const a = parsed.data.answers;
        const scores: ImpactScores = {
          unanswered: a.unanswered.value,
          customer_affecting: a.customer_affecting.value,
          decision_forming: a.decision_forming.value,
          post_type: a.post_type.value,
          post_type_confidence: a.post_type.confidence,
          owner: a.owner.value,
          owner_confidence: a.owner.probabilities[a.owner.value] ?? a.owner.confidence,
          urgency: a.urgency.value,
          urgency_label: a.urgency.legend[String(Math.round(a.urgency.value))] ?? "",
        };

        if (parsed.data.usage?.prompt_tokens !== undefined) {
          span.setAttribute("gen_ai.usage.input_tokens", parsed.data.usage.prompt_tokens);
        }
        if (parsed.data.usage?.completion_tokens !== undefined) {
          span.setAttribute("gen_ai.usage.output_tokens", parsed.data.usage.completion_tokens);
        }
        span.setAttribute("radar.jev.outcome", "ok");
        span.setAttribute("radar.jev.unanswered", scores.unanswered);
        span.setAttribute("radar.jev.customer_affecting", scores.customer_affecting);
        span.setAttribute("radar.jev.decision_forming", scores.decision_forming);
        span.setAttribute("radar.jev.post_type", scores.post_type);
        span.setAttribute("radar.jev.owner", scores.owner);
        span.setAttribute("radar.jev.urgency", scores.urgency);
        return scores;
      } catch (err) {
        // Includes the AbortSignal timeout. Fail open, every time.
        span.setAttribute("radar.jev.outcome", "error");
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        console.warn(`[slack-radar] impact scoring failed, falling back to lexical:`, err);
        return null;
      } finally {
        span.end();
      }
    },
  );
}
