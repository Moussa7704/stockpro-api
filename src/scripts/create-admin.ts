import { parseArgs } from "node:util";
import { z } from "zod";
import { sequelize } from "../config/database.js";
import { User } from "../models/index.js";
import { emailSchema, nameSchema } from "../modules/auth/auth.schemas.js";
import * as passwordService from "../modules/auth/password.service.js";

/**
 * Crée l'administrateur de la plateforme SaaS (il gère les commerçants depuis /api/platform).
 *   pnpm user:create-admin --email admin@exemple.com --name "Prénom Nom"
 * L'admin reçoit un email pour définir son mot de passe.
 * Si le compte existe déjà, il devient administrateur de la plateforme
 * (et reçoit une invitation s'il n'a pas encore de mot de passe).
 */

const argsSchema = z.object({ email: emailSchema, name: nameSchema });
const sender = { invitedBy: "StockPro" };

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
      await existing.update({ isPlatformAdmin: true });
      console.log(`✅ ${email} existait déjà : il est maintenant administrateur de la plateforme`);
      if (existing.password === null) {
        await passwordService.sendInvitation(existing, sender);
        console.log("✉️  Invitation renvoyée pour définir le mot de passe");
      }
    } else {
      await sequelize.transaction(async (transaction) => {
        const admin = await User.create({ email, name, isPlatformAdmin: true }, { transaction });
        await passwordService.sendInvitation(admin, sender, transaction);
      });
      console.log(`✅ Administrateur de la plateforme ${email} créé`);
      console.log("✉️  Un email lui a été envoyé pour définir son mot de passe");
    }
  }
} catch (error) {
  console.error("❌", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
