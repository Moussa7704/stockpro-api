import { sequelize } from "../config/database.js";
import { runCleanup } from "../jobs/cleanup.js";

/**
 * Purge manuelle (la même tourne automatiquement toutes les heures dans l'API) :
 *   pnpm db:cleanup
 */
try {
  const result = await runCleanup();
  console.log("✅ Purge terminée :", result);
} catch (error) {
  console.error("❌ Échec de la purge :", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
