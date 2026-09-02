---
description: Watches every Slack channel it is invited to, works out which discussions a team lead would want to know about, and tells them - as an urgent DM if it cannot wait, otherwise in a twice-daily digest. Tunes itself on thumbs-up/thumbs-down reactions.
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

**Every 15 minutes (`discussion_sweep`):**

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

**At 09:00 and 14:00 on weekdays (`lead_digest`):**

Sends each lead one grouped message with everything pending, highest confidence
first, each with a link straight to the thread.

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
| `discussion_sweep` | schedule (*/15) | Ripeness, prefilter, judge, raise matches, urgent DMs, feedback collection, retention purge. |
| `lead_digest` | schedule (09:00, 14:00 weekdays) | Per-lead rollup of everything pending. |

## Configuration

Nothing operational lives in the repo — this is a blueprint. Watched channels
are set on the deploy page (**Observe Channel IDs** in the Slack section), and
the team registry lives in Postgres.

Bootstrap the registry by pasting YAML or JSON into the `TEAMS_CONFIG` deploy
input (shape: `teams.example.yml`), or skip it and DM the agent: *"set up a team
for platform, I am the lead, we own the API gateway"*. `TEAMS_CONFIG` is applied
only when the registry is empty, so a redeploy never reverts what leads have
tuned over Slack.

Always fill in a team's **home channels** — channels they already sit in are
never flagged for them, and it is the single most effective noise control here.

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
`chat:write`, `im:write`, `reactions:read`, `users:read`. Invite the bot to every
channel you want watched, and list those channel IDs in the deploy's
`observe_channel_ids` (`scripts/deploy.sh` builds this from
`WATCHED_CHANNEL_IDS`).

Note the messaging sidecar drops any message carrying a Slack `bot_id`, so
alerts posted by other apps are invisible; a discussion started by a bot alert is
only seen from the first human reply onward.

## Data handling

Raw message text is stored in Postgres to make batched judging possible, and
deleted after `MESSAGE_RETENTION_DAYS` (default 30). Transcripts sent to the
model are anonymised to `person1`, `person2` — the judge does not need to know
who is speaking to decide whether a subject is a team's business. Matches and
notifications hold headlines and rationales, never message bodies.
