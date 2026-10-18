/**
 * Sauvegarde complète de la base, puis application de la règle de conservation
 * (7 quotidiennes, 4 hebdomadaires, 12 mensuelles).
 *
 *   pnpm db:backup                       (développement)
 *   node dist/scripts/backup.js          (production, ou service Docker « backup »)
 */
import { createBackup, pruneBackups } from "../database/backup.js";

try {
  const { file, sizeBytes } = await createBackup();
  console.log(`Sauvegarde créée : ${file} (${(sizeBytes / 1024 / 1024).toFixed(2)} Mo)`);
  const removed = await pruneBackups();
  console.log(removed.length > 0 ? `Anciennes sauvegardes supprimées : ${removed.join(", ")}` : "Aucune ancienne sauvegarde à supprimer");
} catch (error) {
  console.error("Échec de la sauvegarde :", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
