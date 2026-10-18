# Sauvegardes de la base

Une sauvegarde complète de PostgreSQL est faite **chaque nuit à 2 h** (heure de la variable `TZ`),
puis **vérifiée en la restaurant** dans une base temporaire. Une sauvegarde jamais testée ne vaut rien.

## Ce qui est gardé

| Sauvegardes | Combien |
|---|---|
| Quotidiennes (la plus récente de chaque jour) | les 7 derniers jours |
| Hebdomadaires (la plus récente de chaque semaine) | les 4 dernières semaines |
| Mensuelles (la plus récente de chaque mois) | les 12 derniers mois |

Soit au plus 23 fichiers. Les autres sont supprimés après chaque sauvegarde. Un fichier qui n'est
pas une sauvegarde (`stockpro_AAAA-MM-JJTHH-MM-SSZ.dump`) n'est jamais touché.

Les fichiers sont au format PostgreSQL « custom » : compressés, et restaurables table par table si besoin.

> **Limite actuelle** : les sauvegardes restent sur la même machine que la base. Elles protègent
> d'une erreur (suppression, mauvaise manipulation, mise à jour ratée), **pas** d'une panne du disque
> ou du serveur. Une copie hors de la machine (stockage objet de l'hébergeur) est à mettre en place
> avec l'hébergement.

## Avec Docker (production)

Le service `backup` de `docker-compose.yml` s'en occupe tout seul. Les fichiers sont dans le volume
`backups`.

| Besoin | Commande |
|---|---|
| Sauvegarde immédiate | `docker compose run --rm backup node dist/scripts/backup.js` |
| Vérifier la dernière sauvegarde | `docker compose run --rm backup node dist/scripts/backup-verify.js` |
| Voir les sauvegardes | `docker compose run --rm backup ls -lh /backups` |
| Résultat des sauvegardes nocturnes | `docker compose logs backup` (un échec apparaît en `"level":50`) |
| Copier une sauvegarde sur la machine | `docker compose cp backup:/backups/<fichier> .` |

## Sur la machine de développement

| Besoin | Commande |
|---|---|
| Sauvegarder | `pnpm db:backup` |
| Vérifier la dernière sauvegarde | `pnpm db:backup:verify` (ou `pnpm db:backup:verify <fichier>`) |
| Restaurer | `pnpm db:restore <fichier> --confirm <nom de la base>` |

Réglages dans `.env` :

- `PG_BIN_DIR` : dossier des outils PostgreSQL s'ils ne sont pas dans le PATH, par exemple
  `C:\Program Files\PostgreSQL\15\bin` sous Windows. Leur version doit être celle du serveur, ou plus récente.
- `BACKUP_DIR` : dossier des sauvegardes (`backups` par défaut, ignoré par git).
- `BACKUP_VERIFY_DB_USER` / `BACKUP_VERIFY_DB_PASSWORD` : la vérification crée une base temporaire,
  il faut un compte qui en a le droit (`CREATEDB`), par exemple `postgres`. Par défaut, celui de l'application.

## Restaurer après un incident

La restauration **remplace toutes les données** de la base par celles de la sauvegarde.

1. **Arrêter l'API**, pour qu'aucune vente n'arrive pendant la restauration :
   `docker compose stop api`
2. **Choisir la sauvegarde** : la plus récente avant l'incident (`ls -lh /backups`, voir ci-dessus).
   En cas de doute, la vérifier d'abord avec `backup-verify.js <fichier>`.
3. **Sauvegarder l'état actuel**, même abîmé, pour pouvoir revenir en arrière :
   `docker compose run --rm backup node dist/scripts/backup.js`
4. **Restaurer** (le nom de la base doit être retapé) :
   `docker compose run --rm backup node dist/scripts/restore.js /backups/<fichier> --confirm <DB_NAME>`
   Tout se fait en une transaction : en cas d'erreur, la base reste telle qu'avant.
5. **Appliquer les migrations** plus récentes que la sauvegarde, puis **relancer l'API** :
   `docker compose run --rm migrate` puis `docker compose start api`
6. **Prévenir les commerçants** : les opérations faites après l'heure de la sauvegarde sont perdues
   et doivent être ressaisies.

## Contrôle régulier

- Chaque matin, les journaux du service `backup` doivent montrer « Sauvegarde nocturne créée et vérifiée ».
- Une fois par mois, restaurer une sauvegarde sur une machine de test et ouvrir l'application :
  c'est le seul moyen d'être sûr de savoir le faire le jour où il le faudra.
