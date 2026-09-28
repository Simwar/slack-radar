import type { TeamRow } from "./types";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "how", "in", "into", "is", "it", "its", "of", "on", "or", "our", "that", "the",
  "their", "there", "they", "this", "to", "was", "were", "what", "when", "which",
  "who", "will", "with", "we", "you", "your", "can", "could", "should", "would",
  "about", "any", "all", "not", "but", "if", "so", "do", "does", "did", "just",
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    // Slack decorations carry no topical signal and create false keyword hits
    // (a channel named #billing should not make every message match "billing").
    .replace(/<@[^>]+>/g, " ")
    .replace(/<#[^>]+>/g, " ")
    .replace(/<https?:\/\/[^>|]+(\|[^>]*)?>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^a-z0-9\s./_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contentWords(phrase: string): string[] {
  return normalize(phrase)
    .split(" ")
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export interface Candidate {
  team: TeamRow;
  score: number;
  hits: string[];
}

/**
 * Teams that could be told about a discussion in this channel at all, before
 * any scoring. Three exclusions, all deterministic and all free:
 *
 *  1. No leads — nobody to tell.
 *  2. The channel is one of the team's home channels — they are in the room
 *     already. This is the system's single biggest noise saving.
 *  3. A lead is active in the recent part of the thread (see recentAuthors).
 *
 * Rule 3 used to be a line in the judge prompt: "do not flag discussions where
 * someone from the team is already clearly participating". The judge could
 * never obey it. Transcripts are anonymised to person1/person2 before they are
 * sent, so the model had no way to know who was speaking and answered from
 * vibes — which is how a lead's own thread gets flagged back at them. Done
 * here it is a set intersection, so it costs nothing and is exact.
 */
export function eligibleTeams(
  teams: TeamRow[],
  channelId: string,
  engaged: string[],
): TeamRow[] {
  return teams.filter((t) => ineligibleBecause(t, channelId, engaged) === null);
}

/**
 * Who is active in the recent part of a thread.
 *
 * Eligibility asks whether a lead is already engaged, and someone who said one
 * thing forty messages ago is not: the thread has moved on, and a decision
 * forming in it now is exactly what they would want to be told about. Using
 * the tail rather than the whole of discussions.participants keeps the fix for
 * a lead's own thread being flagged back at them, without muting every thread
 * they have ever touched.
 */
export function recentAuthors(
  messages: { user_id: string | null }[],
  count: number,
): string[] {
  const out = new Set<string>();
  for (const m of messages.slice(-count)) if (m.user_id) out.add(m.user_id);
  return [...out];
}

/**
 * Why this team cannot be a candidate here, or null when it can be.
 *
 * Separate from eligibleTeams so the sweep can say which rule fired. A
 * discussion dropped for want of an eligible team is otherwise the quietest
 * outcome in the system: no match, no decline, no log, and a registry that
 * looks fine until someone compares it field by field against what they meant.
 */
export function ineligibleBecause(
  team: TeamRow,
  channelId: string,
  engaged: string[],
): string | null {
  if (!team.lead_slack_ids.length) return "no leads";
  if (team.home_channel_ids.includes(channelId)) return "this is one of its home channels";
  const lead = team.lead_slack_ids.find((id) => engaged.includes(id));
  if (lead) return `lead ${lead} is active in the thread`;
  return null;
}

/**
 * Cheap lexical shortlist, run before any model call.
 *
 * The judge is the expensive part, and most discussions in most channels are
 * relevant to nobody. This pass exists to answer "is it even plausible?" for
 * free, so the sweep only pays for discussions that at least mention something
 * a team claims to care about. Recall matters more than precision here: it is
 * fine to hand the judge a weak candidate, and expensive to drop a real one.
 *
 * Eligibility (who could be told at all) is separated out into eligibleTeams so
 * the impact scorer can apply exactly the same rule.
 */
export function shortlistTeams(
  discussionText: string,
  channelId: string,
  engaged: string[],
  teams: TeamRow[],
  opts: { minScore: number; maxTeams: number },
): Candidate[] {
  const text = normalize(discussionText);
  if (!text) return [];
  const words = new Set(text.split(" "));

  const candidates: Candidate[] = [];

  for (const team of eligibleTeams(teams, channelId, engaged)) {

    let score = 0;
    const hits: string[] = [];

    for (const keyword of team.keywords) {
      const k = normalize(keyword);
      if (!k) continue;
      // Multi-word keywords ("rate limit") need a substring test; single words
      // use the token set so "sso" does not match "ssot".
      const hit = k.includes(" ") ? text.includes(k) : words.has(k);
      if (hit) {
        score += 1;
        hits.push(keyword);
      }
    }

    for (const topic of team.topics) {
      const terms = contentWords(topic);
      if (!terms.length) continue;
      const matched = terms.filter((t) => words.has(t)).length;
      // Half a topic's content words is a real signal, but so are two of them
      // in absolute terms: a long topic like "authentication, SSO, and token
      // handling" can never reach 50% off a message that only says "sso token".
      if (matched >= 2 || matched / terms.length >= 0.5) {
        score += 1.5;
        hits.push(topic);
      }
    }

    // A team's own name is worth HALF a keyword, deliberately below minScore, so
    // a bare name mention cannot reach the judge on its own.
    //
    // Team names are often ordinary words — "Agent", "Platform", "Core" — and in
    // the company that owns that product those words appear in almost every
    // message. Scoring a name like a keyword meant a team called Agent matched
    // "the agent is great, nice work team": every discussion in Slack sent to
    // the model and then rejected, which is pure cost and no signal.
    //
    // Half-weight keeps the useful case (a name mention alongside any real
    // keyword or topic hit reinforces it) without the name alone qualifying.
    const nameTerms = contentWords(team.name);
    if (nameTerms.length && nameTerms.every((t) => words.has(t))) {
      score += 0.5;
      hits.push(`name:${team.name}`);
    }

    if (score >= opts.minScore) candidates.push({ team, score, hits });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, opts.maxTeams);
}
