# slack-radar — Claude Code guide

See `AGENTS.md` for the full project overview, topology, and platform gotchas.
Read it before making changes; several non-obvious constraints (adapter flags,
sidecar allowlist behaviour, provider vars not reaching ingestion containers)
will otherwise bite.

## Key files

- `agent/index.ts` — Mastra agent + `PmRadarAdapter`, which intercepts every
  observed message, persists it, and stays silent. This is the ingest path.
- `agent/ingest.ts` — message → discussion folding. No model call, by design.
- `scheduler/src/sweep.ts` — the scoring loop.
- `scheduler/src/config.ts` — every tuning constant, hardcoded. Mirrored by the
  table in `README.md`; keep the two in sync.
- `scheduler/src/judge.ts` — the relevance prompt. Change this to change what
  counts as worth flagging.
- `scheduler/src/prefilter.ts` — free lexical shortlist; the main cost lever.
- `agent/model.ts` + `scheduler/src/model.ts` — Anthropic vs Baseten. Duplicated
  on purpose (separate packages); must stay identical.
- `agent/migrate.ts` — schema, applied in-process at agent boot.
- `teams.example.yml` — documents the `TEAMS_CONFIG` input shape. NOT read at
  runtime and NOT shipped in the image: this is a blueprint, so the registry is
  deploy-time config plus Slack self-serve, never a repo file.

## Rules of thumb

- Anything that runs per-message belongs in the agent container and must not
  call a model. Anything that needs judgement belongs in the sweep.
- Before adding a notification path, check it cannot double-send: the
  `UNIQUE(discussion_id, team_key)` constraint plus `ON CONFLICT DO NOTHING` is
  what guarantees a lead is told about a thread once.
- `EFFECTIVE_TOPICS_SQL` is duplicated in `agent/registry.ts` and
  `scheduler/src/db.ts`. Edit both.
- The backend rule is duplicated in `agent/model.ts` and
  `scheduler/src/model.ts`. Edit both, or the agent and judge can split across
  providers with no error anywhere.
- Tuning values are hardcoded in `config.ts` and their spec inputs are
  commented out, not deleted. Keep the `num()`/`str()` env reads — they are what
  makes re-exposing an input a no-code-deploy change.
- The agent container needs BOTH observability setups (Mastra for model calls,
  `startAgentTracing()` for the ingest path). Dropping either leaves a blind
  spot; see the Instrumentation section in `AGENTS.md`.
- Never `await forceFlush()` on the agent's tracer provider without a catch —
  under Bun it rejects with a phantom timeout even though spans were delivered.
- On the Baseten path never call an AI-SDK provider as a function
  (`baseten(model)`) — that is the Responses API, which Baseten does not
  implement, and the stream hangs instead of erroring.

## Running locally

```bash
ast project configure
ast project start
ast project logs
ast project stop
```

## Spec reference

Run `ast docs` for the full `astropods.yml` spec and agent development guide.
