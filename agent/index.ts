import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MastraAdapter } from '@astropods/adapter-mastra';
import type { AgentAdapter, StreamHooks, StreamOptions } from '@astropods/adapter-core';
import { serve } from '@astropods/adapter-core';
import { z } from 'zod';
import { getAgentTracer, setupObservability, startAgentTracing } from './observability';
import { runMigrations } from './migrate';
import { seedTeams } from './seed';
import { startHealthServer } from './health';
import { recordObservedMessage } from './ingest';
import { describeModel, resolveAgentModel, resolveBackend } from './model';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import {
  addTopics,
  listTeams,
  recentMatches,
  removeTopics,
  searchMessages,
  setLeadPrefs,
  skippedItems,
  teamsForLead,
  upsertTeam,
} from './registry';

const showTeams = createTool({
  id: 'showTeams',
  description:
    'List every team in the radar registry with its leads, topics, keywords, and home channels. Use this to answer "who owns X", "what am I subscribed to", or before editing a subscription.',
  inputSchema: z.object({}),
  execute: async () => {
    const teams = await listTeams();
    return {
      teams: teams.map((t) => ({
        key: t.key,
        name: t.name,
        description: t.description,
        leads: t.lead_slack_ids,
        topics: t.topics,
        keywords: t.keywords,
        home_channels: t.home_channel_ids,
        realtime: t.realtime_enabled,
        min_confidence: t.min_confidence,
      })),
    };
  },
});

const myTeams = createTool({
  id: 'myTeams',
  description:
    'List the teams a given Slack user is a registered lead for. Call this before editing subscriptions so you edit the right team.',
  inputSchema: z.object({
    slack_user_id: z.string().describe('Slack user ID of the caller, e.g. U012ABCDEF'),
  }),
  execute: async ({ slack_user_id }) => {
    const teams = await teamsForLead(slack_user_id);
    return { teams: teams.map((t) => ({ key: t.key, name: t.name, topics: t.topics })) };
  },
});

const watchTopics = createTool({
  id: 'watchTopics',
  description:
    'Add topics to a team so the radar starts flagging discussions about them. Topics are short natural-language descriptions, not keywords.',
  inputSchema: z.object({
    team_key: z.string().describe('Registry key of the team, from showTeams'),
    topics: z.array(z.string()).describe('Topics to start watching'),
    actor: z.string().describe('Slack user ID of whoever asked for this'),
  }),
  execute: async ({ team_key, topics, actor }) => {
    const n = await addTopics(team_key, topics, actor);
    return { added: n, team_key };
  },
});

const unwatchTopics = createTool({
  id: 'unwatchTopics',
  description:
    'Stop flagging a topic for a team. Works on topics that came from the seed file as well as ones added over Slack.',
  inputSchema: z.object({
    team_key: z.string(),
    topics: z.array(z.string()),
    actor: z.string().describe('Slack user ID of whoever asked for this'),
  }),
  execute: async ({ team_key, topics, actor }) => {
    const n = await removeTopics(team_key, topics, actor);
    return { removed: n, team_key };
  },
});

const setDelivery = createTool({
  id: 'setDelivery',
  description:
    'Change how a lead is notified: turn realtime DMs on or off (digest still arrives either way), pause all notifications for a number of hours, or LIFT an existing pause. To unmute someone, call this with pause_hours 0 and realtime true — that is the only way to clear a pause, and without it a lead who muted themselves stays muted until it expires.',
  inputSchema: z.object({
    slack_user_id: z.string(),
    realtime: z.boolean().optional().describe('false = digest only, true = realtime DMs allowed'),
    pause_hours: z
      .number()
      .optional()
      .describe('Silence everything for this many hours. Pass 0 to cancel an active pause.'),
  }),
  execute: async ({ slack_user_id, realtime, pause_hours }) => {
    await setLeadPrefs(slack_user_id, { realtime, pauseHours: pause_hours });
    return { ok: true, realtime, pause_hours };
  },
});

const registerTeam = createTool({
  id: 'registerTeam',
  description:
    'Create a team in the radar registry, or update an existing one. This is how the registry is managed — there is no config file to edit. Omit any field you are not changing; omitted fields keep their current value rather than being cleared. Call showTeams first if you are updating, so you can tell the user what changed.',
  inputSchema: z.object({
    team_key: z
      .string()
      .describe('Short stable identifier, lowercase, e.g. "platform". Reused to update the team later.'),
    name: z.string().optional().describe('Human name, e.g. "Platform"'),
    description: z
      .string()
      .optional()
      .describe('What the team owns, in a sentence. The judge reads this, so be concrete.'),
    leads: z
      .array(z.string())
      .optional()
      .describe('Slack user IDs (U…) who receive notifications. Not handles.'),
    topics: z
      .array(z.string())
      .optional()
      .describe('Short natural-language descriptions of what the team cares about, not keywords.'),
    keywords: z
      .array(z.string())
      .optional()
      .describe('Literal terms that indicate relevance, e.g. "gateway", "rate limit".'),
    home_channels: z
      .array(z.string())
      .optional()
      .describe(
        'Channel IDs (C…) the team already lives in. Discussions there are never flagged for this team, because they are already in the room. This is the most effective noise control available, so always ask for it.',
      ),
    min_confidence: z
      .number()
      .optional()
      .describe('0-1 bar a match must clear for this team. Default 0.6. Raise it if they find it noisy.'),
    realtime: z
      .boolean()
      .optional()
      .describe('false = this team only ever gets digests, never an interrupting DM.'),
  }),
  execute: async (input) => {
    try {
      await upsertTeam({
        key: input.team_key,
        name: input.name,
        description: input.description,
        leads: input.leads,
        topics: input.topics,
        keywords: input.keywords,
        home_channels: input.home_channels,
        realtime: input.realtime,
        min_confidence: input.min_confidence,
      });
      return { ok: true, team_key: input.team_key };
    } catch (err) {
      // Hand the reason back so the model can tell the user what to fix
      // (usually a Slack handle where an ID was needed) instead of retrying.
      return { ok: false, error: (err as Error).message };
    }
  },
});

const whatDidIMiss = createTool({
  id: 'whatDidIMiss',
  description:
    'Return the discussions the radar has flagged recently, optionally narrowed to specific teams. Use for "what did I miss", "anything on my radar today".',
  inputSchema: z.object({
    team_keys: z.array(z.string()).default([]).describe('Empty means all teams'),
    hours: z.number().default(24),
  }),
  execute: async ({ team_keys, hours }) => {
    const matches = await recentMatches(team_keys, hours);
    return {
      matches: matches.map((m) => ({
        team: m.team_key,
        signal: m.signal_type,
        urgency: m.urgency,
        confidence: m.confidence,
        headline: m.headline,
        why: m.rationale,
        link: slackArchiveLink(m.channel_id, m.root_ts),
        messages: m.message_count,
      })),
    };
  },
});

const whySkipped = createTool({
  id: 'whySkipped',
  description:
    'Show discussions the radar considered but deliberately did NOT notify anyone about, and why. Use this whenever someone asks why they were not told about something, or doubts the radar is catching things. Pass a term to narrow it (e.g. "gateway"), or omit it to see everything skipped recently.',
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe('Literal term to narrow to, matched against the discussion text. Omit for all.'),
    hours: z.number().default(24),
  }),
  execute: async ({ query, hours }) => {
    const items = await skippedItems(query ?? null, hours);
    return {
      skipped: items.map((i) => ({
        team: i.team_key,
        // 'declined' means the judge decided it did not warrant telling anyone.
        // Anything else was a real match that landed under the team's bar.
        outcome: i.signal_type === 'declined' ? 'judged not worth flagging' : 'scored below the bar',
        why: i.suppressed_reason,
        confidence: i.confidence,
        excerpt: i.root_text?.slice(0, 200) ?? null,
        link: slackArchiveLink(i.channel_id, i.root_ts),
      })),
    };
  },
});

const findMentions = createTool({
  id: 'findMentions',
  description:
    'Search the raw text of every message the radar has observed for a term. Use when someone asks whether a specific thing has come up anywhere.',
  inputSchema: z.object({
    query: z.string().describe('Literal term to search for'),
    hours: z.number().default(168),
  }),
  execute: async ({ query, hours }) => {
    const hits = await searchMessages(query, hours);
    return {
      hits: hits.map((h) => ({
        link: slackArchiveLink(h.channel_id, h.thread_ts),
        excerpt: h.text.slice(0, 300),
        at: h.posted_at,
      })),
    };
  },
});

/**
 * Build a Slack deep link without an API round-trip. `chat.getPermalink` is
 * nicer but costs a call per row, which is wasteful when the model is listing
 * twenty matches. The archives form resolves correctly in every Slack client.
 */
function slackArchiveLink(channelId: string, ts: string): string {
  const workspace = process.env.SLACK_WORKSPACE_DOMAIN;
  if (workspace) {
    return `https://${workspace}.slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
  }
  // Fallback is app_redirect, NOT a slack:// URI. Both open the right thread,
  // but slack:// is not an http(s) URL, so Slack does not render it as a
  // clickable link and the model tends to omit it from the reply as useless.
  // app_redirect is a normal https link that needs no workspace domain.
  return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${ts}`;
}

const instructions = `
You are slack-radar. You watch a lot of Slack channels on behalf of team leads and tell them when a
discussion they would want to know about is happening somewhere they are not.

In a DM or when @-mentioned you answer questions about that coverage and let leads tune it:
- "who owns X?" / "which team should see this?" — call showTeams and reason over topics and descriptions.
- "what did I miss?" / "anything on my radar?" — call whatDidIMiss, defaulting to the caller's own teams (myTeams).
- "has anyone mentioned X?" — call findMentions.
- "why didn't you tell me about X?" / "are you actually catching things?" — call whySkipped.
  Answer honestly with the recorded reason, even when it reflects badly on the radar. If something
  was skipped and the user disagrees, say which knob changes it: a team's min_confidence for a
  below-the-bar item, or that the judge simply did not think it worth an interrupt.
- "also watch me for X" / "stop sending me X" — call myTeams first to resolve which team, then watchTopics or unwatchTopics.
- "set up a team" / "add my team" / "watch X for me" when no team exists — call registerTeam.
  There is no config file: the registry lives in the database and this tool is the only way to change it.
  You need at minimum a key, a description of what they own, their Slack user ID as a lead, and some
  keywords. Always ask for home_channels too — channels the team already lives in are never flagged
  for them, and it is the single most effective way to keep the radar quiet.
- "too noisy" / "mute me for the afternoon" — call setDelivery with pause_hours.
- "unmute me" / "turn it back on" / "I'm back" — call setDelivery with pause_hours 0 and realtime true.
  Always offer this if someone asks what their current settings are and they are paused.

Every message you receive ends with a "Caller context" line giving the Slack user ID and channel of
whoever is talking to you. Use that user ID for the actor and slack_user_id arguments. Never ask the
user for their own Slack ID, and never guess one.

If a lead asks to watch a topic for a team they are not a lead of, do it anyway but say plainly which
team you changed, so a mistake is visible.

If the registry is empty (showTeams returns nothing), say so plainly and offer to set a team up. Until
at least one team exists with a lead and some keywords, the radar is recording messages but can never
notify anyone.

Never narrate what you are about to do. Do not write "I'll check...", "Let me look...", or "Now
let me...". Any text you emit before or between tool calls is delivered to the user as part of your
reply, concatenated with no separator, so narration shows up as run-together sentences and reads as
broken. Call the tools silently, then write the answer once.

Format rules:
- Slack markdown: *bold*, bullets with -, code with backticks. Links as <url|label>.
- ALWAYS include the link a tool returns in its "link" field for anything you mention, formatted
  <the-url|open thread>. A lead who cannot click through has to go hunting, which defeats the
  point of the whole agent.
- No em dashes. Use commas, colons, or periods.
- Lead with the answer. These are busy people; three to six lines is usually right.
`.trim();

const agent = new Agent({
  id: 'slack-radar',
  name: 'slack-radar',
  instructions,
  model: resolveAgentModel(),
  tools: {
    showTeams,
    myTeams,
    registerTeam,
    watchTopics,
    unwatchTopics,
    setDelivery,
    whatDidIMiss,
    whySkipped,
    findMentions,
  },
});

/**
 * The adapter wrapper is where the real work happens.
 *
 * The messaging sidecar forwards every message from every observed channel.
 * For the overwhelming majority of them the right behaviour is: write it down,
 * say nothing, spend no tokens. Only a direct @mention or DM reaches the model.
 * That is what makes watching dozens of channels affordable — ingest is an
 * INSERT, and judgement is batched into the scheduled sweep.
 */
class PmRadarAdapter implements AgentAdapter {
  readonly name: string;
  constructor(private readonly inner: MastraAdapter) {
    this.name = inner.name;
  }
  getConfig() {
    return this.inner.getConfig();
  }

  async stream(prompt: string, hooks: StreamHooks, options: StreamOptions): Promise<void> {
    // One span per inbound message. Mastra's observability only starts at the
    // model call, so without this the ingest path — which is deliberately most
    // of the traffic and never reaches the model — produces no telemetry at
    // all. `radar.engaged` is the attribute to group on: it separates "wrote a
    // row and said nothing" from "actually answered someone".
    return getAgentTracer().startActiveSpan(
      'inbound_message',
      {
        attributes: {
          'radar.event_kind': options.platformContext?.eventKind ?? 'none',
          'radar.channel_id': options.platformContext?.channelId ?? 'none',
          'radar.prompt_chars': prompt.length,
        },
      },
      async (span) => {
        try {
          await this.handle(prompt, hooks, options, span);
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  private async handle(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions,
    span: Span,
  ): Promise<void> {
    const ctx = options.platformContext;
    const kind = ctx?.eventKind;
    const isDM = kind === 'EVENT_KIND_DM';

    // Guarantee onFinish fires exactly once, on every exit path.
    //
    // The messaging sidecar keeps the turn open (Slack shows the bot as still
    // typing) until it gets the END chunk that only onFinish produces. The
    // Mastra adapter fires it solely on a "finish" stream chunk, and not at all
    // on onError. Reasoning models served over Baseten's OpenAI-compatible API
    // routinely end a stream without that chunk, so without this guard a turn
    // hangs open forever. Applied on both backends: it costs nothing on
    // Anthropic and removes a whole class of "the bot never replied" reports.
    let finished = false;
    const finishOnce = () => {
      if (finished) return;
      finished = true;
      hooks.onFinish();
    };
    const wrapped: StreamHooks = {
      ...hooks,
      onError: (error: Error) => {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        console.error(`[slack-radar] stream error conv=${options.conversationId}:`, error?.stack ?? error);
        hooks.onError(error);
        finishOnce();
      },
      onFinish: finishOnce,
    };

    // Ingest first, and never let a write failure swallow a message the user is
    // waiting on an answer to. DMs are a private conversation with the bot, not
    // team discussion, so they are not recorded.
    if (ctx && !isDM) {
      try {
        await recordObservedMessage(ctx, prompt);
        span.setAttribute('radar.ingested', true);
      } catch (err) {
        // Swallowed on purpose — a write failure must not cost the user their
        // answer. But it has to be visible: logging alone made a broken ingest
        // look identical to an idle channel on the dashboards.
        span.setAttribute('radar.ingested', false);
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'ingest failed' });
        console.error('[slack-radar] ingest failed:', (err as Error).message);
      }
    } else {
      span.setAttribute('radar.ingested', false);
    }

    // The adapter strips its own mention from APP_MENTION text, so eventKind is
    // the reliable "was I addressed" signal — except for a mention inside a
    // thread, which arrives as THREAD_REPLY with <@bot> left in place.
    const mentionsBot = !!ctx?.botUserId && prompt.includes(`<@${ctx.botUserId}>`);
    const addressed = kind === 'EVENT_KIND_APP_MENTION' || isDM || mentionsBot;

    // ctx is undefined for the playground and direct gRPC, where we always answer.
    span.setAttribute('radar.engaged', Boolean(!ctx || addressed));
    if (ctx && !addressed) {
      finishOnce();
      return;
    }

    let cleaned = ctx?.botUserId ? prompt.replaceAll(`<@${ctx.botUserId}>`, '').trim() : prompt;
    if (ctx?.userId) {
      cleaned += `\n\n(Caller context: Slack user ${ctx.userId} in channel ${ctx.channelId}.)`;
    }

    try {
      await this.inner.stream(cleaned, wrapped, options);
    } catch (err) {
      wrapped.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (!finished) {
        // Countable on purpose: this is the Baseten reasoning-model failure
        // mode, and a rising rate here is the signal to change model.
        span.setAttribute('radar.missing_finish_chunk', true);
        console.warn(
          `[slack-radar] stream ended with no finish chunk conv=${options.conversationId}; closing turn`,
        );
        finishOnce();
      }
    }
  }

  streamAudio(...args: Parameters<MastraAdapter['streamAudio']>) {
    return this.inner.streamAudio(...args);
  }
}

async function main() {
  startHealthServer();          // bind :8080 first so liveness never waits on Postgres
  startAgentTracing();          // register the global provider before anything traces
  console.log(`[slack-radar] ${describeModel()}`);
  if (resolveBackend() === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.error('[slack-radar] no ANTHROPIC_API_KEY and no BASETEN_API_KEY — every model call will fail.');
  }
  setupObservability(agent);
  await runMigrations();
  await seedTeams();
  serve(new PmRadarAdapter(new MastraAdapter(agent)));
}

main().catch((err) => {
  console.error('[slack-radar] fatal boot error:', err);
  process.exit(1);
});
