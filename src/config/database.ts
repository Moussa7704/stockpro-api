import { Sequelize } from "sequelize";
import { env } from "./env.js";

export const sequelize = new Sequelize({
  dialect: "postgres",
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  logging: env.NODE_ENV === "development" ? console.log : false,
  define: {
    underscored: true, // colonnes en snake_case : created_at, updated_at
  },
});

export async function connectDatabase(): Promise<void> {
  await sequelize.authenticate();
  console.log("Connexion à PostgreSQL établie");
}

export async function syncDatabase(): Promise<void> {
  // Crée les tables manquantes, sans toucher aux tables existantes.
  // Suffisant pour démarrer ; on passera aux migrations quand le schéma devra évoluer.
  await sequelize.sync();
  console.log("Tables synchronisées");
}

