import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase } from "./config/database.js";

async function bootstrap(): Promise<void> {
  await connectDatabase();

  app.listen(env.PORT, () => {
    console.log(`StockPro API démarrée sur http://localhost:${env.PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("Échec du démarrage :", error);
  process.exit(1);
});
