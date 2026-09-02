# discussion_sweep — the scoring and realtime-notify job.
# Build stage
FROM oven/bun:1 AS builder
WORKDIR /app
COPY scheduler/package.json scheduler/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY scheduler/src ./src

# Runtime stage
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/src ./src
COPY --from=builder --chown=bun:bun /app/package.json ./
USER bun
CMD ["bun", "run", "src/index.ts"]
