import { sequelize } from "../config/database.js";
import { migrator } from "./migrator.js";

/**
 * Point d'entrée des scripts pnpm db:* (CLI fournie par Umzug).
 *   up        applique les migrations en attente
 *   down      annule la dernière migration
 *   pending   liste les migrations en attente
 *   executed  liste les migrations déjà appliquées
 *   create    crée un nouveau fichier de migration
 */
try {
  await migrator.runAsCLI();
} finally {
  await sequelize.close();
}
