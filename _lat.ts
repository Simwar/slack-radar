// Time from a lone message being posted to the first judge call, for each combo.
// "fast" = the timing values a demo or tuning loop sets explicitly.
const FAST = { SWEEP_QUIET_MINUTES: "1", SWEEP_MIN_AGE_MINUTES: "0", SWEEP_BURST_MESSAGES: "3" };
const scenarios: [string, boolean, number][] = [
  ["defaults, */15 cron",        false, 15],
  ["cron only (*/1)",            false, 1],
  ["cron only (*/5)",            false, 5],
  ["fast timings, */15 cron",    true, 15],
  ["fast timings + */1 cron",    true, 1],
];
for (const [label, fast, cron] of scenarios) {
  for (const k of Object.keys(FAST)) delete process.env[k];
  if (fast) Object.assign(process.env, FAST);
  const { CONFIG } = await import(`./src/config?${label}`);
  const minAge = CONFIG.minAgeMinutes(), quiet = CONFIG.quietMinutes(), burst = CONFIG.burstMessages();
  // ripe when age >= minAge AND silence >= quiet  (lone message: age === silence)
  const ripeAt = Math.max(minAge, quiet);
  const judgedAt = Math.ceil(Math.max(ripeAt, cron) / cron) * cron;   // next tick at/after ripe
  console.log(`  ${label.padEnd(26)} minAge=${String(minAge).padEnd(2)} quiet=${String(quiet).padEnd(2)} burst=${String(burst).padEnd(2)} -> first judged ~${judgedAt} min`);
}
console.log("\n  (lone message with no replies; a thread hitting the burst count fires on the next tick)");
