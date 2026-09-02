import { CONFIG } from "./config";
import { getUnratedNotifications, setFeedback } from "./db";
import { getReactions } from "./slack";

/**
 * Turn reactions on delivered DMs into training signal.
 *
 * Reacting to the DM is the whole feedback UI. It costs a lead one click, it
 * needs no form and no follow-up conversation, and it is the only thing that
 * makes the noise floor go down over time - see getNoiseRates in db.ts for how
 * it is applied. Without this loop the radar's precision is frozen at whatever
 * the prompt happens to give on day one.
 *
 * Only recent notifications are polled: a lead who has not reacted within a few
 * days is not going to, and each check is a Slack API call.
 */
export async function collectFeedback(hours: number, maxChecks: number): Promise<number> {
  const pending = await getUnratedNotifications(hours);
  let rated = 0;

  for (const n of pending.slice(0, maxChecks)) {
    const reactions = await getReactions(n.dm_channel_id, n.dm_ts);
    if (!reactions.length) continue;

    // Noise wins a tie. If a lead reacted both ways, the complaint is the part
    // worth acting on.
    const verdict = reactions.includes(CONFIG.noiseEmoji())
      ? "noise"
      : reactions.includes(CONFIG.usefulEmoji())
        ? "useful"
        : null;
    if (!verdict) continue;

    await setFeedback(n.id, verdict);
    rated++;
  }

  if (pending.length > maxChecks) {
    console.warn(
      `[slack-radar] feedback: checked ${maxChecks} of ${pending.length} unrated notifications this run`,
    );
  }
  return rated;
}
