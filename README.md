# slack-radar

A PM-style agent for Slack channel sprawl. It watches every channel it is
invited to, works out which discussions a given team lead would want to know
about, and tells them — urgently if it cannot wait, otherwise in a twice-daily
digest. It gets quieter where it is wrong, based on reactions.

## Quick start

```bash
ast project configure   # ANTHROPIC_API_KEY, RADAR_SLACK_BOT_TOKEN, SLACK_WORKSPACE_DOMAIN
ast project start
```

To run everything on Baseten instead, set `BASETEN_API_KEY` (and optionally
`BASETEN_MODEL`) and leave `ANTHROPIC_API_KEY` blank. The switch covers both the
Slack agent and the relevance judge — there is no mixed mode.

Then:

1. **Invite the bot** to every channel you want watched (`/invite @slack-radar`).
2. **List those channel IDs** in the deploy page's Slack section, under
   **Observe Channel IDs**. Leave **Allowed Channel IDs** blank. For local dev,
   use `dev.interfaces.messaging.slack.observe_channel_ids` in `astropods.yml`.
3. **Set up at least one team**, either by pasting a registry into the
   `TEAMS_CONFIG` input at deploy time (shape: `teams.example.yml`) or simply by
   DMing the agent: *"set up a team for platform, I am the lead, we own the API
   gateway and rate limiting"*.

Step 2 makes the bot *listen*. Step 3 decides who gets *told* — until a team
exists with a lead and some keywords, the radar records messages but can never
notify anyone.

Both halves of steps 1 and 2 are required: a channel with the bot invited but
absent from Observe Channel IDs is silently invisible, because the sidecar drops
its messages before the agent runs.

### Nothing operational lives in this repo

This is a blueprint, so it carries no channel list and no team registry. Both are
per-deployment config:

| | Where it lives | Changed by |
|---|---|---|
| Watched channels | Slack adapter config (**Observe Channel IDs**) | the deploy page |
| Team registry | Postgres, bootstrapped from `TEAMS_CONFIG` | the deploy page once, then Slack |

`TEAMS_CONFIG` is **bootstrap only** — applied when the registry is empty and
ignored afterwards. If it were re-applied on every boot, a redeploy would
silently revert every change leads had made through the agent.
`teams.example.yml` documents the shape and is not read at runtime.

## Project structure

```
slack-radar/
├── agent/         # Always-on agent: records every message, answers leads on @mention/DM
├── scheduler/     # discussion_sweep (scoring + urgent DMs) and lead_digest (rollups)
├── teams.example.yml  # Shape of the TEAMS_CONFIG input (not read at runtime)
├── astropods.yml  # Agent specification
├── AGENT.md       # Catalog card
└── AGENTS.md      # Topology, conventions, and platform gotchas
```

See `AGENTS.md` before changing anything.

## Push and deploy

```bash
ast login
ast blueprint push slack-radar
ast blueprint deploy slack-radar
```

Redeploys go through `scripts/deploy.sh`, never `ast agent redeploy` directly —
the script pins `--adapter slack` and rebuilds the watched-channel list.

## How it decides, and when

Every message runs the same gauntlet. It is worth reading in order, because most
"why didn't I get pinged?" questions are answered by the first three gates and
have nothing to do with the model.

| # | Gate | Fails silently if... |
|---|---|---|
| 1 | **Bot is in the channel** | not invited — Slack sends nothing at all |
| 2 | **Channel is in `observe_channel_ids`** | missing — the sidecar drops the message before your agent runs |
| 3 | **Message is human-authored** | posted by an app — the sidecar filters on `bot_id` |
| 4 | **Ripe**: 10 min silence, or 8+ messages, and at least 10 min old | too new — nothing is judged instantly, by design |
| 5 | **Prefilter**: a team scores ≥ 1 on keywords/topics, and it is not that team's `home_channel` | no keyword overlap — costs nothing, no model call |
| 6 | **Judge** says a lead would want it, at confidence ≥ the team's `min_confidence` (0.6) | judged not worth flagging — the common case, by design |
| 7 | **Delivery**: `urgency: high` + weekday 09:00–18:00 → DM now. Otherwise → next digest | outside the window, or lead paused/digest-only |

Gates 1–3 are configuration. Gate 4 is timing. Gate 5 is free. Only gate 6 costs
money, and only gate 7 decides whether you are interrupted.

### Timing

**15 minutes is the floor for everything**, set by the `*/15` sweep cron — not by
any threshold. Nothing is judged sooner, however urgent.

| Thread shape | First judged |
|---|---|
| Someone posts and replies flow in (8+ messages) | 15 min |
| Someone posts and nobody replies | 15 min (10 min silence, rounded to the next tick) |
| Slow thread, a reply every 10-15 min | when it goes quiet for 10 min, or hits 8 messages |
| Already-flagged thread that keeps growing | re-judged at 2× the message count, and never re-notified |

`SWEEP_BURST_MESSAGES` is what makes real incidents fast, not the quiet window: a
thread with replies coming in trips it and is judged on the next tick regardless
of how long it has been silent. To go below 15 minutes you must change the cron
(`*/5` → ~10 min floor, 3× the pod churn); lowering the thresholds achieves
nothing on its own.

### Worked scenarios

Every outcome below was checked against the real prefilter and config, using the
sample `platform` team from `teams.example.yml` (keywords `gateway, envoy, rate
limit, sso, …`, with a `home_channels` entry set).

**1. "the api gateway is down, anyone on it?" — in a watched channel**
Prefilter scores 2.5 and reaches the judge. Judged `incident`, `urgency: high`.
→ **DM within ~15 min** if it is a weekday between 09:00 and 18:00. Outside those
hours it is held for the next digest rather than waking anyone.

**2. Same message, but posted in one of platform's own `home_channels`**
Prefilter returns nothing: the team is never a candidate in a channel listed as
its own. → **Nothing, ever.** They are already in the room.
This is intended, and it is the system's single biggest noise saving.

**3. "What's the link to our API Gateway"**
Prefilter scores 2.5, so it does reach the judge — but the judge is told the bar
is "would want to track or jump in" and to default to no match, so a request for
a link should be declined. If it is flagged it would be `unanswered_question`,
`urgency: normal`. → **Digest at most, never a DM.** If messages like this do get
flagged, the bar is too low: raise the team's `min_confidence`.

**4. "should we move rate limit config out of envoy into the gateway itself?"**
Scores 4.5 — the strongest of these, matching two keywords and a topic. Judged
`decision`, and `urgency: high` only if it looks like it is being settled in that
conversation. → **DM if the decision is landing, otherwise digest.** This is the
case the whole agent exists for: a choice about your area being made somewhere
you are not.

**5. "anyone up for lunch?" / "deploy 4.2.1 finished successfully"**
Prefilter scores 0 for every team, and the impact scorer agrees — measured, both
come back under 0.15 on every question, and the deploy line classifies as
`status_update` at 1.00. → **No judge call, no notification.**

Note the cost shape changed when impact scoring was added: this traffic used to
be free, and now costs one small decision call (~700 tokens) per ripe discussion.
That is the price of scenario 9 below, which the free prefilter could never
catch.

**6. A thread you were already pinged about grows to 30 messages**
Re-judged once it doubles in size, but `UNIQUE(discussion_id, team_key)` plus
`ON CONFLICT DO NOTHING` means the match is raise-once. → **No second DM.**
Re-notifying about the same thread is the most annoying thing this agent could
do, so it cannot.

**7. You react 👎 on a notification**
Recorded against that `(team, channel)` pairing. After 5 rated notifications the
pairing's confidence bar starts rising (up to +0.3). → **That team gets quieter
in that channel** without anyone editing config.

**8. A GitHub/CI app posts "gateway health check failing"**
The sidecar drops anything with a `bot_id` before it reaches the agent. →
**Invisible.** A discussion kicked off by an app alert is only seen from the
first human reply onward. Once a human does reply, the impact scorer decides on
substance rather than on the thread looking automated: measured, an alert plus
*"this is hitting checkout, customers can't pay"* scores `customer_affecting`
0.98 and reaches the judge, while a clean build notification scores 0.04 and is
dropped.

**9. "who owns the thing that decides whether a trial converts to paid?"**
No team's keywords appear anywhere in it, so the prefilter scores 0 and before
impact scoring this was **invisible** — the judge was never called, so no prompt
change could have rescued it. The scorer reads `unanswered` 0.94 and names
`billing` as the owner at 0.65, which adds billing as a judge candidate. →
**Reaches the judge on substance, with no keyword hit.** This is the case the
impact layer exists for.

### If you expected a ping and got nothing

In the order worth checking:

1. Were the containers running when you posted? The sidecar only sees live
   events — Slack does not replay, so a message sent while the agent was down is
   simply gone.
2. Is the channel in `observe_channel_ids`? Invited-but-unlisted is silent.
3. Has 15 minutes passed?
4. Is it a weekday between 09:00 and 18:00 in `RADAR_TIMEZONE`? Outside that,
   even a high-urgency match waits for the digest.
5. Is the channel one of that team's `home_channels`?
6. **DM the bot "what did I miss"** — that reads matches directly and ignores
   digest state, so it separates "the judge declined it" from "it was never
   ingested". The `judge_discussion` trace span's `radar.judge.outcome`
   attribute tells you the same thing.

## Configuration

Deploy time asks for **eight** top-level values, plus the gateway model to use
and the Slack bot token on each scheduled job. All of them are either a
credential or a fact about your workspace:

| Input | Notes |
|---|---|
| `TEAMS_CONFIG` | Optional. Initial team registry as YAML or JSON; bootstrap only. Blank means set it up over Slack. |
| `ANTHROPIC_API_KEY` | Used by the agent *and* the judge. Required unless using Baseten. |
| `ANTHROPIC_MODEL` | Default `claude-haiku-4-5`. |
| `BASETEN_API_KEY` | Set this and the whole agent runs on Baseten instead. |
| `BASETEN_BASE_URL` | Default `https://inference.baseten.co/v1` (Model APIs). Change this for a dedicated deployment. |
| `BASETEN_MODEL` | Default `zai-org/GLM-4.7`. Options are a snapshot of Baseten Model APIs — verify with `/v1/models` before changing. |
| `SLACK_WORKSPACE_DOMAIN` | The `acme` in `acme.slack.com`, for thread deep links. |
| `RADAR_TIMEZONE` | Timezone the realtime-DM working window is evaluated in. |
| `RADAR_SLACK_BOT_TOKEN` | Per ingestion job — provider vars do not reach those containers. |
| `MODEL_DEFAULT` | Picked from the gateway model menu at deploy. Currently unread: the decision model takes its id in the request body. |

### Writing `TEAMS_CONFIG`

This is the only input with any shape to it. Paste JSON (preferred) or YAML:

```json
{"teams":[
  {"key":"platform",
   "name":"Platform",
   "description":"Owns the API gateway, auth/SSO and rate limiting.",
   "leads":["U01ABCDEFGH"],
   "keywords":["gateway","envoy","rate limit","sso","429"],
   "topics":["API gateway routing and rate limits"],
   "home_channels":["C01ABCDEFGH"]}
]}
```

| Field | Required | Notes |
|---|---|---|
| `key` | **yes** | Stable identifier. Everything else can be added later over Slack. |
| `name` | no | Display name. Also matched, at half weight — a bare name mention never qualifies on its own. |
| `description` | no | Prose, what the team owns. The judge reads this to decide ownership, so it earns its length. |
| `leads` | no | Slack **user IDs** (`U…`), not `@handles`. Profile → "Copy member ID". No leads means nobody to tell, so the team is skipped. |
| `topics` | no | Phrases describing the area. Scored higher than keywords (1.5 vs 1). |
| `keywords` | no | Literal terms. Single words match whole words only — `hallucination` will not match `hallucinating`. Multi-word entries match as substrings. |
| `home_channels` | no | Channels the team already reads. Never flagged for them. **Fill this in** — it is the single biggest noise saving here. |
| `realtime` | no | `false` = digest only, never an instant DM. Default `true`. |
| `min_confidence` | no | 0-1 bar a match must clear. Default `0.6`. |

Four things that bite:

1. **Unknown fields are ignored without warning.** A hand-written config using
   invented keys (`urgent_triggers`, `ignore`, …) parses fine and does nothing.
   The nine above are the whole list.
2. **Prefer JSON.** YAML depends on line breaks, and this value passes through
   web forms and shell variables that can flatten it to one line — which still
   looks right on screen and parses to nothing. In YAML, quote anything numeric
   (`"429"`) or it is read as a number.
3. **Don't use your own product's name as a keyword.** In a company that builds
   agents, `agent` is in nearly every message: every discussion would reach the
   model and be rejected. Pure cost, no signal.
4. **Placeholder IDs are rejected on purpose.** `U000EXAMPLE1` and friends pass
   the format check but fail at `conversations.open` with `user_not_found` —
   a match raised, nothing delivered, one log line in the ingestion workload.

`TEAMS_CONFIG` is read **only when the registry is empty**. After the first
deploy the registry lives in Postgres and leads edit it by DMing the agent, so
re-applying it every boot would silently undo their tuning. To make the input
win again, clear the registry first — deliberately a manual act.

`teams.example.yml` is the fully annotated version of the above. It is not read
at runtime and not shipped in the image.

Everything else is **hardcoded in `scheduler/src/config.ts`**, which is the
single source of truth for tuning. The table below mirrors it. (`JUDGE_MODEL` is
the one exception, resolved in `scheduler/src/model.ts` since it depends on which
backend is active.)

These were deploy-time inputs at first, and that was a mistake: it made
`ast project configure` look like twenty decisions when nobody has the
information to beat the defaults until the radar has run for a week. The
corresponding `inputs:` entries are commented out in `astropods.yml` rather than
deleted, and every constant still reads its env var first — so re-exposing one
is a two-line change with no code deploy.

### Behaviour constants

**Ripeness — when a discussion is ready to judge**

| Constant | Default | Effect |
|---|---|---|
| `SWEEP_QUIET_MINUTES` | 10 | Silence after which a thread has said its piece. Governs only low-activity threads; real incidents are caught by the burst rule instead. 15 min is the effective floor either way, set by the sweep cron. |
| `SWEEP_BURST_MESSAGES` | 8 | ...or this many messages while still live. **This** is what makes real incidents fast, not the quiet window. Drop to 4 to catch smaller incident threads. |
| `SWEEP_MIN_AGE_MINUTES` | 10 | Never judge anything younger, however busy it looks. |
| `SWEEP_MAX_AGE_HOURS` | 48 | Stop considering discussions idle this long. |
| `SWEEP_ESCALATION_FACTOR` | 2 | Re-judge only once a thread has grown this much. |

**Spend ceilings**

| Constant | Default | Effect |
|---|---|---|
| `SWEEP_MAX_DISCUSSIONS` | 60 | Hard cap on judge calls per run; overflow is logged, not dropped. |
| `SWEEP_CONCURRENCY` | 4 | Judge calls in flight at once. |
| `SWEEP_MAX_MESSAGES` | 80 | Messages loaded per discussion. |
| `SWEEP_MAX_TRANSCRIPT_CHARS` | 6000 | Transcript characters sent to the judge. |
| `JUDGE_MAX_TOKENS` | 2000 / 4000 | Output ceiling; higher on Baseten, whose reasoning models spend tokens first. |
| `JUDGE_EFFORT` | `low` | Only sent to models that accept it — Haiku 4.5 rejects it with a 400. |
| `JUDGE_MODEL` | inherits | Run a different model for the judge than for chat. Resolved in `scheduler/src/model.ts`, not `config.ts`, because it depends on the active backend. |

**Matching**

| Constant | Default | Effect |
|---|---|---|
| `PREFILTER_MIN_SCORE` | 1 | Lexical bar to reach the judge. **The main cost lever** — raise it to spend less, at the cost of recall. Scoring: keyword hit +1, topic hit +1.5, team-name mention +0.5 (deliberately below the bar, so a bare name mention never qualifies). |
| `PREFILTER_MAX_TEAMS` | 3 | Most teams considered per discussion. |
| `NOISE_PENALTY` | 0.3 | How hard 👎 raises the bar for a (team, channel) pair. `0` disables the feedback loop. |
| `NOISE_MIN_SAMPLES` | 5 | Ratings needed before that feedback is trusted. |

**Impact scoring** — the gateway decision model, run on every ripe discussion
before the judge. Inactive (and logged as such) if the gateway is not configured.

| Constant | Default | Effect |
|---|---|---|
| `JEV_MODEL` | `jev-1-13-0` | Decision model id. |
| `JEV_IMPACT_FLOOR` | 0.15 | Drop only if **every** impact question scores under this. Far below 0.5 on purpose — anything hedged goes to the judge. |
| `JEV_NOISE_TYPES` | `approval_request,ci_alert,status_update` | Thread types treated as noise. |
| `JEV_NOISE_MIN_CONFIDENCE` | 0.85 | How sure the classifier must be of a noise type before it counts. |
| `JEV_NOISE_MAX_IMPACT` | 0.5 | ...and the impact ceiling below which a noise type may be dropped. Keeps "it looks automated" from dropping a CI alert about a real outage (scenario 8). |
| `JEV_OWNER_MIN_PROB` | 0.5 | Confidence needed before a team the lexical prefilter missed is added as a judge candidate. |
| `JEV_MAX_TEAMS` | 12 | Teams offered to the "which team owns this?" question. |
| `JEV_MAX_TRANSCRIPT_CHARS` | 4000 | Transcript sent to the scorer. |
| `JEV_TIMEOUT_MS` | 8000 | After this it falls back to lexical-only and says so. |

Every score is persisted to `discussions.last_impact` whatever these thresholds
do, including for dropped discussions, so they can be re-derived from real
traffic rather than from intuition:

```sql
SELECT last_impact_outcome, count(*) FROM discussions
 WHERE last_impact IS NOT NULL GROUP BY 1;
```

**Delivery and feedback**

| Constant | Default | Effect |
|---|---|---|
| `RADAR_WINDOW_START` | 09:00 | Earliest an urgent DM may be sent. |
| `RADAR_WINDOW_END` | 18:00 | Latest an urgent DM may be sent; outside the window items fall through to the digest. |
| `RADAR_WINDOW_DAYS` | `1-5` | Days an urgent DM may be sent (`0` = Sunday). Range, list, or both; ranges wrap, so `5-1` is Fri–Mon. Set `0-6` for a team that works weekends. |
| `DIGEST_MAX_ITEMS` | 12 | Items shown per digest; the rest stay available via "what did I miss". |
| `USEFUL_EMOJI` / `NOISE_EMOJI` | `+1` / `-1` | What leads react with to rate a notification. |
| `FEEDBACK_LOOKBACK_HOURS` | 120 | How far back to poll for reactions. |
| `FEEDBACK_MAX_CHECKS` | 150 | Reaction lookups per run. |
| `MESSAGE_RETENTION_DAYS` | 30 | Raw message text is deleted after this. **Policy, not tuning** — re-expose this one as an input first if a privacy review needs it changeable without a deploy. |

## Demoing it

Production timings make it undemoable — 15 minutes to a DM, and realtime
delivery only on weekdays 09:00-18:00. There is no demo *mode*; there are the
constants above, set explicitly:

```bash
SWEEP_QUIET_MINUTES=1 SWEEP_MIN_AGE_MINUTES=0 SWEEP_BURST_MESSAGES=3 \
RADAR_WINDOW_DAYS=0-6 RADAR_WINDOW_START=00:00 RADAR_WINDOW_END=23:59
```

Nothing there touches the prefilter, the judge prompt or the confidence
thresholds, so an audience watches the same logic that runs in production decide
things. That was the point of the old `DEMO_MODE` flag, and spelling the values
out keeps the property while removing a second code path that could drift from
the first — and a flag that is easy to leave switched on.

Pair it with a once-a-minute `discussion_sweep` cron (the cron is the real
latency floor) and reset between rehearsals with `scripts/demo-reset.sql` —
matches are raise-once, so re-posting the same demo message does nothing.

Full runbook, beat by beat: **[docs/DEMO.md](docs/DEMO.md)**.

## Rollout

Start narrow. Two or three teams and half a dozen channels for a week is enough
to see whether the judge's bar is set right, and it is much easier to widen
coverage than to win back a lead who muted you on day two.

While rolling out, watch:

- **Precision** — the ratio of :+1: to :-1: reactions per team. Below ~70%
  useful, tighten `PREFILTER_MIN_SCORE` or the team's `min_confidence` before
  touching the judge prompt.
- **Recall** — ask leads weekly whether anything reached them by other means
  that should have been on the radar. This is the failure mode the reaction
  loop cannot see.
- **Cost** — one judge call per ripe discussion that clears the prefilter.
  `SWEEP_MAX_DISCUSSIONS` is the ceiling per run.
