import { assertTestDatabase, testEnv } from "./test-env.js";

/**
 * Exécuté une seule fois, avant tous les fichiers de test (dans le processus principal,
 * où la config "env" de Vitest ne s'applique pas encore : on l'applique à la main).
 * On annule toutes les migrations puis on les rejoue : ça vérifie au passage que
 * chaque "down" fonctionne, et les tests partent d'un schéma identique à la production.
 */
export async function setup(): Promise<void> {
  Object.assign(process.env, testEnv);
  assertTestDatabase();

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
