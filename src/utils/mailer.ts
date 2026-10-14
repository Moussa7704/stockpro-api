import nodemailer from "nodemailer";
import { env } from "../config/env.js";

// Une seule connexion SMTP réutilisée pour tous les envois
const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
});

// Le nom vient de l'utilisateur (inscription) : on l'échappe pour qu'il ne puisse pas injecter de HTML
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface OtpEmail {
  to: string;
  name: string;
  code: string;
  expiresInMinutes: number;
}

export async function sendOtpEmail({ to, name, code, expiresInMinutes }: OtpEmail): Promise<void> {
  const safeName = escapeHtml(name);

  await transporter.sendMail({
    from: env.MAIL_FROM,
    to,
    subject: `${code} est votre code de connexion StockPro`,
    // Version texte : lue par les clients mail sans HTML et utile contre le classement en spam
    text: [
      `Bonjour ${name},`,
      "",
      `Votre code de connexion StockPro : ${code}`,
      `Il expire dans ${expiresInMinutes} minutes.`,
      "",
      "Si vous n'êtes pas à l'origine de cette connexion, changez votre mot de passe.",
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; color: #1f2937">
        <h2 style="color: #1677ff">StockPro</h2>
        <p>Bonjour ${safeName},</p>
        <p>Votre code de connexion :</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 24px 0">${code}</p>
        <p>Il expire dans ${expiresInMinutes} minutes.</p>
        <p style="color: #6b7280; font-size: 13px">
          Si vous n'êtes pas à l'origine de cette connexion, changez votre mot de passe.
        </p>
      </div>
    `,
  });
}

/** Vérifie la connexion et l'authentification SMTP (utile pour diagnostiquer la configuration). */
export async function verifyMailer(): Promise<void> {
  await transporter.verify();
}
