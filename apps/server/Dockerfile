FROM node:24-bookworm-slim
WORKDIR /workspace/apps/server
COPY apps/server/package*.json ./
COPY packages/contracts /workspace/packages/contracts
COPY packages/domain /workspace/packages/domain
RUN npm ci --include=dev --no-audit --no-fund
COPY apps/server/src ./src
COPY apps/server/migrations ./migrations
COPY apps/server/tsconfig.json ./
ENV UNIFIED_HOST=0.0.0.0
EXPOSE 8001
CMD ["npm", "start"]
