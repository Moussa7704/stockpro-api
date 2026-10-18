/**
 * Restaure une sauvegarde dans la base de l'application : REMPLACE toutes ses données.
 * Le nom de la base doit être retapé, pour ne jamais restaurer par erreur :
 *
 *   pnpm db:restore backups/stockpro_2026-10-18T02-00-00Z.dump --confirm stockpro
 *   node dist/scripts/restore.js <fichier> --confirm <nom de la base>
 *
 * Arrêtez l'API avant (aucune vente ne doit arriver pendant la restauration). Tout se fait en une
 * transaction : en cas d'erreur, la base reste telle qu'avant.
 */
import { access } from "node:fs/promises";
import { env } from "../config/env.js";
import { restoreBackup } from "../database/backup.js";

const [file] = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith("--") && args[index - 1] !== "--confirm");
const confirmIndex = process.argv.indexOf("--confirm");
const confirmed = confirmIndex > 0 ? process.argv[confirmIndex + 1] : undefined;

if (!file) {
  console.error("Indiquez le fichier à restaurer : pnpm db:restore <fichier> --confirm <nom de la base>");
  process.exit(1);
}
if (confirmed !== env.DB_NAME) {
  console.error(`La restauration REMPLACE toutes les données de la base « ${env.DB_NAME} ».`);
  console.error(`Pour confirmer, ajoutez : --confirm ${env.DB_NAME}`);
  process.exit(1);
}

try {
  await access(file);
  console.log(`Restauration de ${file} dans « ${env.DB_NAME} »…`);
  await restoreBackup(file);
  console.log("Restauration terminée. Appliquez les migrations récentes si besoin (pnpm db:migrate), puis relancez l'API.");
} catch (error) {
  console.error("Échec de la restauration (la base est inchangée) :", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
