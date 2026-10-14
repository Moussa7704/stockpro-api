import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase, syncDatabase } from "./config/database.js";
import "./models/index.js";

async function bootstrap(): Promise<void> {
  await connectDatabase();
  await syncDatabase();

  app.listen(env.PORT, () => {
    console.log(`StockPro API démarrée sur http://localhost:${env.PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("Échec du démarrage :", error);
  process.exit(1);
});
