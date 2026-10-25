FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
COPY api/prisma api/prisma
RUN npm ci -w api
COPY api api
RUN npm run build -w api

FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm ci -w api --omit=dev --ignore-scripts

FROM build AS migrate
ENV NODE_ENV=production
WORKDIR /app/api
USER node
CMD ["node", "scripts/migrate.mjs", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY package.json ./package.json
COPY api/package.json ./api/package.json
COPY --from=build /app/api/dist ./api/dist
WORKDIR /app/api
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
