FROM node:24-alpine AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci
WORKDIR /workspace/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

FROM dependencies AS builder
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WORKSPACE_API_URL
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WORKSPACE_API_URL=$NEXT_PUBLIC_WORKSPACE_API_URL
WORKDIR /workspace
COPY packages ./packages
COPY frontend ./frontend
WORKDIR /workspace/frontend
RUN npm run build

FROM node:24-alpine AS production
WORKDIR /workspace
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /workspace/frontend/.next/standalone ./
COPY --from=builder --chown=node:node /workspace/frontend/.next/static ./frontend/.next/static
COPY --from=builder --chown=node:node /workspace/frontend/public ./frontend/public
USER node
WORKDIR /workspace/frontend
EXPOSE 3000
CMD ["node", "server.js"]

# Keep development last: the existing development Compose builds this default target.
FROM dependencies AS development
WORKDIR /workspace
COPY packages ./packages
COPY frontend ./frontend
WORKDIR /workspace/frontend
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["npm", "run", "dev"]
