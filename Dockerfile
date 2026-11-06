# IRH CORE — production image. One image serves api, bot and the dashboard.
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate --schema prisma/schema.prisma
RUN npm run build -w @irh/web

FROM base AS runtime
COPY --from=build /app /app
EXPOSE 4000 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:4000/api/health || exit 1
CMD ["npm", "run", "start:api"]
