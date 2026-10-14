import { fileURLToPath, pathToFileURL } from "node:url";
import { SequelizeStorage, Umzug } from "umzug";
import { sequelize } from "../config/database.js";

/**
 * Moteur de migrations (Umzug, celui qu'utilise sequelize-cli).
 * Chaque fichier de src/database/migrations décrit un changement du schéma (up) et son inverse (down).
 * La table "sequelize_meta" retient les migrations déjà appliquées : chacune ne tourne qu'une fois.
 */

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

// En dev on exécute les .ts (tsx), en production les .js compilés par tsc.
// tinyglobby attend des "/" même sous Windows.
const migrationsGlob = `${migrationsDir.replace(/\\/g, "/")}/*.{ts,js}`;

const MIGRATION_TEMPLATE = `import { DataTypes } from "sequelize";
import type { Migration } from "../migrator.js";

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // ex. await queryInterface.addColumn("users", "phone", { type: DataTypes.STRING(20) }, { transaction });
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // ex. await queryInterface.removeColumn("users", "phone", { transaction });
  });
};
`;

export const migrator = new Umzug({
  migrations: {
    glob: migrationsGlob,
    resolve: ({ name, path, context }) => {
      // Le resolver par défaut utilise require() : on importe en ESM pour charger nos fichiers.
      // Nom sans extension : la même migration a le même nom en dev (.ts) et en production (.js)
      const loadModule = () => import(pathToFileURL(path!).href);
      return {
        name: name.replace(/\.(ts|js)$/, ""),
        up: async () => (await loadModule()).up({ context }),
        down: async () => (await loadModule()).down({ context }),
      };
    },
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: console,
  create: {
    folder: migrationsDir,
    template: (filepath) => [[filepath, MIGRATION_TEMPLATE]],
  },
});

export type Migration = typeof migrator._types.migration;

/** Au démarrage : refuse de lancer l'API sur un schéma de base en retard. */
export async function assertNoPendingMigrations(): Promise<void> {
  const pending = await migrator.pending();
  if (pending.length > 0) {
    const names = pending.map((migration) => `  - ${migration.name}`).join("\n");
    throw new Error(`Migrations en attente :\n${names}\nLancez : pnpm db:migrate`);
  }
}
