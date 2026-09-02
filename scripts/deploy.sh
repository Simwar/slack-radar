#!/usr/bin/env bash
#
# Deploy slack-radar with the Slack adapter enabled.
#
# Watched channels are set on the deploy page, not here (see below).
#
# Three footguns this script exists to prevent:
#
# 1. Adapter defaults to web. `ast deploy` / `ast agent redeploy` default
#    `--adapter` to `web`. A deploy that omits `--adapter slack` silently drops
#    Slack ingestion: the agent reports "Running" but never sees a message and
#    the sweep finds nothing to score, with no error anywhere.
#
# 2. observe_channel_ids is the entire ingest surface. The sidecar forwards a
#    non-mention message to the agent ONLY if its channel is in this list. A
#    channel missing here is invisible to the radar even with the bot invited.
#    It is set on the DEPLOY PAGE ("Observe Channel IDs"), not here — this script
#    only overrides it when WATCHED_CHANNEL_IDS is explicitly passed.
#
# 3. NO allowlist. If the adapter's allowed_channel_ids is non-empty, the
#    sidecar rejects messages from any channel not on it with "This app has not
#    been enabled for this channel or user" — posted into the channel, before
#    the agent runs. We pass observe_channel_ids only, so isAllowed always
#    passes and the agent's own gate (respond only to @mention/DM, see
#    agent/index.ts) is the sole access control.
#
# Redeploy (not `ast deploy`): a redeploy PRESERVES schedule-trigger crons and
# already-configured secrets. A fresh `ast deploy` re-validates the spec and
# makes you re-supply both crons and every token.
#
# Cron cadence: discussion_sweep every 15 minutes, lead_digest at 09:00 and
# 14:00 on weekdays. These are NOT expressible in astropods.yml for deployed
# jobs (dev.schedules is local only) — they are entered at fresh `ast deploy`
# time and preserved on redeploy. To change an existing cadence you must delete
# and deploy fresh.
#
# Usage:
#   scripts/deploy.sh                                     # redeploy
#   WATCHED_CHANNEL_IDS="C1,C2,C3" scripts/deploy.sh      # OVERRIDE the deploy page
#   RADAR_SLACK_BOT_TOKEN=xoxb-... scripts/deploy.sh      # (re)set the job token
#
set -euo pipefail

AGENT_NAME="${AGENT_NAME:-slack-radar}"

# Watched channels are NOT configured from this repo.
#
# The deploy page's Slack section has an "Observe Channel IDs" field, and that is
# the real control: per-deployment config, set by whoever deploys, changeable
# without touching code. This is a blueprint, so a channel list baked into the
# repo would force every deployment to fork it.
#
# Consequently this script does NOT send SLACK_CONFIG by default. It used to,
# which meant every redeploy silently overwrote whatever the deployer had typed
# on that page.
#
# Set WATCHED_CHANNEL_IDS only when you deliberately want to override the
# platform's value from the command line:
#   WATCHED_CHANNEL_IDS=C123,C456 scripts/deploy.sh
# Leave "Allowed Channel IDs" blank on the deploy page either way — a non-empty
# allowlist makes the sidecar reject and spam channels before the agent runs.
WATCHED_CHANNEL_IDS="${WATCHED_CHANNEL_IDS:-}"
SLACK_WORKSPACE_DOMAIN="${SLACK_WORKSPACE_DOMAIN:-}"

args=(
  --name "$AGENT_NAME"
  --adapter slack
)

# Only pin the channel list when explicitly asked to.
if [[ -n "$WATCHED_CHANNEL_IDS" ]]; then
  observe_json=$(printf '%s' "$WATCHED_CHANNEL_IDS" \
    | awk -F, '{ for (i = 1; i <= NF; i++) { gsub(/^[ \t]+|[ \t]+$/, "", $i); if ($i != "") printf "%s\"%s\"", (n++ ? "," : ""), $i } }')
  echo "NOTE: overwriting the deploy page's Observe Channel IDs with: ${WATCHED_CHANNEL_IDS}"
  # observe_channel_ids only, NO allowlist — see footgun #3 above.
  args+=(--var "SLACK_CONFIG={\"observe_channel_ids\":[${observe_json}]}")
fi

if [[ -n "$SLACK_WORKSPACE_DOMAIN" ]]; then
  args+=(--var "SLACK_WORKSPACE_DOMAIN=${SLACK_WORKSPACE_DOMAIN}")
fi

# The ingestion jobs need their own Slack token: integration- and
# provider-scoped vars do not reach ingestion containers. Pass it once; it
# persists across later redeploys.
if [[ -n "${RADAR_SLACK_BOT_TOKEN:-}" ]]; then
  args+=(--var "RADAR_SLACK_BOT_TOKEN=${RADAR_SLACK_BOT_TOKEN}")
fi

# Model credentials are TOP-LEVEL inputs, so one value reaches every container.
# Setting BASETEN_API_KEY switches the whole agent (chat + judge) to Baseten;
# leaving it blank keeps everything on Anthropic. Never set both expecting a
# split — Baseten wins outright.
for var in ANTHROPIC_API_KEY ANTHROPIC_MODEL BASETEN_API_KEY BASETEN_BASE_URL BASETEN_MODEL TEAMS_CONFIG; do
  if [[ -n "${!var:-}" ]]; then
    args+=(--var "${var}=${!var}")
  fi
done

if [[ -n "${BASETEN_API_KEY:-}" ]]; then
  echo "Model backend: baseten (${BASETEN_MODEL:-zai-org/GLM-4.7})"
elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Model backend: anthropic (${ANTHROPIC_MODEL:-claude-haiku-4-5})"
fi

echo "Deploying ${AGENT_NAME}"
exec ast agent redeploy "${args[@]}" --wait "$@"
