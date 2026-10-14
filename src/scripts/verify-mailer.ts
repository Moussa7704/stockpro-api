import { sendOtpEmail, verifyMailer } from "../utils/mailer.js";

/**
 * Vérifie la configuration SMTP du .env :
 *   pnpm mail:verify                    → connexion + authentification seulement
 *   pnpm mail:verify moi@exemple.com    → envoie en plus un email de test avec un faux code
 */
const recipient = process.argv[2];

try {
  await verifyMailer();
  console.log("✅ Connexion SMTP et authentification OK");

  if (recipient) {
    await sendOtpEmail({ to: recipient, name: "Test", code: "123456", expiresInMinutes: 10 });
    console.log(`✅ Email de test envoyé à ${recipient}`);
  }
} catch (error) {
  console.error("❌ Échec SMTP :", error instanceof Error ? error.message : error);
  console.error(
    "Gmail : SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_SECURE=true, " +
      "SMTP_PASSWORD = mot de passe d'application (16 caractères), pas celui du compte.",
  );
  process.exitCode = 1;
}
