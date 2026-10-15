import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase } from "./config/database.js";
import { assertNoPendingMigrations } from "./database/migrator.js";
import { startCleanupJob } from "./jobs/cleanup.js";
import "./models/index.js";

async function bootstrap(): Promise<void> {
  await connectDatabase();
  // Le schéma est géré par les migrations (pnpm db:migrate), plus par sequelize.sync()
  await assertNoPendingMigrations();

  app.listen(env.PORT, () => {
    console.log(`StockPro API démarrée sur http://localhost:${env.PORT}`);
  });

  // Purge des sessions, codes OTP et liens expirés : au démarrage puis toutes les heures
  startCleanupJob();
}

bootstrap().catch((error) => {
  console.error("Échec du démarrage :", error);
  process.exit(1);
});
