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
 * Going fast for a demo or a tuning loop is not a mode, it is these env vars:
 *
 *   SWEEP_QUIET_MINUTES=1 SWEEP_MIN_AGE_MINUTES=0 SWEEP_BURST_MESSAGES=3
 *   RADAR_WINDOW_DAYS=0-6 RADAR_WINDOW_START=00:00 RADAR_WINDOW_END=23:59
 *
 * That is the whole of what the old DEMO_MODE flag did, spelled out. Setting
 * them individually is longer to type and much harder to leave on by accident,
 * and it cannot drift from production behaviour the way a second code path can.
 *
 * The sweep cron is still the real latency floor and no env var moves it, so a
 * fast loop also needs a more frequent discussion_sweep schedule. (A literal
 * cron expression cannot be written in this comment: the slash-star sequence
 * would close the block.)
 */

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
  quietMinutes: () => num("SWEEP_QUIET_MINUTES", 10),
  /**
   * ...or this many messages while still live, so incidents are not held back.
   *
   * This — not quietMinutes — is what makes real incidents fast: a thread with
   * replies coming in hits the threshold and is judged on the next tick, at
   * 15min, regardless of the quiet setting. Lower it to 4 to also catch smaller
   * incident threads quickly, at the cost of judging more half-formed threads.
   */
  burstMessages: () => num("SWEEP_BURST_MESSAGES", 8),
  /** Never judge a discussion younger than this, however busy it looks. */
  minAgeMinutes: () => num("SWEEP_MIN_AGE_MINUTES", 10),
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

  /* ── Impact scoring (the gateway decision model) ──────────────────────── */

  /** Decision model id, sent in the request body. */
  jevModel: () => str("JEV_MODEL", "jev-1-13-0"),
  /** Teams offered to the `owner` question. Bounds prompt size on a big
   *  registry; the list is already filtered to teams that could be told. */
  jevMaxTeams: () => num("JEV_MAX_TEAMS", 12),
  /** Transcript characters sent to the scorer. Smaller than the judge's: this
   *  call answers "does anything matter here", not "write me a headline". */
  jevMaxTranscriptChars: () => num("JEV_MAX_TRANSCRIPT_CHARS", 4000),
  /** Give up and fall back to the lexical result after this long. */
  jevTimeoutMs: () => num("JEV_TIMEOUT_MS", 8000),

  /*
   * The two drop rules. Both are set to fire only when the model is close to
   * certain, because a drop here means a lead is never told and the
   * thumbs-down loop cannot see it. Every score is persisted whatever these
   * say (discussions.last_impact), so after a week of real traffic they can be
   * tightened from the distribution instead of from intuition.
   */
  /** Post types treated as noise when the scorer is confident AND nothing in
   *  the thread looks impactful. */
  jevNoiseTypes: () => str("JEV_NOISE_TYPES", "approval_request,ci_alert,status_update"),
  /** How sure the scorer must be of a noise type before it counts. A live call
   *  returned 0.99 on a clear-cut thread, so a high bar still catches the
   *  obvious ones and abstains on anything ambiguous. */
  jevNoiseMinConfidence: () => num("JEV_NOISE_MIN_CONFIDENCE", 0.85),
  /** ...and the impact ceiling below which a noise type may be dropped. A CI
   *  alert about a real outage is README scenario 1, not noise; this is what
   *  keeps "it looks automated" from being a reason on its own. */
  jevNoiseMaxImpact: () => num("JEV_NOISE_MAX_IMPACT", 0.5),
  /** Drop only if EVERY impact question came back under this. Deliberately far
   *  below 0.5: anything hedged escalates to the judge. */
  jevImpactFloor: () => num("JEV_IMPACT_FLOOR", 0.15),
  /** How sure the `owner` answer must be before a team the lexical prefilter
   *  missed is added as a judge candidate. */
  jevOwnerMinProb: () => num("JEV_OWNER_MIN_PROB", 0.5),

  /* ── Delivery ─────────────────────────────────────────────────────────── */

  /** Realtime DMs are an interruption, so they respect a working window.
   *  Anything outside it falls through to the next digest rather than dropping. */
  windowStart: () => str("RADAR_WINDOW_START", "09:00"),
  windowEnd: () => str("RADAR_WINDOW_END", "18:00"),
  /** Days a realtime DM may be sent, as JS getDay() numbers where 0 is Sunday.
   *  A range ("1-5"), a list ("1,2,5"), or both. Ranges may wrap ("5-1" is
   *  Fri-Mon). "0-6" disables the day gate, which is what a team that works
   *  weekends wants, and what a weekend rehearsal needs. */
  windowDays: () => str("RADAR_WINDOW_DAYS", "1-5"),
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
