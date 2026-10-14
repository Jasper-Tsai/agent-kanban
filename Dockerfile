# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3600 \
    KANBAN_DATA_DIR=/app/data \
    KANBAN_TIMEZONE=UTC
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server/migrations ./server/migrations
COPY server/seed ./server/seed
COPY scripts/backup-db.mjs ./scripts/backup-db.mjs
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3600
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3600/api/v1/health || exit 1
CMD ["node", "dist/server/index.mjs"]
