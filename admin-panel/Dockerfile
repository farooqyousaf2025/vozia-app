# ---------------------------------------------------------------------------
# Voiza Admin Panel — multi-stage build
#   1. node:20-alpine  -> install deps + vite build (static bundle)
#   2. nginx:alpine    -> serve the SPA, fallback to index.html, proxy /api
# ---------------------------------------------------------------------------

FROM node:20-alpine AS build
WORKDIR /app

# Dependency layer first for better caching.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json tsconfig.node.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY public ./public
COPY src ./src

# Baked into the bundle at build time (src/lib/api.ts reads import.meta.env).
ARG VITE_API_BASE_URL=http://localhost:4000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
