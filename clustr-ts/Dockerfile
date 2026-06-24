# Clustr (TypeScript): remote MCP connector image.
# Multi-stage: build with dev deps, ship a slim runtime with prod deps only.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Runs in HTTP mode, bound to all interfaces *inside the container* so the
# tunnel/proxy on the same network can reach it. It still refuses to start
# unauthenticated unless CLUSTR_AUTH_PASSWORD is set (or the override), so set a
# password in your .env before exposing it.
ENV CLUSTR_TRANSPORT=http \
    CLUSTR_HTTP_HOST=0.0.0.0 \
    CLUSTR_HTTP_PORT=8080
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
