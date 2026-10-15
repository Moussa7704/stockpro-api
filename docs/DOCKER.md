# StockPro API avec Docker

Prérequis : Docker Desktop (moteur démarré) et un fichier `.env` rempli à partir de `.env.example`.

## Démarrer

```bash
docker compose up -d --build
```

Ordre de démarrage, géré par Compose :

1. `db` : PostgreSQL 16. Il est publié sur le port **5433** de la machine, car le PostgreSQL installé sur Windows occupe déjà 5432.
2. `migrate` : il applique les migrations en attente, puis s'arrête. Le relancer sans rien de nouveau ne fait rien.
3. `api` : l'API démarre seulement si les migrations ont réussi. Elle est publiée sur le port `API_PORT` (3000 par défaut).

`GET /health` renvoie 200 `{"status":"ok","database":"ok"}`, ou 503 si la base est injoignable. Docker s'en sert pour marquer le conteneur `healthy` ou `unhealthy`.

## Commandes utiles

| Besoin | Commande |
|---|---|
| État des services | `docker compose ps` |
| Logs de l'API | `docker compose logs -f api` |
| Appliquer de nouvelles migrations | `docker compose run --rm migrate` |
| Créer l'administrateur SaaS | `docker compose exec api node dist/scripts/create-admin.js --email admin@exemple.com --name "Prénom Nom"` |
| Purger sessions et codes expirés | `docker compose exec api node dist/scripts/cleanup.js` |
| Tester l'envoi d'emails | `docker compose exec api node dist/scripts/verify-mailer.js` |
| Arrêter | `docker compose down` |
| Arrêter **et effacer la base** | `docker compose down -v` (irréversible) |

## Développer avec la base Docker seule

Pour garder `pnpm dev` (rechargement à chaud) tout en utilisant le PostgreSQL du conteneur :

```bash
docker compose up -d db
```

Dans `.env`, mettre `DB_HOST=localhost` et `DB_PORT=5433`, puis lancer `pnpm db:migrate` et `pnpm dev`.

## L'image

L'image est construite en plusieurs étapes (`Dockerfile`) :

- compilation TypeScript ;
- installation des dépendances de production seules ;
- image finale avec Node 22, `node_modules` de production et `dist`.

L'image finale ne contient ni pnpm, ni les sources TypeScript, ni les tests. Elle tourne avec l'utilisateur `node` (pas root). Les secrets ne sont jamais copiés dans l'image : `.env` est exclu par `.dockerignore` et fourni au conteneur à l'exécution.
