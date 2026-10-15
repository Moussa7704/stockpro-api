# syntax=docker/dockerfile:1

# ---- Base : Node 22 + pnpm (même version que devEngines dans package.json) ----
FROM node:22-slim AS base
RUN npm install -g pnpm@12.11.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ---- Build : toutes les dépendances + compilation TypeScript ----
FROM base AS build
# Cache du store pnpm entre deux builds : seules les dépendances modifiées sont retéléchargées
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- Dépendances de production seules ----
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --prod --store-dir /pnpm-store

# ---- Image finale : Node + dépendances de prod + code compilé (ni pnpm, ni sources TypeScript) ----
FROM node:22-slim AS production
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Jamais en root dans le conteneur
USER node
EXPOSE 3000
# Sonde : l'API répond et la base est joignable (GET /health)
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# Traces d'erreur pointant vers les fichiers .ts d'origine
CMD ["node", "--enable-source-maps", "dist/index.js"]
