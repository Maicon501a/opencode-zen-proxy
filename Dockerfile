FROM node:22-bookworm-slim

WORKDIR /app

# Cloudflare WARP client (warp-cli + warp-svc) plus the DBus system bus the
# daemon needs. Installed at build time (root) — no sudo required at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg dbus \
 && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main" > /etc/apt/sources.list.d/cloudflare-warp.list \
 && apt-get update && apt-get install -y --no-install-recommends cloudflare-warp \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./

RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY src ./src
COPY .env.example ./.env.example
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
