# astro-cli issues found while building slack-radar

Found against **`ast/0.17.1 (44dc0cf) BETA`** on 2026-09-02 by reading the
`astro-cli` source, and re-checked against **`0.22.1`** on 2026-09-28.

---

## 1. `ast project trigger` always fails — FIXED in 0.22.1

It read an `--env` flag defined only on `devCmd`/`devStartCmd`, so the empty
value collapsed to the project directory and `godotenv.Read` failed on it.
Verified working on 0.22.1: a schedule-triggered ingestion now runs on demand.

Issue 2 stands, and with 1 fixed it is the only thing left blocking a fully
configured schedule-triggered ingestion in local dev.


## 2. `ast project configure` never prompts for ingestion-scoped inputs

**Symptom**

An input declared under `ingestion.<job>.inputs` cannot be set locally. For
slack-radar that is `RADAR_SLACK_BOT_TOKEN`, and the failure is quiet in the worst
way: the job runs, judges correctly, writes its result, then cannot call Slack.
Nothing is delivered, and because the work is already recorded as done it is
never retried.

**Cause**

`cmd/configure.go` collects credential vars, messaging vars, top-level
`spec.Inputs` (line 331) and `spec.Agent.Inputs` (line 346). `spec.Ingestion` is
never referenced in the file at all, so those inputs are not in the prompt set
and end up in neither `~/.ast/project-configs.json` nor the container env.

**Suggested fix**

Iterate `astroSpec.Ingestion[*].Inputs` alongside the agent inputs, ideally
labelled with the owning job so a name that appears in two jobs is
distinguishable.

**Workaround used**

Pass it as a deploy var:

```bash
ast agent redeploy --id <id> --adapter slack --var RADAR_SLACK_BOT_TOKEN=xoxb-…
```

And in code, fall back to the adapter's token so a half-configured deploy still
delivers (`scheduler/src/slack.ts`):

```ts
const token = process.env.RADAR_SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
```

---

## Related, and probably by design

`dev.schedules` drives nothing locally. Schedule-triggered ingestions are put
in Compose's `ingestion` profile, which `compose up` does not start:

```go
// internal/compose/builder.go:551-553
} else {
    service.Profiles = []string{"ingestion"}
}
```

So a `dev.schedules` cron is inert — `docker ps` shows no ingestion container,
and nothing is ever processed however long you wait. On-demand is a reasonable
design, but the cron being accepted and silently ignored is misleading.

Worth either honouring `dev.schedules` with a local scheduler, or warning at
`project start` that the listed crons will not fire locally.
