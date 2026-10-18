/**
 * Vérifie qu'une sauvegarde se restaure vraiment (base temporaire, supprimée ensuite).
 * Par défaut la plus récente :
 *
 *   pnpm db:backup:verify [fichier]
 *   node dist/scripts/backup-verify.js [fichier]
 *
 * Une sauvegarde jamais testée ne vaut rien : à lancer régulièrement (le service Docker le fait
 * après chaque sauvegarde).
 */
import path from "node:path";
import { backupDir, listBackups, verifyBackup } from "../database/backup.js";

try {
  const file = process.argv[2] ?? (await listBackups()).map((name) => path.join(backupDir(), name))[0];
  if (!file) throw new Error(`Aucune sauvegarde dans ${backupDir()} : lancez d'abord pnpm db:backup`);

  console.log(`Vérification de ${file}…`);
  const report = await verifyBackup(file);
  console.log(`Sauvegarde valide : ${report.migrations} migration(s), la dernière « ${report.lastMigration} »`);
  console.table(report.tables);
} catch (error) {
  console.error("Sauvegarde NON valide :", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
