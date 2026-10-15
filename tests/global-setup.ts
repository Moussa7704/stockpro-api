import pg from "pg";
import { assertTestDatabase, testEnv } from "./test-env.js";

/** Crée la base de test si elle n'existe pas (le compte des tests doit en avoir le droit). */
async function ensureTestDatabase(): Promise<void> {
  const name = process.env.DB_NAME!;
  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: "postgres", // base système, toujours présente
  });

  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (existing.rowCount === 0) {
      // Le nom a été vérifié par assertTestDatabase (lettres, chiffres, _ et suffixe _test)
      await client.query(`CREATE DATABASE "${name}"`);
      console.log(`Base de test "${name}" créée`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Exécuté une seule fois, avant tous les fichiers de test (dans le processus principal,
 * où la config "env" de Vitest ne s'applique pas encore : on l'applique à la main).
 * On annule toutes les migrations puis on les rejoue : ça vérifie au passage que
 * chaque "down" fonctionne, et les tests partent d'un schéma identique à la production.
 */
export async function setup(): Promise<void> {
  Object.assign(process.env, testEnv);
  assertTestDatabase();
  await ensureTestDatabase();

  // Import dynamique : env.ts doit lire les variables ci-dessus, pas celles du .env
  const { migrator } = await import("../src/database/migrator.js");
  const { sequelize } = await import("../src/config/database.js");

  try {
    await migrator.down({ to: 0 });
    await migrator.up();
  } finally {
    await sequelize.close();
  }
}
