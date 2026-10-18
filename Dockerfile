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

# ---- Service de sauvegarde (docker compose : « backup ») : même code, plus les outils PostgreSQL ----
# Alpine fournit pg_dump 16, la version de la base (postgres:16) ; les dépendances sont du
# JavaScript pur, utilisables telles quelles. tzdata : la variable TZ fixe l'heure de la sauvegarde.
FROM node:22-alpine AS backup
RUN apk add --no-cache postgresql16-client tzdata
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Dossier des sauvegardes (volume) ; il appartient à l'utilisateur node, jamais root
RUN mkdir -p /backups && chown node:node /backups
USER node
CMD ["node", "--enable-source-maps", "dist/scripts/backup-scheduler.js"]

# ---- Image finale (cible par défaut) : Node + dépendances de prod + code compilé (ni pnpm, ni sources TypeScript) ----
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
