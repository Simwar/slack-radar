/**
 * Every tuning constant in the scheduler, in one place.
 *
 * These are HARDCODED defaults, not deploy-time inputs. The corresponding
 * `inputs:` entries are commented out in astropods.yml — the values below are
 * the single source of truth, and the table in README.md mirrors this file.
 *
 * Why: exposing twenty numbers at deploy time makes the configure step look
 * like it demands twenty decisions, when in practice nobody has enough
 * information to improve on these until the radar has been running for a week.
 * A deployer should have to supply credentials and locale, nothing else.
 *
 * Each one still reads its env var first, so re-exposing any of them is a
 * two-line change: un-comment the input in astropods.yml and it takes effect
 * with no code deploy. That is the reason these are not bare literals.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/**
 * Demo mode: compress every wait so a notification lands in about a minute.
 *
 * This exists because the honest defaults make the agent undemoable. A lone
 * message takes 15 minutes to reach a DM, and realtime delivery is gated to
 * weekday working hours — fine in production, fatal in front of an audience.
 *
 * It changes ONLY timing and the working-hours gate. The prefilter, the judge
 * prompt, confidence thresholds and the feedback loop are untouched, so what
 * the audience sees decide things is the same code that will decide them in
 * production. A demo mode that also loosened the thresholds would be a
 * different product on stage than in the repo.
 *
 * Pair it with a once-a-minute discussion_sweep cron in dev.schedules (see
 * docs/DEMO.md) — the cron is the real latency floor and no env var can move
 * it. Note a literal cron expression cannot be written in this comment: the
 * slash-star sequence would close the block.
 */
export function isDemoMode(): boolean {
  const v = (process.env.DEMO_MODE ?? "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Demo value when demo mode is on, otherwise the normal env-or-default lookup. */
function demoNum(name: string, fallback: number, demo: number): number {
  if (isDemoMode() && process.env[name] === undefined) return demo;
  return num(name, fallback);
}

export const CONFIG = {
  /* ── Ripeness: when is a discussion ready to judge? ───────────────────── */

  /**
   * Silence after which a thread is considered to have said its piece.
   *
   * 10, not 20. Modelled against thread shapes: this governs ONLY the
   * low-activity cases — a lone message goes from 30min to 15min to first
   * judge, a slow thread from 60min to 30min — and costs no extra judge calls,
   * because re-judging is gated by escalationFactor rather than by this.
   *
   * Note 15min is the real floor whatever this is set to, because the sweep
   * cron is every 15 minutes. Dropping this below 10 buys nothing without also
   * making the cron more frequent.
   *
   * The cost is precision, and it is not visible in a latency table: judging
   * sooner means the judge sometimes sees a question that was about to be
   * answered. Matches are raise-once (UNIQUE + ON CONFLICT DO NOTHING), so a
   * premature flag cannot be walked back — it lands in a digest as noise and
   * only the thumbs-down loop cleans it up. If digest precision drops after
   * this change, put it back to 20 before touching anything else.
   */
  quietMinutes: () => demoNum("SWEEP_QUIET_MINUTES", 10, 1),
  /**
   * ...or this many messages while still live, so incidents are not held back.
   *
   * This — not quietMinutes — is what makes real incidents fast: a thread with
   * replies coming in hits the threshold and is judged on the next tick, at
   * 15min, regardless of the quiet setting. Lower it to 4 to also catch smaller
   * incident threads quickly, at the cost of judging more half-formed threads.
   */
  burstMessages: () => demoNum("SWEEP_BURST_MESSAGES", 8, 3),
  /** Never judge a discussion younger than this, however busy it looks. */
  minAgeMinutes: () => demoNum("SWEEP_MIN_AGE_MINUTES", 10, 0),
  /** Stop considering discussions with no activity in this long. */
  maxAgeHours: () => num("SWEEP_MAX_AGE_HOURS", 48),
  /** Re-judge only once a thread has grown by this factor since the last pass. */
  escalationFactor: () => num("SWEEP_ESCALATION_FACTOR", 2),

  /* ── Spend ceilings ───────────────────────────────────────────────────── */

  /** Hard cap on judge calls per run. Overflow is logged and deferred. */
  maxDiscussions: () => num("SWEEP_MAX_DISCUSSIONS", 60),
  /** Judge calls in flight at once. */
  concurrency: () => num("SWEEP_CONCURRENCY", 4),
  /** Messages loaded per discussion. */
  maxMessages: () => num("SWEEP_MAX_MESSAGES", 80),
  /** Transcript characters sent to the judge. */
  maxTranscriptChars: () => num("SWEEP_MAX_TRANSCRIPT_CHARS", 6000),
  /** Output ceiling for one judge call, per backend. Baseten's reasoning models
   *  spend tokens before emitting the tool call, so they need more room. */
  judgeMaxTokens: (backend: "anthropic" | "baseten") =>
    num("JUDGE_MAX_TOKENS", backend === "baseten" ? 4000 : 2000),
  /** Reasoning effort, sent only to models that accept it (see judge.ts). */
  judgeEffort: () => str("JUDGE_EFFORT", "low") as "low" | "medium" | "high",

  /* ── Matching ─────────────────────────────────────────────────────────── */

  /** Lexical score a team must reach to be shown to the judge. 1 = one keyword
   *  hit. Favours recall on purpose; the judge is the precision layer. */
  prefilterMinScore: () => num("PREFILTER_MIN_SCORE", 1),
  /** Most teams considered for any one discussion. */
  prefilterMaxTeams: () => num("PREFILTER_MAX_TEAMS", 3),
  /** How hard thumbs-down raises the bar for a (team, channel) pair. 0 disables. */
  noisePenalty: () => num("NOISE_PENALTY", 0.3),
  /** Ratings needed before a pairing's feedback is trusted to move its threshold. */
  noiseMinSamples: () => num("NOISE_MIN_SAMPLES", 5),

  /* ── Delivery ─────────────────────────────────────────────────────────── */

  /** Realtime DMs are an interruption, so they respect a working window.
   *  Anything outside it falls through to the next digest rather than dropping. */
  windowStart: () => str("RADAR_WINDOW_START", "09:00"),
  windowEnd: () => str("RADAR_WINDOW_END", "18:00"),
  /** Locale, not tuning — this one IS a deploy-time input. */
  timezone: () => str("RADAR_TIMEZONE", "America/New_York"),
  /** Most items shown in one digest. The rest are still marked delivered and
   *  stay available via "what did I miss". */
  digestMaxItems: () => num("DIGEST_MAX_ITEMS", 12),

  /* ── Feedback ─────────────────────────────────────────────────────────── */

  /** Slack emoji names (no colons) leads react with to rate a notification. */
  usefulEmoji: () => str("USEFUL_EMOJI", "+1"),
  noiseEmoji: () => str("NOISE_EMOJI", "-1"),
  /** How far back to poll for reactions, and how many checks per run. A lead who
   *  has not reacted in five days is not going to, and each check is an API call. */
  feedbackHours: () => num("FEEDBACK_LOOKBACK_HOURS", 120),
  feedbackMaxChecks: () => num("FEEDBACK_MAX_CHECKS", 150),

  /* ── Retention ────────────────────────────────────────────────────────── */

  /** Raw Slack message text is deleted after this many days. Matches and
   *  notifications hold no message bodies and are kept.
   *
   *  This is the one value here that is policy rather than tuning. If a privacy
   *  or legal review needs it changed without a code deploy, re-expose it as an
   *  input first — see README.md. */
  retentionDays: () => num("MESSAGE_RETENTION_DAYS", 30),
};
