import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import OpenAI from "openai";
import { z } from "zod";
import { CONFIG } from "./config";
import { getTracer } from "./observability";
import {
  DEFAULT_BASETEN_BASE_URL,
  resolveBackend,
  resolveJudgeModel,
} from "./model";
import type { Candidate } from "./prefilter";
import type { DiscussionRow, JudgedMatch, MessageRow } from "./types";


/**
 * Model families that accept `output_config.effort`.
 *
 * This is an allow-list, not a deny-list, because sending `effort` to a model
 * that does not support it is a hard 400 — Haiku 4.5 (the default here) and
 * Sonnet 4.5 both reject it — whereas omitting it is always valid and just
 * means the model's own default depth. So an unrecognised model errs toward
 * working rather than toward a cheaper call that fails.
 */
const EFFORT_CAPABLE = /^claude-(opus-(4-[5678]|5)|sonnet-(4-6|5)|fable-5|mythos-5)\b/;

function effortFor(model: string): { effort: "low" | "medium" | "high" } | Record<string, never> {
  return EFFORT_CAPABLE.test(model) ? { effort: CONFIG.judgeEffort() } : {};
}

const JudgeResult = z.object({
  summary: z.string().describe("One neutral sentence describing what this discussion is about."),
  matches: z
    .array(
      z.object({
        team_key: z.string().describe("Exactly one of the candidate team keys provided."),
        signal_type: z.enum(["decision", "unanswered_question", "incident", "escalating"]),
        confidence: z.number().describe("0 to 1. How sure you are this team's lead would want this."),
        urgency: z
          .enum(["high", "normal"])
          .describe("high only if the lead would regret not seeing it within the hour."),
        headline: z.string().describe("Under 90 characters, written for the lead, no preamble."),
        rationale: z
          .string()
          .describe("One sentence naming the specific thing that makes this the team's business."),
      }),
    )
    .describe("Empty when no candidate team genuinely needs to know. This is the common case."),
  declined: z
    .array(
      z.object({
        team_key: z.string().describe("A candidate team you are NOT flagging this for."),
        reason: z
          .string()
          .describe("One short sentence on why not, written so a lead reading it later understands."),
      }),
    )
    .describe(
      "Every candidate team that does not appear in matches. Required, not optional: this is the audit trail for why a lead was not told, so leaving it empty when you declined a team destroys the only record of that decision.",
    ),
});

type JudgeResultType = z.infer<typeof JudgeResult>;

const SYSTEM = `
You triage Slack discussions on behalf of team leads who cannot read every channel.

You are given one discussion and a shortlist of candidate teams. For each candidate, decide whether
that team's lead would want to know this conversation is happening somewhere they are not.

Flag a discussion for a team only when it is one of these:
- decision: the discussion is converging on a choice that affects something the team owns. The
  classic failure this prevents is a decision being made in a channel the owning team is not in.
- unanswered_question: someone asked about something the team owns and nobody has answered.
- incident: something the team owns is broken, degraded, or behaving unexpectedly.
- escalating: the thread is growing fast or pulling in more people, and it touches the team's area.

Do not flag:
- Casual mentions, jokes, or a passing reference to a team's product with no ask and no decision.
- Discussions where someone from the team is already clearly participating.
- Status updates, standups, deploy notifications, and other routine chatter.
- A question that has already been answered in the thread.
- Something a team merely finds interesting. The bar is "would want to track or jump in", not
  "is vaguely related".

Default to no match. An empty matches array is the correct answer for most discussions, and a lead
who gets one useless notification will stop reading all of them. Only use confidence above 0.8 when
the team's ownership of the subject is explicit in the text, not inferred.

Set urgency high only for an active incident, or a decision that looks like it is being finalised in
this conversation. Everything else is normal and can wait for a digest.

Account for EVERY candidate team. A team belongs either in matches or in declined, never in neither.
The declined entries are kept and shown to leads who ask why they were not told about something, so
write the reason for them, not for yourself: "someone asked for a link, no decision or problem to
track" is useful; "not relevant" is not.
`.trim();

function renderDiscussion(
  discussion: DiscussionRow,
  messages: MessageRow[],
  maxChars: number,
): string {
  const header = [
    `Channel: ${discussion.channel_name ? `#${discussion.channel_name}` : discussion.channel_id}`,
    `Messages: ${discussion.message_count}`,
    `Participants: ${discussion.participants.length}`,
    `Started: ${discussion.first_message_at.toISOString()}`,
    `Last activity: ${discussion.last_message_at.toISOString()}`,
  ].join("\n");

  // Anonymise to stable per-discussion labels. The judge does not need to know
  // who is talking to decide whether the subject is a team's business, and
  // real user IDs in a prompt invite the model to reason about individuals.
  const alias = new Map<string, string>();
  const label = (id: string | null) => {
    if (!id) return "someone";
    if (!alias.has(id)) alias.set(id, `person${alias.size + 1}`);
    return alias.get(id)!;
  };

  const lines: string[] = [];
  let used = 0;
  for (const m of messages) {
    const line = `${label(m.user_id)}: ${m.text}`;
    if (used + line.length > maxChars) {
      lines.push("[…transcript truncated…]");
      break;
    }
    lines.push(line);
    used += line.length;
  }

  return `${header}\n\nTranscript:\n${lines.join("\n")}`;
}

function renderCandidates(candidates: Candidate[]): string {
  return candidates
    .map((c) =>
      [
        `- key: ${c.team.key}`,
        `  name: ${c.team.name}`,
        c.team.description ? `  owns: ${c.team.description}` : null,
        c.team.topics.length ? `  topics: ${c.team.topics.join("; ")}` : null,
        `  matched on: ${c.hits.join(", ")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

/* ------------------------------- Anthropic ------------------------------- */

let _anthropic: Anthropic | null = null;
function anthropicClient(): Anthropic {
  if (!_anthropic) {
    // One key throughout: the same ANTHROPIC_API_KEY the agent container uses,
    // injected as a top-level input so both containers see it.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    _anthropic = new Anthropic(apiKey ? { apiKey } : {});
  }
  return _anthropic;
}

async function judgeViaAnthropic(
  user: string,
  label: string,
  span: Span,
): Promise<JudgeResultType | null> {
  const model = resolveJudgeModel();
  span.setAttribute("gen_ai.request.model", model);
  span.setAttribute("gen_ai.request.max_tokens", CONFIG.judgeMaxTokens("anthropic"));

  const response = await anthropicClient().messages.parse({
    model,
    max_tokens: CONFIG.judgeMaxTokens("anthropic"),
    system: SYSTEM,
    output_config: { ...effortFor(model), format: zodOutputFormat(JudgeResult) },
    messages: [{ role: "user", content: user }],
  });

  // Token usage is the only way to see judge cost per run without reconciling
  // against a billing export, and it is what makes "should we switch models"
  // answerable from the dashboards.
  span.setAttribute("gen_ai.usage.input_tokens", response.usage.input_tokens);
  span.setAttribute("gen_ai.usage.output_tokens", response.usage.output_tokens);
  span.setAttribute("gen_ai.response.finish_reasons", [response.stop_reason ?? "unknown"]);

  // A safety classifier can decline (HTTP 200, no content). Skipping one
  // discussion is the right outcome; the sweep must not die on it.
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unknown";
    span.setAttribute("radar.judge.outcome", "refusal");
    span.setAttribute("radar.judge.refusal_category", category);
    console.warn(`[slack-radar] judge refused ${label} (${category})`);
    return null;
  }
  if (!response.parsed_output) {
    span.setAttribute("radar.judge.outcome", "unparseable");
    console.error(`[slack-radar] judge returned unparseable output for ${label}`);
    return null;
  }
  return response.parsed_output;
}

/* -------------------------------- Baseten -------------------------------- */

let _baseten: OpenAI | null = null;
function basetenClient(): OpenAI {
  if (!_baseten) {
    _baseten = new OpenAI({
      apiKey: process.env.BASETEN_API_KEY,
      baseURL: process.env.BASETEN_BASE_URL || DEFAULT_BASETEN_BASE_URL,
    });
  }
  return _baseten;
}

const TOOL_NAME = "report_triage";

/**
 * JSON Schema for the forced function call.
 *
 * Built once from the same zod schema the Anthropic path uses, so the two
 * backends can never drift on what a match looks like. `$schema` is stripped:
 * zod v4 emits it, and some OpenAI-compatible servers reject an unexpected
 * top-level key in a function's `parameters`.
 */
function judgeJsonSchema(): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(JudgeResult) as Record<string, unknown>;
  return schema;
}

/**
 * Baseten has no equivalent of Anthropic's first-party structured outputs
 * (`output_config.format`), so this path forces a single function call and
 * parses its arguments. Every model in Baseten's catalog supports tool use,
 * which makes this the portable option.
 *
 * Note `chat.completions`, not `responses` — Baseten does not implement the
 * OpenAI Responses API, and a request to it hangs rather than erroring.
 */
async function judgeViaBaseten(
  user: string,
  label: string,
  span: Span,
): Promise<JudgeResultType | null> {
  const model = resolveJudgeModel();
  span.setAttribute("gen_ai.request.model", model);
  span.setAttribute("gen_ai.request.max_tokens", CONFIG.judgeMaxTokens("baseten"));

  const response = await basetenClient().chat.completions.create({
    model,
    // Reasoning models (GLM, DeepSeek, Nemotron) spend tokens before the tool
    // call, so this ceiling is higher than the Anthropic path's.
    max_tokens: CONFIG.judgeMaxTokens("baseten"),
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: TOOL_NAME,
          description: "Report which candidate teams, if any, should be told about this discussion.",
          parameters: judgeJsonSchema(),
        },
      },
    ],
    tool_choice: { type: "function", function: { name: TOOL_NAME } },
  });

  // OpenAI-compatible usage uses prompt/completion rather than input/output;
  // map to the same gen_ai.* keys so one dashboard covers both backends.
  if (response.usage) {
    span.setAttribute("gen_ai.usage.input_tokens", response.usage.prompt_tokens);
    span.setAttribute("gen_ai.usage.output_tokens", response.usage.completion_tokens);
  }
  const finish = response.choices[0]?.finish_reason;
  if (finish) span.setAttribute("gen_ai.response.finish_reasons", [finish]);

  const message = response.choices[0]?.message;
  // Forced tool_choice is a request, not a guarantee — some reasoning models
  // answer with the JSON in content instead. Take either, and record which,
  // because a model that stops honouring tool_choice is worth knowing about.
  const toolArgs = message?.tool_calls?.find((c) => c.type === "function")?.function?.arguments;
  span.setAttribute("radar.judge.via", toolArgs ? "tool_call" : "content");
  const raw = toolArgs ?? message?.content ?? null;
  if (!raw) {
    span.setAttribute("radar.judge.outcome", "no_output");
    console.error(`[slack-radar] judge returned neither tool call nor content for ${label}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    span.setAttribute("radar.judge.outcome", "non_json");
    console.error(`[slack-radar] judge returned non-JSON for ${label}: ${raw.slice(0, 200)}`);
    return null;
  }

  // Validate rather than trust: a forced schema is advisory on this path.
  const result = JudgeResult.safeParse(parsed);
  if (!result.success) {
    span.setAttribute("radar.judge.outcome", "schema_invalid");
    console.error(
      `[slack-radar] judge output failed schema for ${label}: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    return null;
  }
  return result.data;
}

/* -------------------------------- dispatch ------------------------------- */

export interface JudgeOutcome {
  summary: string;
  matches: JudgedMatch[];
  /** Candidate teams the judge deliberately did not flag, with its reasoning. */
  declined: { team_key: string; reason: string }[];
}

/**
 * One model call per ripe discussion, scoring every shortlisted team at once.
 *
 * Scoring all candidates in a single call rather than one call per (discussion,
 * team) pair keeps cost linear in discussions instead of quadratic, and lets the
 * model pick the team that owns the subject rather than saying yes to three
 * overlapping ones.
 */
export async function judgeDiscussion(
  discussion: DiscussionRow,
  messages: MessageRow[],
  candidates: Candidate[],
  maxTranscriptChars: number,
): Promise<JudgeOutcome | null> {
  if (!candidates.length) return null;

  const user = `Candidate teams:\n${renderCandidates(candidates)}\n\n---\n\n${renderDiscussion(
    discussion,
    messages,
    maxTranscriptChars,
  )}`;
  const label = `discussion ${discussion.id}`;
  const backend = resolveBackend();

  // The judge is the only recurring model spend and the only place the system
  // makes a judgement call, so it gets its own span rather than being folded
  // into score_discussion. That separation is what lets you read judge latency,
  // token usage and refusal rate independently of the Postgres and Slack work
  // happening in the parent span.
  return getTracer().startActiveSpan(
    "judge_discussion",
    {
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": backend,
        "radar.discussion_id": discussion.id,
        "radar.judge.candidates": candidates.length,
        "radar.judge.prompt_chars": user.length,
      },
    },
    async (span) => {
      try {
        const parsed =
          backend === "baseten"
            ? await judgeViaBaseten(user, label, span)
            : await judgeViaAnthropic(user, label, span);
        if (!parsed) return null;

        const validKeys = new Set(candidates.map((c) => c.team.key));
        let dropped = 0;
        const matches = parsed.matches.filter((m) => {
          if (!validKeys.has(m.team_key)) {
            // The model occasionally invents a plausible-looking key. Dropping
            // it is safer than notifying the wrong team.
            dropped++;
            console.warn(`[slack-radar] judge returned unknown team_key "${m.team_key}", dropping`);
            return false;
          }
          return true;
        });

        span.setAttribute("radar.judge.outcome", "ok");
        span.setAttribute("radar.judge.matches", matches.length);
        // A non-zero rate here means the prompt is not constraining team_key
        // well enough on the current model — invisible without this attribute.
        span.setAttribute("radar.judge.dropped_unknown_keys", dropped);
              const declined = (parsed.declined ?? []).filter((d) => validKeys.has(d.team_key));
        span.setAttribute("radar.judge.declined", declined.length);
        return { summary: parsed.summary, matches: matches as JudgedMatch[], declined };
      } catch (err) {
        span.setAttribute("radar.judge.outcome", "error");
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
