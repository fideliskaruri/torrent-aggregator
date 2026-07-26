# TorrentFlow — production image
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="file:./data/prod.db"
ENV DOWNLOAD_DIR="/downloads"

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.ts ./next.config.ts

RUN mkdir -p /app/data /downloads && chown -R nextjs:nodejs /app /downloads
USER nextjs
EXPOSE 3000
ENV PORT=3000

# `npm run start` is `next start -H 127.0.0.1`, which is right on the host (no
# auth, so do not publish it) and wrong in a container: loopback inside the
# namespace is unreachable from the published port, so `docker compose up`
# produced an app that never answered. The container boundary *is* the
# isolation here; bind to the container's own interfaces and let the compose
# port mapping decide what is exposed.
#
# `migrate deploy` rather than `db push`: the repo has a real migration
# history, and `db push` diverges from it silently.
CMD ["sh", "-c", "npx prisma migrate deploy && npx next start -H 0.0.0.0 -p ${PORT:-3000}"]
