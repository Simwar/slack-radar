# slack-radar — agent harness guide

An Astropods agent that watches many Slack channels, decides which discussions a
team lead would want to know about, and notifies them. Use this file as the
reference for structure and conventions; any coding agent (Claude Code, Cursor,
Copilot) can read it to work in this repo correctly.

Built on the same topology as `git-to-it` (always-on messaging agent + scheduled
ingestion + managed Postgres). If something here looks unexplained, the
equivalent in `git-to-it/AGENTS.md` probably explains why.

## Project structure

```
slack-radar/
├── agent/                  # Always-on messaging agent (Mastra + Astro adapter)
│   ├── index.ts            # Tools, instructions, and PmRadarAdapter (ingest hook + finish guard)
│   ├── model.ts            # Anthropic vs Baseten resolution — the swap seam
│   ├── ingest.ts           # Persist observed messages, fold into discussions. No model call.
│   ├── registry.ts         # Team/lead/subscription queries backing the agent's tools
│   ├── seed.ts             # Bootstrap the registry from TEAMS_CONFIG (only when empty)
│   ├── migrate.ts          # Idempotent schema DDL, advisory-locked, run in-process at boot
│   ├── db.ts               # Shared pg pool + transient-error retry
│   ├── health.ts           # /health (readiness + liveness)
│   └── Dockerfile
├── scheduler/              # Both ingestion jobs, one source tree
│   ├── src/
│   │   ├── index.ts        # discussion_sweep entry point
│   │   ├── digest-job.ts   # lead_digest entry point
│   │   ├── sweep.ts        # ripeness → prefilter → judge → raise → urgent DM
│   │   ├── prefilter.ts    # free lexical shortlist, runs before any model call
│   │   ├── judge.ts        # one call per discussion; Anthropic + Baseten backends
│   │   ├── model.ts        # backend resolution (mirror of agent/model.ts)
│   │   ├── notify.ts       # message formatting, working-hours window, realtime DM
│   │   ├── digest.ts       # per-lead rollup
│   │   ├── feedback.ts     # reactions on DMs → training signal
│   │   ├── config.ts       # ALL tuning constants, hardcoded. Mirrored in README.
│   │   ├── db.ts           # every query the jobs make
│   │   └── observability.ts
│   ├── Dockerfile          # sweep
│   └── Dockerfile.digest   # digest (same image, different CMD)
├── teams.example.yml       # Shape of TEAMS_CONFIG. Not read at runtime.
├── astropods.yml           # Spec: agent, knowledge, inputs, ingestion
├── AGENT.md                # Catalog card
└── AGENTS.md               # This file
```

## Topology (astropods.yml)

| Section | Entry | Role |
|---|---|---|
| `agent` | `agent` | Always-on messaging surface and the entire ingest path. Runs DDL + `TEAMS_CONFIG` bootstrap at boot. Serves `/health`. |
| `inputs` | model keys | `ANTHROPIC_API_KEY` / `BASETEN_API_KEY` as **top-level** inputs, so one value reaches every container. There is deliberately no `models:` provider entry — see below. |
| `knowledge` | `slackradardb` | Managed `postgres`. Injects `POSTGRES_*` into all containers. |
| `ingestion` | `discussion_sweep` | Schedule (*/15). Scoring and urgent delivery. |
| `ingestion` | `lead_digest` | Schedule (09:00, 14:00 weekdays). Rollup delivery. |

## The one idea that makes this work

The messaging sidecar forwards **every** message from every observed channel to
the agent container. `PmRadarAdapter.stream()` intercepts that before the model
runs, writes the message to Postgres, and calls `hooks.onFinish()` to stay
silent. Only a direct @mention or DM ever reaches the model.

So ingest is an INSERT per message, and all judgement is batched into the
scheduled sweep, on discussions that have gone quiet. That is what makes
watching dozens of channels affordable, and it is why the expensive logic lives
in `scheduler/` rather than in the agent's tool calls.

## Two model paths

There are exactly two, and the whole agent moves between them together:

| | Anthropic (default) | Baseten |
|---|---|---|
| Selected by | `BASETEN_API_KEY` blank | `BASETEN_API_KEY` set |
| Key | `ANTHROPIC_API_KEY` | `BASETEN_API_KEY` |
| Agent model | `anthropic/<ANTHROPIC_MODEL>` (default `claude-haiku-4-5`) via Mastra's router | Mastra `OpenAICompatibleConfig` at `BASETEN_BASE_URL` |
| Endpoint | api.anthropic.com | Baseten **Model APIs**, `inference.baseten.co/v1/chat/completions` |
| Judge transport | `messages.parse()` + `output_config.format` | forced function call over `chat.completions` |

The rule lives in `agent/model.ts` and `scheduler/src/model.ts` — **duplicated,
because the two containers do not share a package, and it must stay identical**.
Baseten wins when both keys are set. There is no per-container override on
purpose: a mixed deploy would be near-impossible to notice.

Both keys are **top-level inputs**, which the platform injects into every
container. That is why there is no `models: { anthropic: … }` provider entry — a
provider entry injects `ANTHROPIC_API_KEY` into the agent container only, which
would force the sweep to carry a second copy of the same secret.

Three things that are genuinely different between the paths, all learned from
`agents-draft/agent2`:

1. **Never call the AI-SDK provider as a function on Baseten.** `baseten(model)`
   targets OpenAI's *Responses* API, which Baseten does not implement, and the
   stream hangs forever instead of erroring. Mastra's `OpenAICompatibleConfig`
   is `/chat/completions`, which is why it is used here rather than
   `@ai-sdk/openai`'s `createOpenAI`.
2. **Reasoning models end streams without a finish chunk.** The Mastra adapter
   only fires `onFinish()` on that chunk, so a turn stays open and Slack shows
   the bot typing forever. `PmRadarAdapter` guarantees `onFinish()` fires
   exactly once on every exit path, including errors. Applied on both backends.
3. **Baseten has no equivalent of Anthropic's `output_config.format`.** The judge
   forces a single named function call and validates the arguments with the same
   zod schema the Anthropic path passes to `zodOutputFormat`, so the two cannot
   drift. Every Baseten model supports tool calling, so this is portable across
   the whole catalogue. `JUDGE_EFFORT` is Anthropic-only and ignored here.

   Baseten also supports `response_format` with a JSON schema, and now exposes an
   Anthropic Messages API at `/v1/messages` (beta). Either could replace the
   forced-tool-call approach; neither is worth the churn while this works, and
   the beta endpoint is not somewhere to put the only judge.

### The model list goes stale

`BASETEN_MODEL`'s options in `astropods.yml` are a snapshot. The first version
was copied from Mastra's bundled provider registry, and five of its seven entries
had already been retired upstream — a deployer picking one from the dropdown
would have got a failure at the first model call. Before editing that list:

```bash
curl https://inference.baseten.co/v1/models -H "Authorization: Bearer $BASETEN_API_KEY"
```

If you move from Model APIs to a **dedicated deployment**, the endpoint shape
changes and `BASETEN_BASE_URL` is the knob — that is what it exists for.

## The impact layer

Between the lexical prefilter and the judge sits one call to the gateway's
decision model (`jev-1-13-0`, `scheduler/src/decide.ts`). It exists because the
prefilter is a **hard gate**: a discussion that matters but never uses a team's
keywords scored 0 and returned before any model saw it, so no prompt change
could ever rescue it.

It is not a third backend. The decisions API returns typed answers only — a
probability, an option, a level — and no free text, so every prose field a
notification needs still comes from the judge. This layer decides *whether to
spend a judge call*, and passes its numbers into the judge prompt as evidence.

It runs on **every** ripe discussion, not only the ones the prefilter rejected,
because it has to be able to reject as well as rescue — approval requests and CI
chatter otherwise keep reaching the judge on a keyword hit.

Three things to know before changing it:

1. **The question wording is load-bearing, more than the thresholds are.** The
   first draft asked "is this converging on a choice that will be acted on" and
   scored *"anyone up for lunch? / I'm in"* at **0.85** — correctly, they were
   deciding lunch. Scoping it to "a technical, product or process choice" took
   the same thread to 0.01. An approval request likewise scored `unanswered`
   0.73 on "can someone approve when free?" until the question excluded routine
   review requests. Re-run the scenario sweep after any edit.
2. **A noise type is never a drop reason on its own.** `JEV_NOISE_MAX_IMPACT`
   guards it, because README scenario 8 says a CI alert with human replies is
   legitimate. Measured: a clean build notification scores `customer_affecting`
   0.04 and drops, an alert plus "customers can't pay" scores 0.98 and goes to
   the judge.
3. **Fail open, always.** `scoreImpact()` returns `null` on any error, timeout
   or missing gateway, and the sweep carries on with the lexical result. A
   scoring layer that swallowed every discussion when the gateway blipped would
   look exactly like a quiet week.

Every score is persisted to `discussions.last_impact` including for dropped
discussions — a drop means a lead was never told, which is the same class of
decision as a suppressed match and needs the same paper trail. It is also what
makes the thresholds re-derivable from real traffic instead of from intuition.

### What the judge no longer has to guess

The prompt used to say "do not flag discussions where someone from the team is
already clearly participating". The judge could never obey it — transcripts are
anonymised to `person1`/`person2` before they are sent. That instruction is gone,
and `eligibleTeams()` in `prefilter.ts` now removes any team whose lead is in
`discussions.participants`. Free, exact, and it is the fix for leads seeing their
own threads flagged back at them.

The same reasoning is why the impact scorer is not asked about participation.
Asked anyway, on an anonymised transcript, it answered **0.48** — a calibrated
way of saying "you did not tell me". Do not ask a model what Postgres knows.

## Cost model

There are two recurring model spends: one small decision call per ripe
discussion, and one judge call per discussion that survives it. The judge is far
the larger. It runs once per discussion that went ripe and then survived the
impact gate with at least one candidate team — which since the impact layer can
mean a team the prefilter never found. Four levers, in order of effect:

1. `PREFILTER_MIN_SCORE` — raise it and fewer discussions reach the judge at
   all. This is free precision; it costs recall.
2. `JEV_IMPACT_FLOOR` / `JEV_NOISE_MIN_CONFIDENCE` — raise these and more
   discussions are dropped before the judge. Not free (the decision call still
   happens) but it is the lever that cuts judge calls without costing the recall
   that `PREFILTER_MIN_SCORE` does.
3. `JUDGE_MODEL` — decouples the judge from the chat agent on whichever backend
   is active, in either direction.
4. Switch to Baseten and pick a Flash/Fast tier or `openai/gpt-oss-120b`. Check
   current rates with `/v1/models` rather than trusting a figure written here —
   the catalogue moves.

The Anthropic default is `claude-haiku-4-5`: the judge is a high-volume triage
classifier, and the prompt does the precision work. If the :+1:/:-1: ratio comes
in short during rollout, `ANTHROPIC_MODEL=claude-sonnet-5` is the first thing to
try — but tighten `PREFILTER_MIN_SCORE` and the team `min_confidence` floors
first, since those cost nothing.

**`effort` is model-gated.** Haiku 4.5 and Sonnet 4.5 reject
`output_config.effort` with a 400, so `judge.ts` sends it only for families
known to accept it (`EFFORT_CAPABLE`). It is an allow-list on purpose: omitting
`effort` is always valid, sending it wrongly is a hard failure.

`SWEEP_MAX_DISCUSSIONS` caps spend per run. Hitting the cap is logged as a
warning, never silently truncated.

## The registry can point at nobody, so it is validated

`upsertTeam` rejects a lead that is not a `U…` ID, and separately rejects the
placeholder IDs this project ships in `teams.example.yml` and the `TEAMS_CONFIG`
comment. That second check exists because it happened: a deploy bootstrapped
from the example verbatim, everything worked perfectly, and the DM went to
`U000EXAMPLE1` — `conversations.open` returned `user_not_found`, a match was
raised, nobody was told, and the only evidence was one line in the ingestion
workload's log. The ID is well-formed, so a shape check cannot catch it.

A real ID cannot be verified from the agent container (it holds no Slack token),
but our own placeholders can be, and they are what actually gets pasted. If you
add a new example ID anywhere, use the `U000EXAMPLE*` / `C000EXAMPLE*` form so
the guard covers it.

Delivery failures are also recorded on the `score_discussion` span
(`radar.delivery_failures`, with the Slack error code) and set the span to
ERROR, so a registry pointing at a non-existent lead shows up in traces rather
than only in logs.

## Configuration lives in code, not in inputs

`astropods.yml` asks the deployer for nine things, all credentials or workspace
facts. Every tuning constant — ripeness thresholds, spend ceilings, prefilter
strictness, feedback weighting, emoji names, retention — is hardcoded in
`scheduler/src/config.ts`, with the corresponding `inputs:` entries left
commented out in the spec.

They started as inputs and that was wrong: it made `ast project configure` look
like twenty decisions, when nobody has the information to beat the defaults until
the radar has run for a week. Credentials and locale are the only things a
deployer actually knows on day one.

Each constant still reads its env var before falling back to the literal, so
re-exposing one is: un-comment the input, redeploy. No code change. That is why
`config.ts` is a set of `num()`/`str()` calls rather than bare constants — do not
"simplify" them into literals.

`MESSAGE_RETENTION_DAYS` is the one entry there that is policy rather than
tuning. If a privacy review ever needs it adjustable without a deploy, that is
the first one to promote back to an input.

## Instrumentation

Two exporters, because the two containers have different constraints, and both
are needed.

**Agent container** (`agent/observability.ts`) has *two* independent setups:

| Setup | Covers | Why both |
|---|---|---|
| `setupObservability(agent)` — Mastra `Observability` | agent runs, tool calls, LLM calls | Only fires when the model actually runs. |
| `startAgentTracing()` — adapter-core's `getOrCreateAstroTracerProvider` | `inbound_message` span per message | The design point is that observed messages are recorded WITHOUT running the model, so Mastra sees none of it. Ingest would be completely invisible otherwise — and it is the bulk of the traffic. |

`inbound_message` attributes: `radar.event_kind`, `radar.channel_id`,
`radar.prompt_chars`, `radar.ingested`, `radar.engaged`,
`radar.missing_finish_chunk`. Group on `radar.engaged` to separate "wrote a row
and stayed silent" from "actually answered someone".
`radar.missing_finish_chunk` is the Baseten reasoning-model failure mode made
countable — a rising rate there is the signal to change model.

**Scheduler** (`scheduler/src/observability.ts`) uses a hand-rolled
`FetchTraceExporter`. Under Bun the standard node:http OTLP transport reports a
phantom "Request timed out"; a short-lived cron process exits before that can be
retried, so it needed a fetch-based transport. Verified end-to-end against a
local collector: nested spans arrive with correct parenting and `service.name`,
and `shutdownTracing()` flushes before exit.

Span tree:

```
discussion_sweep                 gen_ai.provider.name, gen_ai.request.model,
│                                radar.teams, radar.ripe_discussions,
│                                radar.capped_out, radar.feedback_rated, …
└── score_discussion             discussion.id/channel/messages,
    │                            discussion.candidates, discussion.outcome,
    │                            discussion.matches_raised, realtime_sent
    └── judge_discussion         gen_ai.* incl. usage.input_tokens /
                                 usage.output_tokens, radar.judge.outcome,
                                 radar.judge.matches, radar.judge.candidates,
                                 radar.judge.dropped_unknown_keys

lead_digest                      radar.leads_total/sent/failed,
└── send_digest (per lead)       radar.matches_delivered
                                 radar.digest.outcome, items_shown, items_hidden
```

The judge gets its own span rather than folding into `score_discussion` so that
judge latency, token usage and refusal rate can be read independently of the
Postgres and Slack work in the parent. `gen_ai.usage.*` is normalised across
backends — Anthropic reports `input_tokens`/`output_tokens`, the Baseten path
reports `prompt_tokens`/`completion_tokens`, and both are written to the same
keys so one dashboard covers either.

Things worth alerting on, none of which are visible from logs alone:
`radar.capped_out=true` (coverage was incomplete this run),
`radar.judge.outcome != ok`, `radar.leads_failed > 0`,
`radar.ingested=false` with an exception recorded.

**Do not call `forceFlush()` on the agent provider without a catch.** Under Bun
it rejects with the phantom timeout even though the spans were delivered.
adapter-core's signal handlers already wrap it; our code must too.

## Noise control, in the order it applies

Every one of these exists because a PM notifier that cries wolf gets muted in a
week, and a muted agent is worth nothing.

1. **`home_channels`** on a team — never matched in a channel it
   already lives in. Fill this in first.
2. **Ripeness** (`SWEEP_QUIET_MINUTES`, `SWEEP_MIN_AGE_MINUTES`) — never judge a
   thread on its first message.
3. **Lexical prefilter** — most discussions never reach the judge. Note the
   team-name match is worth 0.5, below `PREFILTER_MIN_SCORE`: team names are
   often ordinary words ("Agent", "Platform", "Core") and in the company that
   owns that product they appear in nearly every message. At full weight a team
   called Agent matched "the agent is great, nice work team".
4. **Judge prompt** — instructed to default to no match, with an explicit
   do-not-flag list (casual mentions, routine chatter, already-answered
   questions, a team member already participating).
5. **Per-team `min_confidence`** floor.
6. **Feedback loop** — thumbs-down raises the bar for that (team, channel) pair.
7. **Once-only** — `UNIQUE(discussion_id, team_key)` plus `ON CONFLICT DO
   NOTHING`; a re-scored escalating thread cannot re-notify.
8. **Digest by default** — only `urgency: high` interrupts, and only inside the
   working window.

If someone reports the radar is noisy, walk this list in order before touching
the prompt.

## Making changes

- Agent conversation behaviour / tools: `agent/index.ts`.
- Which provider/model runs: `agent/model.ts` + `scheduler/src/model.ts`, or
  just set `BASETEN_API_KEY` at deploy time.
- What counts as worth flagging: the `SYSTEM` prompt in `scheduler/src/judge.ts`.
- Ripeness, thresholds, delivery: `scheduler/src/sweep.ts` (config at the top).
- Message wording: `scheduler/src/notify.ts` and `scheduler/src/digest.ts`.
- Schema: the `DDL` in `agent/migrate.ts`. It runs advisory-locked and
  idempotent at agent boot; there is no separate migration job. **The scheduler
  never creates tables** — it assumes the agent booted first.
- New config: add under `inputs` or the relevant `ingestion[].inputs` in
  `astropods.yml`, then read via `process.env`.

Two things are duplicated across the containers because they do not share a
package, and a shared one is not worth the build complexity. Both must be edited
together:

- `EFFECTIVE_TOPICS_SQL` — `agent/registry.ts` and `scheduler/src/db.ts`.
- The backend resolution rule — `agent/model.ts` and `scheduler/src/model.ts`.

## Platform gotchas inherited from git-to-it

- **Provider-scoped vars do not reach ingestion containers, but top-level
  inputs do.** That split is why the Slack token is a per-ingestion input
  (`RADAR_SLACK_BOT_TOKEN` — `SLACK_BOT_TOKEN` is claimed by the messaging
  adapter and routed to the sidecar) while the model keys are top-level inputs.
  Anything both containers need should be a top-level input.
- **The AI gateway is an exception to that, and it was verified rather than
  assumed.** `ASTRO_GATEWAY_URL` and `ASTRO_GATEWAY_API_KEY` **do** reach
  ingestion containers even though they come from a `models: { provider:
  gateway }` entry. The mechanism is different from a provider credential: the
  CLI **mints a short-lived gateway key per workload** rather than propagating
  one static var — `AI Gateway development key minted` prints on `ast project
  start` and again on every `ast project trigger`. Checked on `ast/0.22.1` by
  logging presence from inside `ingestion.discussion_sweep`, then by making a
  real `/v1/decisions` call from that container. The `impact …` line the sweep
  prints every run is the standing check, so this does not have to be
  rediscovered.
- **Never `ast agent redeploy` directly** — use `scripts/deploy.sh`, which pins
  `--adapter slack` (the CLI defaults to `web` and silently drops Slack
  ingestion) and rebuilds `SLACK_CONFIG` from `WATCHED_CHANNEL_IDS`.
- **Never set an allowlist.** A non-empty `allowed_channel_ids` makes the
  sidecar post "This app has not been enabled for this channel or user" into
  every channel it rejects, before the agent runs. We pass `observe_channel_ids`
  only and gate in `agent/index.ts`.
- **Bot-authored messages never arrive.** The sidecar filters on `bot_id`.
- **Crons are not in `astropods.yml`** for deployed jobs (`dev.schedules` is
  local only). They are entered at fresh `ast deploy` and preserved on redeploy,
  so changing a cadence needs a delete + fresh deploy.

## Adding a watched channel

Listening is **not** part of the team registry. Two things are required, and
missing either one produces a bot that looks healthy and sees nothing:

1. **Invite the bot to the channel** in Slack (`/invite @slack-radar`). Slack sends
   nothing for a channel the app is not a member of.
2. **Add the channel ID to `observe_channel_ids`** in `astropods.yml` under
   `dev.interfaces.messaging.slack`, then run `scripts/deploy.sh`.

That list in `astropods.yml` is the single source of truth. `scripts/deploy.sh`
parses it and rebuilds `SLACK_CONFIG` for the deployed agent, so local dev and
production cannot disagree. (It used to be written out twice — once in the spec
for dev, once as a default in the script — and nothing would have told you they
had drifted.) `WATCHED_CHANNEL_IDS=C1,C2 scripts/deploy.sh` overrides for a
one-off deploy; an empty list aborts rather than deploying a blind agent.

### Why `observe_channel_ids` is the whole ingest surface

The sidecar forwards a non-@mention message to the agent ONLY if its channel is
on that list. A channel with the bot invited but missing from the list is
invisible: the sidecar drops the message ("Ignoring top-level message") before
the agent runs, with no error anywhere.

There is deliberately **no channel gate in the agent**. `git-to-it` had one
(`SLACK_CHANNEL_ID`) because it watched exactly one channel; slack-radar records
every channel the sidecar forwards, so the observe list is the only control.
Never add an `allowed_channel_ids` allowlist — see the platform-gotchas section.

### `home_channels` is the opposite thing

Easy to mistake for a listen list. `home_channels` marks channels a team
**already lives in**, so a discussion there is never matched to that team — it
is not news to them. It is a per-team noise filter applied after ingest, and it
has no effect on what the bot listens to. A channel can be watched globally and
be some team's home channel at the same time; that is the normal case.

## Going fast (demos, tuning loops)

There is no demo mode. There was a `DEMO_MODE` flag; it was removed because it
was a second code path for behaviour the ordinary constants already express, and
because a flag that silently rewrites five thresholds is easy to leave on. The
equivalent is explicit:

```bash
SWEEP_QUIET_MINUTES=1 SWEEP_MIN_AGE_MINUTES=0 SWEEP_BURST_MESSAGES=3
RADAR_WINDOW_DAYS=0-6 RADAR_WINDOW_START=00:00 RADAR_WINDOW_END=23:59
```

Keep to timing values. Loosening the prefilter, judge prompt or confidence
thresholds instead would put a different product on stage than the one in the
repo, which is the one property worth protecting here.

`RADAR_WINDOW_DAYS` is what makes a weekend rehearsal possible at all — the day
gate used to be a hardcoded `day === 0 || day === 6` that no timezone value
could get around. It is also a real production knob for teams that work
weekends.

The cron is the real latency floor and no env var moves it, so a fast loop also
needs a more frequent `discussion_sweep` in `dev.schedules`.

`scripts/demo-reset.sql` clears observed and derived state while keeping the
team registry. It exists because matches are raise-once, so a rehearsal
permanently consumes the demo message. Runbook: `docs/DEMO.md`.

## Known astro-cli issues

Two confirmed CLI bugs (v0.17.1) affect this project directly, and together they
mean **a schedule-triggered ingestion cannot be run or fully configured in local
dev**: `ast project trigger` always fails on a flag it does not own, and
`ast project configure` never prompts for `ingestion.<job>.inputs` (which is why
`RADAR_SLACK_BOT_TOKEN` has to be a deploy var and has a code-level fallback).

Details, source excerpts, suggested fixes and workarounds:
**[docs/CLI-ISSUES.md](docs/CLI-ISSUES.md)**. Re-check these before assuming a
local scheduling problem is in this repo.

## Running locally

```bash
ast project configure   # set required inputs
ast project start
ast project logs
ast project stop
```

## Spec reference

Run `ast docs` for the full `astropods.yml` spec and agent development guide.
