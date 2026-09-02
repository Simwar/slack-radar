# Build stage
FROM oven/bun:1 AS builder
WORKDIR /app
COPY agent/package.json agent/bun.lock ./
RUN bun install --frozen-lockfile --production
# Glob, not a filename list. This used to enumerate each module by name, and
# adding agent/model.ts without updating the list produced a container that
# built cleanly and then died on boot with "Cannot find module './model'".
# There is no reason to hand-maintain this: every .ts here is agent source.
COPY agent/*.ts ./
# No registry file is shipped, on purpose. This is a blueprint: the team
# registry arrives as the TEAMS_CONFIG deploy input on first boot and lives in
# Postgres thereafter, edited over Slack. An image carrying teams.yml would
# force every deployment to fork the repo to configure itself.

# Runtime stage
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/*.ts ./
USER bun
CMD ["bun", "run", "index.ts"]
