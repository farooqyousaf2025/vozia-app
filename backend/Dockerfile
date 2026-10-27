# ---- build stage -----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# postgresql-client gives us `psql` so the container can apply schema.sql on boot
RUN apk add --no-cache postgresql-client
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY database ./database
# Placeholder gift/avatar art served at the API origin (see
# scripts/generate-placeholder-assets.cjs); swap this directory for real assets.
COPY public ./public

# Applies the idempotent schema (and demo seed, when SEED_DEMO_DATA=1) before the
# API starts, so `docker compose up` is a one-command bootstrap on a fresh VPS.
COPY docker-entrypoint.sh /usr/local/bin/voiza-entrypoint.sh
# strip CRLF in case the repo was checked out on Windows — /bin/sh cannot run CRLF scripts
RUN chmod +x /usr/local/bin/voiza-entrypoint.sh && sed -i 's/\r$//' /usr/local/bin/voiza-entrypoint.sh

EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=8 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/voiza-entrypoint.sh"]
CMD ["node", "dist/index.js"]
