/**
 * Service de sauvegarde (Docker) : chaque jour à BACKUP_HOUR h (2 h par défaut, heure de la
 * variable TZ), sauvegarde, conservation, puis vérification par restauration.
 *
 *   node dist/scripts/backup-scheduler.js
 *
 * Journal au format JSON comme l'API : un échec apparaît en « error » (à surveiller).
 */
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createBackup, nextRunAt, pruneBackups, verifyBackup } from "../database/backup.js";

async function runOnce(): Promise<void> {
  try {
    const { file, sizeBytes } = await createBackup();
    const removed = await pruneBackups();
    const report = await verifyBackup(file);
    logger.info({ file, sizeBytes, removed, migrations: report.migrations, tables: report.tables }, "Sauvegarde nocturne créée et vérifiée");
  } catch (error) {
    logger.error({ err: error }, "Échec de la sauvegarde nocturne");
  }
}

function scheduleNext(): void {
  const next = nextRunAt(new Date(), env.BACKUP_HOUR);
  logger.info({ next: next.toString() }, "Prochaine sauvegarde programmée");
  setTimeout(() => {
    void runOnce().finally(scheduleNext);
  }, next.getTime() - Date.now());
}

scheduleNext();
