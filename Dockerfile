FROM node:22-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY src ./src
COPY .env.example ./.env.example

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

CMD ["pnpm", "start"]
