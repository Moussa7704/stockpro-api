import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { connectDatabase } from "./config/database.js";
import { assertNoPendingMigrations } from "./database/migrator.js";
import { startCleanupJob } from "./jobs/cleanup.js";
import "./models/index.js";

async function bootstrap(): Promise<void> {
  await connectDatabase();
  // Le schéma est géré par les migrations (pnpm db:migrate), plus par sequelize.sync()
  await assertNoPendingMigrations();

  app.listen(env.PORT, () => {
    logger.info(`StockPro API démarrée sur http://localhost:${env.PORT}`);
  });

  // Purge des sessions, codes OTP et liens expirés : au démarrage puis toutes les heures
  startCleanupJob();
}

// Erreur que personne n'a interceptée : on la journalise avant tout ; une exception non gérée
// laisse le processus dans un état incertain, il est redémarré (Docker, gestionnaire de services)
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Promesse rejetée non gérée");
});
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Exception non gérée : arrêt du serveur");
  process.exit(1);
});

bootstrap().catch((error) => {
  logger.fatal({ err: error }, "Échec du démarrage");
  process.exit(1);
});
