# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY shared ./shared
COPY server ./server
COPY scripts ./scripts
COPY sources ./sources
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG CODEX_VERSION=0.154.0
ARG CLAUDE_VERSION=2.1.274
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep gh && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && npm cache clean --force
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/sources ./sources
COPY --from=build /app/package.json ./package.json
RUN mkdir -p /app/data /home/node/.codex /home/node/.claude /home/node/.config/gh \
    && chown -R node:node /app/data /home/node
ENV NODE_ENV=production HACKALEM_CONTAINER=1 HACKALEM_DATA_DIR=/app/data
USER node
EXPOSE 4310
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4310/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/tsx/dist/cli.mjs", "scripts/start.ts"]
