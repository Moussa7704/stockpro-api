import { Sequelize } from "sequelize";
import { env } from "./env.js";
import { logger } from "./logger.js";

export const sequelize = new Sequelize({
  dialect: "postgres",
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  // Requêtes SQL visibles avec LOG_LEVEL=debug (trop bavard pour le niveau normal)
  logging: (sql) => logger.debug({ sql }, "SQL"),
  define: {
    underscored: true, // colonnes en snake_case : created_at, updated_at
  },
});

export async function connectDatabase(): Promise<void> {
  await sequelize.authenticate();
  logger.info("Connexion à PostgreSQL établie");
}
