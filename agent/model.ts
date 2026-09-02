import type { MastraModelConfig } from '@mastra/core/llm';

/**
 * The model swap seam. Both containers resolve their backend through this rule,
 * so the agent and the sweep judge can never end up on different providers.
 *
 * Two paths, and only two:
 *   - anthropic  — ANTHROPIC_API_KEY used by the agent AND the judge.
 *   - baseten    — BASETEN_API_KEY used by the agent AND the judge.
 *
 * Baseten wins when its key is set. That makes the switch a single deploy-time
 * value rather than a code change, and it means a half-configured deploy fails
 * loudly on one provider instead of silently splitting across two.
 */
export type Backend = 'anthropic' | 'baseten';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const DEFAULT_BASETEN_MODEL = 'zai-org/GLM-4.7';
export const DEFAULT_BASETEN_BASE_URL = 'https://inference.baseten.co/v1';

/** Truthiness, not `??`: an input left blank arrives as an empty string. */
export function resolveBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  return env.BASETEN_API_KEY ? 'baseten' : 'anthropic';
}

export function resolveModelId(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBackend(env) === 'baseten'
    ? env.BASETEN_MODEL || DEFAULT_BASETEN_MODEL
    : env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
}

/**
 * The model config handed to Mastra's Agent.
 *
 * Anthropic goes through Mastra's model router as a provider-prefixed string;
 * it reads ANTHROPIC_API_KEY from the environment itself.
 *
 * Baseten uses Mastra's OpenAICompatibleConfig rather than the router's
 * `baseten/…` string, so BASETEN_BASE_URL can move the endpoint without a code
 * deploy. Two reasons not to reach for `@ai-sdk/openai`'s createOpenAI here,
 * both learned the hard way in agents-draft/agent2:
 *
 *  1. Calling that provider as a function — `baseten(model)` — targets OpenAI's
 *     **Responses** API, which Baseten does not implement. The mismatch makes
 *     the stream hang forever instead of erroring. Mastra's OpenAI-compatible
 *     path is /chat/completions, so the hazard cannot be reintroduced here.
 *  2. Raw AI-SDK model objects are typed against a specific @ai-sdk/provider
 *     version, and Mastra bundles three of them side by side. Pinning a
 *     matching pair is a standing maintenance cost this config avoids.
 */
export function resolveAgentModel(env: NodeJS.ProcessEnv = process.env): MastraModelConfig {
  const id = resolveModelId(env);
  if (resolveBackend(env) !== 'baseten') return `anthropic/${id}`;

  // providerId/modelId form, not the `id: "provider/model"` form: Baseten model
  // ids already contain a slash (zai-org/GLM-4.7), so a single string is
  // ambiguous about where the provider name ends.
  //
  // The returned object CARRIES THE API KEY — never log it. Use describeModel()
  // for anything that ends up in stdout.
  return {
    providerId: 'baseten',
    modelId: id,
    url: env.BASETEN_BASE_URL || DEFAULT_BASETEN_BASE_URL,
    apiKey: env.BASETEN_API_KEY,
  };
}

/** Log-safe summary. Never returns the key itself. */
export function describeModel(env: NodeJS.ProcessEnv = process.env): string {
  const backend = resolveBackend(env);
  const key = backend === 'baseten' ? env.BASETEN_API_KEY : env.ANTHROPIC_API_KEY;
  const auth = key ? `set (****${key.slice(-4)})` : 'MISSING';
  const where =
    backend === 'baseten' ? ` url=${env.BASETEN_BASE_URL || DEFAULT_BASETEN_BASE_URL}` : '';
  return `backend=${backend} model=${resolveModelId(env)}${where} auth=${auth}`;
}
