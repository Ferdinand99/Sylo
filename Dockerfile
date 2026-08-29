# syntax=docker/dockerfile:1

# ---- builder: install production dependencies ----
FROM node:20-alpine AS builder
WORKDIR /app

# Toolchain for compiling better-sqlite3 if no prebuilt binary matches.
# (musl x64 prebuilds usually cover Unraid, so this is a safety net.)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# ---- runtime: minimal image ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# su-exec lets the entrypoint drop from root to the unprivileged user after
# fixing bind-mount ownership.
RUN apk add --no-cache su-exec \
  && addgroup -S sylo && adduser -S sylo -G sylo \
  && mkdir -p /app/data && chown -R sylo:sylo /app

COPY --from=builder --chown=sylo:sylo /app/node_modules ./node_modules
COPY --chown=sylo:sylo . .
RUN chmod +x /app/docker-entrypoint.sh

# Starts as root so the entrypoint can chown a root-owned data volume, then
# execs the app as the 'sylo' user (see docker-entrypoint.sh).
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
