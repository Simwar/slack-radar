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
 * Cheap lexical shortlist, run before any model call.
 *
 * The judge is the expensive part, and most discussions in most channels are
 * relevant to nobody. This pass exists to answer "is it even plausible?" for
 * free, so the sweep only pays for discussions that at least mention something
 * a team claims to care about. Recall matters more than precision here: it is
 * fine to hand the judge a weak candidate, and expensive to drop a real one.
 *
 * A team is never a candidate for a discussion in one of its own home channels
 * - it is already in the room.
 */
export function shortlistTeams(
  discussionText: string,
  channelId: string,
  teams: TeamRow[],
  opts: { minScore: number; maxTeams: number },
): Candidate[] {
  const text = normalize(discussionText);
  if (!text) return [];
  const words = new Set(text.split(" "));

  const candidates: Candidate[] = [];

  for (const team of teams) {
    if (team.home_channel_ids.includes(channelId)) continue;
    if (!team.lead_slack_ids.length) continue; // nobody to tell

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
