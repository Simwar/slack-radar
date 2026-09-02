// Time from a lone message being posted to the first judge call, for each combo.
const scenarios: [string, boolean, number][] = [
  ["defaults, */15 cron",        false, 15],
  ["cron only (*/1)",            false, 1],
  ["cron only (*/5)",            false, 5],
  ["DEMO_MODE only, */15 cron",  true, 15],
  ["DEMO_MODE + */1 cron",       true, 1],
];
for (const [label, demo, cron] of scenarios) {
  for (const k of ["DEMO_MODE","SWEEP_QUIET_MINUTES","SWEEP_MIN_AGE_MINUTES","SWEEP_BURST_MESSAGES"]) delete process.env[k];
  if (demo) process.env.DEMO_MODE = "true";
  const { CONFIG } = await import(`./src/config?${label}`);
  const minAge = CONFIG.minAgeMinutes(), quiet = CONFIG.quietMinutes(), burst = CONFIG.burstMessages();
  // ripe when age >= minAge AND silence >= quiet  (lone message: age === silence)
  const ripeAt = Math.max(minAge, quiet);
  const judgedAt = Math.ceil(Math.max(ripeAt, cron) / cron) * cron;   // next tick at/after ripe
  console.log(`  ${label.padEnd(26)} minAge=${String(minAge).padEnd(2)} quiet=${String(quiet).padEnd(2)} burst=${String(burst).padEnd(2)} -> first judged ~${judgedAt} min`);
}
console.log("\n  (lone message with no replies; a thread hitting the burst count fires on the next tick)");
