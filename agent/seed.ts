import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { getPool, withDbRetry } from './db';
import { upsertTeam, type SeedTeam } from './registry';

/**
 * Bootstrap the team registry from the TEAMS_CONFIG deploy input.
 *
 * This is a blueprint, so nothing operational may live in the repo. A registry
 * baked into an image means every deployment has to fork the code to point at
 * its own teams and channels, which defeats the point of deploy-time inputs.
 *
 * Two sources, in precedence order:
 *   1. TEAMS_CONFIG — a YAML or JSON document supplied at deploy time. This is
 *      the real one.
 *   2. TEAMS_FILE — a path, for local development only. Not shipped in the
 *      image; there is no default file to fall back to.
 *
 * BOOTSTRAP ONLY. It is applied when the registry is empty and skipped
 * otherwise. That matters because after the first boot the source of truth is
 * Postgres, which leads edit live over Slack (registerTeam, watchTopics,
 * setDelivery). Re-applying the input on every boot would silently revert every
 * change anyone made through the agent — a redeploy would undo a month of
 * tuning with no error and no log anyone would think to read.
 *
 * To force the input to win, clear the registry first. That is deliberately a
 * manual act.
 */
export async function seedTeams(): Promise<void> {
  const raw = readTeamsConfig();
  if (raw === null) {
    console.log('[slack-radar] no TEAMS_CONFIG supplied — registry is managed over Slack');
    return;
  }

  const { rows } = await withDbRetry(
    () => getPool().query<{ n: string }>('SELECT COUNT(*)::text AS n FROM teams'),
    'count teams',
  );
  const existing = Number(rows[0]?.n ?? 0);
  if (existing > 0) {
    // Not a warning: this is the normal steady state for a running deployment.
    console.log(
      `[slack-radar] registry already has ${existing} team(s) — TEAMS_CONFIG ignored (Slack is the source of truth once seeded)`,
    );
    return;
  }

  let doc: { teams?: SeedTeam[] } | SeedTeam[];
  try {
    doc = parse(raw) ?? {};
  } catch (err) {
    // A malformed input must not take the agent down: it still needs to serve
    // /health and answer Slack so someone can fix the registry from there.
    console.error('[slack-radar] TEAMS_CONFIG is not valid YAML/JSON, skipping seed:', (err as Error).message);
    return;
  }

  // Accept either `teams: [...]` or a bare list, because both read naturally in
  // a deploy-time text field and getting it wrong is otherwise a silent no-op.
  const teams = Array.isArray(doc) ? doc : (doc.teams ?? []);
  if (!teams.length) {
    console.warn('[slack-radar] TEAMS_CONFIG declares no teams — nothing will be flagged until one is registered');
    return;
  }

  let seeded = 0;
  for (const t of teams) {
    try {
      await upsertTeam(t);
      seeded++;
    } catch (err) {
      console.error(`[slack-radar] failed to seed team ${t?.key ?? '(no key)'}:`, (err as Error).message);
    }
  }
  console.log(`[slack-radar] bootstrapped ${seeded}/${teams.length} team(s) from TEAMS_CONFIG`);
}

/** Returns the raw config document, or null when none was supplied. */
function readTeamsConfig(): string | null {
  const inline = process.env.TEAMS_CONFIG?.trim();
  if (inline) return inline;

  // Local dev convenience only. No default path: an image that quietly picks up
  // a checked-in file is the thing this function exists to avoid.
  const path = process.env.TEAMS_FILE?.trim();
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`[slack-radar] could not read TEAMS_FILE ${path}:`, (err as Error).message);
    return null;
  }
}
