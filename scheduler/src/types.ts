export interface TeamRow {
  key: string;
  name: string;
  description: string;
  lead_slack_ids: string[];
  topics: string[];
  keywords: string[];
  home_channel_ids: string[];
  realtime_enabled: boolean;
  min_confidence: number;
}

export interface DiscussionRow {
  id: string;
  channel_id: string;
  channel_name: string | null;
  root_ts: string;
  first_message_at: Date;
  last_message_at: Date;
  message_count: number;
  participants: string[];
  last_scored_count: number;
}

export interface MessageRow {
  ts: string;
  user_id: string | null;
  text: string;
  posted_at: Date;
}

export type SignalType = 'decision' | 'unanswered_question' | 'incident' | 'escalating';
export type Urgency = 'high' | 'normal';

export interface JudgedMatch {
  team_key: string;
  signal_type: SignalType;
  confidence: number;
  urgency: Urgency;
  headline: string;
  rationale: string;
}

export interface PendingDigestRow {
  match_id: string;
  team_key: string;
  team_name: string;
  lead_slack_ids: string[];
  signal_type: string;
  urgency: string;
  confidence: number;
  headline: string;
  rationale: string;
  channel_id: string;
  channel_name: string | null;
  root_ts: string;
  message_count: number;
}
