# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY projects/tmm/package.json projects/tmm/package-lock.json ./projects/tmm/
RUN --mount=type=cache,target=/root/.npm \
    cd projects/tmm \
    && npm ci --include=dev --no-audit --no-fund

COPY . .
RUN cd projects/tmm && npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    CHENLONG_PLATFORM_BIND_HOST=0.0.0.0 \
    CHENLONG_WORKSHOP_SKIP_BUILD=true

WORKDIR /app

COPY --chown=node:node --from=builder /app /app

RUN install -d -o node -g node \
      /app/data \
      /app/projects/car-python/.runtime \
      /app/projects/blockly-page3/.blockly-data \
      /app/projects/tmm/.wrangler/state/v3

USER node

EXPOSE 6190

VOLUME ["/app/data", "/app/projects/car-python/.runtime", "/app/projects/blockly-page3/.blockly-data", "/app/projects/tmm/.wrangler/state/v3"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:6190/api/readiness').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "tools/start-platform.js"]
