---
description: Watches the Slack channels it is invited to, works out which discussions a team lead would want to know about, and DMs them - urgently if it cannot wait, otherwise in a digest.
tags:
  - slack
  - notifications
  - triage
  - product-management
repository: github:Simwar/slack-radar
---

<h1 align="center">slack-radar</h1>

A PM-shaped agent for Slack channel sprawl. Leads cannot read forty channels, so
decisions about their area get made in rooms they are not in. slack-radar reads
those rooms and tells them when something is worth their attention.

## What it does

**Continuously, in every watched channel:**

Records each message and folds it into a *discussion* (a thread, or a top-level
message and whatever follows it). No model runs on this path — ingest is an
INSERT, which is what makes watching dozens of channels affordable.

**On each `discussion_sweep` run:**

1. **Picks ripe discussions** — a thread that has been quiet for ~20 minutes, or
   has crossed 8 messages while still live. Never one that just started.
2. **Shortlists teams** with a free lexical pass over topics and keywords. A
   team is never a candidate in one of its own home channels — it is already in
   the room.
3. **Judges** with one model call per discussion, scoring every shortlisted team
   at once against four signal types: a *decision* forming, an *unanswered
   question*, an *incident*, or a thread *escalating*.
4. **Notifies** — urgent items DM the lead immediately (inside working hours
   only); everything else waits for the digest. A (discussion, team) pair is
   only ever raised once.

**On each `lead_digest` run:**

Sends each lead one grouped message with everything pending, highest confidence
first, each with a link straight to the thread.

**Neither job has a default schedule.** Both are entered at deploy time and the
agent does nothing until they are. The cadences below are what this design
assumes, not what you get:

| Job | Suggested | Why |
|---|---|---|
| `discussion_sweep` | `*/15 * * * *` | The real latency floor — nothing is judged sooner than the next tick. `*/5` if 15 minutes is too slow for incidents, at 3x the pod churn. |
| `lead_digest` | `0 9,14 * * 1-5` | Start of morning and after lunch. **Keep it inside working hours:** this job has no working-hours gate of its own, so an hourly cron DMs every lead at 03:00. |

`ast agent redeploy --id <id> --adapter slack --schedule <job>='<cron>'`
sets or changes them. `--adapter slack` is required every time: it defaults to
`web`, and omitting it drops Slack ingestion silently.

**Always:**

Leads react :+1: or :-1: on any notification. A (team, channel) pairing that
keeps getting thumbs-downed has to clear a higher confidence bar next time, so
the radar gets quieter where it is wrong without anyone editing config.

**On @mention or DM:**

- "who owns X?" — resolves an area to a team and its leads
- "what did I miss?" — recent flagged discussions for your teams
- "has anyone mentioned X?" — literal search across everything observed
- "also watch me for X" / "stop sending me X" — edits your subscription live
- "mute me for the afternoon" — pauses delivery

## What gets you pinged, and when

**15 minutes is the floor for everything** — set by the sweep cadence, not by any
threshold. Nothing is judged instantly, by design: a thread has to settle before
it is worth an opinion.

| You post | Outcome |
|---|---|
| "the api gateway is down, anyone on it?" | `incident`, high urgency → **DM in ~15 min** (weekday 09:00-18:00; otherwise held for the digest) |
| "should we move rate limiting into the gateway?" | `decision` → **DM if the choice is landing**, else digest. The case this agent exists for. |
| "what's the link to our API gateway?" | trivial ask → **digest at most**. If this pings you, the bar is too low. |
| "anyone up for lunch?" | no keyword overlap → **no model call, no cost, nothing** |
| Anything in a channel your team already lives in | **nothing, ever** — it is not news to you (`home_channels`) |
| A thread you were already pinged about, now 30 messages | **no second DM** — matches are raise-once |
| A CI or GitHub app posting an alert | **invisible** — the platform drops bot-authored messages |

A thread with replies flowing trips the burst rule and is judged on the next
sweep regardless of how long it has been quiet, so real incidents are fast while
a lone unanswered message waits for the silence window. Full gate-by-gate rules,
timings and a "why didn't I get pinged" checklist are in `README.md`.

## Containers

| Container | Trigger | Role |
|---|---|---|
| `agent` | always-on | Records every observed message (no model call). Answers leads on @mention/DM. Runs schema DDL and bootstraps the registry from `TEAMS_CONFIG` if it is empty. |
| `discussion_sweep` | schedule (set at deploy) | Ripeness, prefilter, judge, raise matches, urgent DMs, feedback collection, retention purge. |
| `lead_digest` | schedule (set at deploy) | Per-lead rollup of everything pending. |

## Configuration

Nothing operational lives in the repo — this is a blueprint. Watched channels
are set on the deploy page (**Observe Channel IDs** in the Slack section), and
the team registry lives in Postgres.

Bootstrap it by pasting JSON (or YAML) into the `TEAMS_CONFIG` deploy input:

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

Only `key` is required. The full field list is `key`, `name`, `description`,
`leads`, `topics`, `keywords`, `home_channels`, `realtime`, `min_confidence` —
**anything else is ignored without warning**, which is the usual reason a
hand-written config does nothing. `leads` are Slack user IDs (`U…`), not
`@handles`, and the example placeholders are rejected on purpose.

Or skip the input entirely and DM the agent: *"set up a team for platform, I am
the lead, we own the API gateway"*.

`TEAMS_CONFIG` is applied only when the registry is empty, so a redeploy never
reverts what leads have tuned over Slack.

Always fill in a team's **home channels** — channels they already sit in are
never flagged for them, and it is the single most effective noise control here.
See `README.md` for the annotated field table, or `teams.example.yml` for a
worked example.

## Environment

| Variable | Source |
|---|---|
| `POSTGRES_HOST/PORT/USER/PASSWORD/DB` | `slackradardb` postgres knowledge provider |
| `ANTHROPIC_API_KEY` | top-level input — used by the agent AND the judge |
| `BASETEN_API_KEY` | top-level input — set it to move the whole agent to Baseten |
| `BASETEN_BASE_URL` / `BASETEN_MODEL` | top-level inputs — endpoint and model for the Baseten path |
| `RADAR_SLACK_BOT_TOKEN` | ingestion input — provider vars do not reach ingestion containers |
| `SLACK_WORKSPACE_DOMAIN` | top-level input, for building thread deep links |

## Model backends

Two paths, one switch. Leave `BASETEN_API_KEY` blank and everything runs on
Anthropic with `ANTHROPIC_API_KEY`; set it and everything — the Slack agent and
the relevance judge — runs on Baseten. Never a mix: the same rule is applied in
both containers, and Baseten wins if both keys are present.

Defaults are `claude-haiku-4-5` and `zai-org/GLM-4.7`. Both are deliberately
small: the judge runs once per ripe discussion, and the prompt plus the
prefilter do most of the precision work. Override with `ANTHROPIC_MODEL` /
`BASETEN_MODEL`, or `JUDGE_MODEL` to change only the judge.

Tuning (ripeness thresholds, prefilter strictness, working window, retention) is
hardcoded in `scheduler/src/config.ts` rather than exposed at deploy time — see
the table in `README.md`. Deploy asks only for credentials and workspace locale.

## Slack app setup

OAuth scopes: `channels:history`, `groups:history` (private channels),
`chat:write`, `im:write`, `reactions:read`, `users:read`.

Two separate requirements per channel, and missing either is silent: invite the
bot to the channel, **and** list the channel ID in the deploy page's **Observe
Channel IDs**.

Note the messaging sidecar drops any message carrying a Slack `bot_id`, so
alerts posted by other apps are invisible; a discussion started by a bot alert is
only seen from the first human reply onward.

## Data handling

Raw message text is stored in Postgres to make batched judging possible, and
deleted after `MESSAGE_RETENTION_DAYS` (default 30). Transcripts sent to the
model are anonymised to `person1`, `person2` — the judge does not need to know
who is speaking to decide whether a subject is a team's business. Matches and
notifications hold headlines, rationales and the one-line "where it landed"
summary — model-written prose about a thread, never message bodies. Those outlive the raw
text they were derived from, which is the point: a digest stays readable after
the transcript behind it has been purged.
