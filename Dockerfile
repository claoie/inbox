FROM oven/bun:1.3.14 AS builder

WORKDIR /app

COPY package.json bun.lockb* ./
COPY tsconfig.json tsconfig.node.json ./
COPY vite.config.ts ./
COPY bunfig.toml ./
COPY src src
COPY scripts scripts
COPY public public
COPY index.html ./
COPY .env.example ./

RUN bun install
RUN bun run typecheck
RUN bun test
RUN bun run build

FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/build ./build
COPY healthcheck.js ./healthcheck.js

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node ./healthcheck.js

CMD ["node", "./build/server/bundle.js"]
