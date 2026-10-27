FROM node:24-bookworm-slim AS source
WORKDIR /workspace/apps/server
COPY apps/server/package*.json ./
COPY packages/contracts /workspace/packages/contracts
COPY packages/domain /workspace/packages/domain
RUN npm ci --include=dev --no-audit --no-fund
COPY apps/server/src ./src
COPY apps/server/migrations ./migrations
COPY apps/server/tsconfig.json ./
ENV UNIFIED_HOST=0.0.0.0
USER node
EXPOSE 8001
CMD ["node", "--import", "tsx", "src/main.ts"]

FROM source AS development
ENV NODE_ENV=development

FROM source AS production
ENV NODE_ENV=production
