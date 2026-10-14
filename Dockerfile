# ---- Base : Node + pnpm ----
FROM node:22-slim AS base
RUN npm install -g pnpm@12.11.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ---- Build : toutes les dépendances + compilation TypeScript ----
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- Production : dépendances de prod + code compilé uniquement ----
FROM base AS production
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
