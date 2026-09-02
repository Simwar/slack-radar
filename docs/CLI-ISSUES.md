# astro-cli issues found while building slack-radar

Found against **`ast/0.17.1 (44dc0cf) BETA`** on 2026-09-02, both confirmed by
reading the `astro-cli` source rather than inferred from symptoms.

Together they mean **a schedule-triggered ingestion cannot be run or fully
configured in local dev at all**, which is worth stating as the headline: the
individual bugs look minor, the combination blocks local testing of any
scheduled job. That is what cost an afternoon on slack-radar — the sweep appeared
to be running and silently never had.

---

## 1. `ast project trigger` always fails: reads a flag it does not own

**Symptom**

```
$ ast project trigger discussion_sweep
🔄 Triggering ingestion: discussion_sweep
failed to read .env file: read /path/to/project: is a directory
```

Unfixable from the outside — creating a `.env` file does not help, because the
path never points at a file.

**Cause**

`--env` is defined only on `devCmd` and `devStartCmd`:

```go
// cmd/dev.go:88-90
for _, cmd := range []*cobra.Command{devCmd, devStartCmd} {
    cmd.Flags().String("env", utils.DefaultEnvFile, "Environment file for integration credentials")
```

`devTriggerCmd` is not in that list, but its handler reads the flag anyway:

```go
// cmd/dev.go:453-454
func runDevTrigger(cmd *cobra.Command, args []string) error {
    envFile := flagString(cmd, "env")   // → "" — flag not defined on this command
```

Empty string then reaches `LoadEnvFile`, where `filepath.Join` collapses to the
project directory, `os.Stat` succeeds *because a directory exists*, and
`godotenv.Read` fails on it:

```go
// internal/utils/utils.go:29-34
func LoadEnvFile(workingDir, envFile string) (map[string]string, error) {
    path := filepath.Join(workingDir, envFile)   // envFile "" → path == workingDir
    if _, err := os.Stat(path); err != nil {     // a directory passes this check
        return nil, nil
    }
    m, err := godotenv.Read(path)                // "is a directory"
```

**Suggested fix**

Harden `LoadEnvFile` rather than only adding the flag — that fixes every
caller, including future ones:

```go
info, err := os.Stat(path)
if err != nil || !info.Mode().IsRegular() {
    return nil, nil          // no env file: not an error
}
```

Adding `--env` to `devTriggerCmd` is worth doing as well, so the flag can
actually be passed to a trigger.

**Workaround used**

Ran the ingestion container by hand against the running dev stack:

```bash
docker build -f scheduler/Dockerfile -t slack-radar-sweep:local .
docker run --rm --network slack-radar-network --env-file <envfile> slack-radar-sweep:local
```

`POSTGRES_PASSWORD` has to be lifted off the running agent container
(`docker exec <agent> printenv POSTGRES_PASSWORD`); it is generated, not stored
in `~/.ast/project-configs.json`.

---

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

Pass it as a deploy var, which `scripts/deploy.sh` does:

```bash
RADAR_SLACK_BOT_TOKEN=xoxb-… scripts/deploy.sh
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
design, but the cron being accepted and silently ignored is misleading, and with
issue #1 above there is no working on-demand path either.

Worth either honouring `dev.schedules` with a local scheduler, or warning at
`project start` that the listed crons will not fire locally.
