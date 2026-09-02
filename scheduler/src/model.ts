/**
 * Mirror of agent/model.ts. The two containers do not share a package, so the
 * rule is duplicated rather than imported — but it must stay identical, or the
 * agent and the judge can end up on different providers with no error anywhere.
 *
 * Both keys are declared as TOP-LEVEL inputs in astropods.yml, which the
 * platform injects into every container, so the sweep sees the same values the
 * agent does without a second copy of the secret.
 */
export type Backend = "anthropic" | "baseten";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";
export const DEFAULT_BASETEN_MODEL = "zai-org/GLM-4.7";
export const DEFAULT_BASETEN_BASE_URL = "https://inference.baseten.co/v1";

export function resolveBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  return env.BASETEN_API_KEY ? "baseten" : "anthropic";
}

/**
 * The judge may run a different (usually cheaper) model than the conversational
 * agent, since it is a high-volume classifier rather than a chat surface.
 * JUDGE_MODEL overrides for whichever backend is active.
 */
export function resolveJudgeModel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JUDGE_MODEL) return env.JUDGE_MODEL;
  return resolveBackend(env) === "baseten"
    ? env.BASETEN_MODEL || DEFAULT_BASETEN_MODEL
    : env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
}

export function describeJudge(env: NodeJS.ProcessEnv = process.env): string {
  const backend = resolveBackend(env);
  const key = backend === "baseten" ? env.BASETEN_API_KEY : env.ANTHROPIC_API_KEY;
  return `backend=${backend} model=${resolveJudgeModel(env)} auth=${key ? `set (****${key.slice(-4)})` : "MISSING"}`;
}
