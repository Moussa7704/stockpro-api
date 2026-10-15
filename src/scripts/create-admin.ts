import { parseArgs } from "node:util";
import { z } from "zod";
import { sequelize } from "../config/database.js";
import { User } from "../models/index.js";
import { emailSchema, nameSchema } from "../modules/auth/auth.schemas.js";
import * as passwordService from "../modules/auth/password.service.js";

/**
 * Crée le premier administrateur (il n'y a pas d'inscription publique).
 *   pnpm user:create-admin --email admin@exemple.com --name "Prénom Nom"
 * L'admin reçoit un email pour définir son mot de passe.
 * Si le compte existe déjà, il devient admin (et reçoit une invitation s'il n'a pas de mot de passe).
 */

const argsSchema = z.object({ email: emailSchema, name: nameSchema });

try {
  const { values } = parseArgs({
    options: { email: { type: "string" }, name: { type: "string" } },
  });
  const parsed = argsSchema.safeParse(values);
  if (!parsed.success) {
    console.error('Usage : pnpm user:create-admin --email admin@exemple.com --name "Prénom Nom"');
    console.error(z.prettifyError(parsed.error));
    process.exitCode = 1;
  } else {
    const { email, name } = parsed.data;
    const existing = await User.findOne({ where: { email } });

    if (existing) {
      await existing.update({ role: "admin" });
      console.log(`✅ ${email} existait déjà : il est maintenant admin`);
      if (existing.password === null) {
        await passwordService.sendInvitation(existing, "StockPro");
        console.log("✉️  Invitation renvoyée pour définir le mot de passe");
      }
    } else {
      await sequelize.transaction(async (transaction) => {
        const admin = await User.create({ email, name, role: "admin" }, { transaction });
        await passwordService.sendInvitation(admin, "StockPro", transaction);
      });
      console.log(`✅ Admin ${email} créé`);
      console.log("✉️  Un email lui a été envoyé pour définir son mot de passe");
    }
  }
} catch (error) {
  console.error("❌", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
