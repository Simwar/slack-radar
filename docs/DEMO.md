# Demoing slack-radar to leads and PMs

A live demo in a real Slack workspace, ~10 minutes. The audience is people who
would *receive* these notifications, so the thing to prove is not that it works
— it is that **it will not become another thing they mute**.

Plan the demo around that. The payoff beat takes two minutes; the anti-noise
beats take four, and they are the ones that decide whether anyone adopts it.

---

## Before the room

### 0. Local dev does not run the sweep at all

Worth knowing before anything else: `ast project start` puts schedule-triggered
ingestions in Compose's `ingestion` profile, which `compose up` never starts.
`dev.schedules` drives nothing locally — there is no sweep container, so nothing
is ever judged no matter how long you wait.

`ast project trigger discussion_sweep` is meant to be the answer, but it is
currently broken (`cmd/dev.go` reads an `--env` flag that only exists on the
parent command, so it tries to read the project directory as a dotenv file).
Until that is fixed, run the sweep container by hand against the dev stack, or
demo from a deployed environment where the cron genuinely runs.

**This is a real argument for demoing from prod rather than locally:** deployed,
the sweep is a real scheduled job and fires on its own.

### 1. Set the demo timings

Production timings make this undemoable: a lone message takes 15 minutes to
reach a DM, and realtime delivery only happens on weekdays between 09:00 and
18:00.

```bash
SWEEP_QUIET_MINUTES=1     # a lone message goes ripe in 1 min, not 10
SWEEP_MIN_AGE_MINUTES=0   # no minimum age
SWEEP_BURST_MESSAGES=3    # a 3-message thread is judged without waiting for quiet
RADAR_WINDOW_DAYS=0-6     # rehearse on a weekend
RADAR_WINDOW_START=00:00  # ...and at any hour
RADAR_WINDOW_END=23:59
```

Set them via `ast project configure`, and change the sweep cadence in
`astropods.yml` under `dev.schedules` to run **every minute** (`* * * * *`)
instead of every fifteen. The cron is the real latency floor — no env var moves
it, so this step is not optional.

These are timing values only: none of them touches the prefilter, the judge
prompt or the confidence thresholds. What the audience watches make decisions is
the same code that runs in production. Resist the urge to lower `min_confidence`
to guarantee a hit; if the demo needs that, the demo message is wrong, not the
threshold.

The sweep prints a loud warning every run while it is on. Turn it off afterwards.

### 2. Set up channels

Four channels, all with the bot invited **and** listed in
`dev.interfaces.messaging.slack.observe_channel_ids`. Both are required —
invited-but-unlisted is silently invisible.

| Channel | Role in the demo |
|---|---|
| `#eng-platform` | The platform team's own channel. Set it as their `home_channels` when you register the team. Used to show suppression. |
| `#product-general` | Where the decision gets made. The lead is *not* watching this one. |
| `#support-escalations` | Where the incident surfaces. |
| `#random` | Where the "costs nothing" message goes. |

Register the `platform` team with **yourself** as its lead so the DMs arrive in
your Slack, and screen-share your own client. Either paste a registry into the
`TEAMS_CONFIG` input or just DM the agent — doing it live over Slack is a good
opening beat in its own right. Do not demo with a colleague as
the recipient unless you have rehearsed with them — you cannot see what they see.

### 3. Rehearse, then reset

Raise-once is per *thread*, not per wording: `UNIQUE(discussion_id, team_key)`
where a discussion is `(channel, thread root)`. **A brand new message is a new
discussion**, so re-posting the same text gets judged and notified again. You do
not need a reset just to rehearse.

What a reset is actually for: clearing `lead_prefs` after demoing "mute me for
the afternoon", and starting from a clean slate so old test messages do not turn
up in "what did I miss".

```bash
docker exec -i <postgres-container> psql -U <user> -d <db> < scripts/demo-reset.sql
```

Run it before you start. It keeps `teams` and topic overrides, clears everything
observed or derived, and clears `lead_prefs` — a "mute me for the afternoon"
left over from rehearsal is the most confusing possible failure.

**No database access (e.g. deployed to prod)?** You do not need it. Post fresh
messages rather than re-using threads, and undo a pause by DMing the bot
"unmute me" — `setDelivery` with `pause_hours: 0` clears it, which is why the
tool description spells that out.

### 4. Pre-flight, two minutes before

- [ ] Containers running, `ast project logs` streaming on a second screen
- [ ] Sweep log shows the demo timings in effect, and the cron is `* * * * *`
- [ ] Reset script run
- [ ] Your own Slack DMs with the bot open and visible
- [ ] A rehearsed message in each channel, ready to paste

---

## The flow

### Beat 0 — The problem (30s, no software)

> "How many Slack channels are you in? How many do you actually read? The ones
> you don't are where decisions about your area get made without you."

Do not open the tool yet. Let them agree with the problem first.

### Beat 1 — It is already listening, and saying nothing (1 min)

Post ordinary chatter in `#product-general`. Nothing happens.

> "It has read that and written it down. It will not post in your channels. A
> bot that talks in a channel is a bot you mute in a week."

Counterintuitive and worth dwelling on: the ingest path never calls a model, so
this is nearly free.

### Beat 2 — The payoff (2 min) ⭐

In `#support-escalations`, as a human user:

> the api gateway is down, anyone on it?

Within about a minute a DM arrives: headline, one line of why, a quoted line on
where the thread got to, and a link to it. **Click the link on screen** and land in the conversation.

> "I was not in that channel. I did not search for anything."

### Beat 3 — The one that actually costs money (2 min) ⭐

In `#product-general`:

> should we move rate limit config out of envoy into the gateway itself? leaning
> yes, will start Monday unless anyone objects

DM: a decision forming.

> "This is the expensive one. Nothing was broken, nobody was paged, and a
> decision about my area was about to be settled in a channel I am not in."

That is the whole product. If you cut a beat, do not cut this one.

### Beat 4 — Why you will not mute it (3 min) ⭐

The objection is coming, so raise it first.

**a. Most messages cost nothing.** Post in `#random`:

> anyone up for lunch?

Nothing. Show the sweep log: no candidate teams, no model call.

**b. It knows where you already are.** Post the *same gateway-down message* in
`#eng-platform`:

> "Nothing. That is the platform team's own channel — they are in the room. Not
> news." Point at the team's `home_channels`.

**c. It gets quieter where it is wrong.** React 👎 on one of the DMs.

> "That is the entire feedback interface. One click. After five ratings, that
> team's bar in that channel starts rising. Nobody edits a config file."

### Beat 5 — Ask it things (1-2 min)

DM the bot:

- `who owns SSO?` — routing
- `what did I miss today?` — the catch-up surface
- `also watch me for billing webhooks` — subscription changes live, no PR
- `mute me for the afternoon` — the escape hatch, and say out loud that it exists

### Beat 6 — The digest (30s)

Trigger `lead_digest` manually rather than waiting for 09:00.

> "Only genuinely urgent things interrupt. Everything else arrives in a batch
> in one message, not five pings."

### Close

> "Every design decision in it is aimed at not being muted: silent by default,
> nothing on the first message, never twice about the same thread, nothing about
> rooms you are already in, and it gets quieter where you tell it it is wrong."

---

## Failure modes, and what to say

| Symptom | Cause | Recovery |
|---|---|---|
| No DM after ~2 min | Cron still `*/15`, or the timing vars unset | Check the sweep log. Have a pre-flagged item and use `what did I miss` instead. |
| Nothing at all, ever | Channel not in `observe_channel_ids`, or bot not invited | Move to a channel you verified in rehearsal. |
| Worked in rehearsal, not now | Match already raised for that thread | You skipped the reset. Post a *differently worded* message. |
| Judge declines your message | Message too trivial | Expected, and worth saying so: "the bar is 'would you want to jump in', and it just decided no." |
| DM arrives but the link is a `slack://` URI | `SLACK_WORKSPACE_DOMAIN` unset | Cosmetic; set it before the demo. |

If a beat fails, **narrate it as the design working**. An audience of leads
trusts a notifier that admits when it declined something far more than one that
fires every time.

---

## Afterwards

Unset every variable from step 1, and restore `discussion_sweep` to
`*/15 * * * *`. Left in place, those timings judge half-formed threads, and
`RADAR_WINDOW_DAYS=0-6` with a midnight-to-midnight window is how you end up
DMing people at 03:00 on a Sunday — the exact behaviour the rest of the design
exists to prevent.

Unsetting is genuinely required: there is no flag to flip back, which is the
trade for there being no second code path that can drift from production.

---

## Demoing from a deployed environment

Often the better option, because the scheduler actually runs there.

**Set the ingestion token as a deploy var.** `ast project configure` does not
prompt for ingestion-scoped inputs, which is why `RADAR_SLACK_BOT_TOKEN` is easy
to miss. It is passed explicitly by the deploy script:

```bash
RADAR_SLACK_BOT_TOKEN=xoxb-… SLACK_WORKSPACE_DOMAIN=… scripts/deploy.sh
```

The code also falls back to `SLACK_BOT_TOKEN` if that is absent, so a
half-configured deploy still delivers — but set it explicitly.

**Set the crons at deploy.** There are no defaults: neither job runs until you
give it a schedule. They are preserved across redeploys, and changing one later
needs no delete — `ast agent redeploy --schedule <job>='<cron>'`. `*/15` is
right for real use; `*/5` is a reasonable compromise while demoing. Do not use
`*/1` in a deployed environment.

**Demo timings in prod.** They compress the ripeness thresholds but cannot beat
the cron, so on `*/15` you still wait up to 15 minutes. Unset them immediately
afterwards — `RADAR_WINDOW_DAYS` and the window hours are what stand between you
and DMing people at 03:00.

**No DB access is fine.** A fresh deploy gets a fresh database, so it starts
clean. For repeat runs, post new messages rather than re-using threads, and
clear a pause by DMing "unmute me".

## Testing loop (not the demo)

For tuning the judge rather than showing it off, the fastest cycle is the step-1
timings plus the one-minute cron, posting variations and watching
`radar.judge.outcome` on the `judge_discussion` span. `what did I miss` in a DM
reads matches directly and ignores digest state, so it separates "the judge
declined it" from "it was never ingested" — which is the ambiguity that wastes
the most time.

Calibration target for the first week: if *"what's the link to our API gateway"*
ever produces a notification, the bar is too low. Raise the team's
`min_confidence` before touching anything else.
