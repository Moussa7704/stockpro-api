import nodemailer from "nodemailer";
import { env } from "../config/env.js";

// Une seule connexion SMTP réutilisée pour tous les envois
const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASS },
});

const from = env.MAIL_FROM ?? `"StockPro" <${env.EMAIL_USER}>`;

// Les noms viennent des utilisateurs : on les échappe pour qu'ils ne puissent pas injecter de HTML
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Mise en page commune à tous les emails (le contenu passé ici est déjà échappé)
function layout(body: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; color: #1f2937">
      <h2 style="color: #4f46e5">StockPro</h2>
      ${body}
    </div>
  `;
}

function button(link: string, label: string): string {
  return `
    <p style="margin: 28px 0">
      <a href="${escapeHtml(link)}"
         style="background: #4f46e5; color: #fff; padding: 12px 20px; border-radius: 8px; text-decoration: none">
        ${label}
      </a>
    </p>
    <p style="color: #6b7280; font-size: 13px">
      Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>${escapeHtml(link)}
    </p>
  `;
}

interface OtpEmail {
  to: string;
  name: string;
  code: string;
  expiresInMinutes: number;
}

export async function sendOtpEmail({ to, name, code, expiresInMinutes }: OtpEmail): Promise<void> {
  await transporter.sendMail({
    from,
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
    html: layout(`
      <p>Bonjour ${escapeHtml(name)},</p>
      <p>Votre code de connexion :</p>
      <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 24px 0">${code}</p>
      <p>Il expire dans ${expiresInMinutes} minutes.</p>
      <p style="color: #6b7280; font-size: 13px">
        Si vous n'êtes pas à l'origine de cette connexion, changez votre mot de passe.
      </p>
    `),
  });
}

interface InvitationEmail {
  to: string;
  name: string;
  invitedBy: string;
  link: string;
  expiresInHours: number;
}

export async function sendInvitationEmail({
  to,
  name,
  invitedBy,
  link,
  expiresInHours,
}: InvitationEmail): Promise<void> {
  await transporter.sendMail({
    from,
    to,
    subject: "Votre compte StockPro a été créé",
    text: [
      `Bonjour ${name},`,
      "",
      `${invitedBy} vous a créé un compte sur StockPro.`,
      `Choisissez votre mot de passe en ouvrant ce lien (valable ${expiresInHours} heures) :`,
      link,
    ].join("\n"),
    html: layout(`
      <p>Bonjour ${escapeHtml(name)},</p>
      <p>${escapeHtml(invitedBy)} vous a créé un compte sur StockPro.</p>
      <p>Choisissez votre mot de passe pour l'activer. Ce lien est valable ${expiresInHours} heures.</p>
      ${button(link, "Définir mon mot de passe")}
    `),
  });
}

interface PasswordResetEmail {
  to: string;
  name: string;
  link: string;
  expiresInMinutes: number;
}

export async function sendPasswordResetEmail({
  to,
  name,
  link,
  expiresInMinutes,
}: PasswordResetEmail): Promise<void> {
  await transporter.sendMail({
    from,
    to,
    subject: "Réinitialisation de votre mot de passe StockPro",
    text: [
      `Bonjour ${name},`,
      "",
      `Pour choisir un nouveau mot de passe, ouvrez ce lien (valable ${expiresInMinutes} minutes) :`,
      link,
      "",
      "Si vous n'avez rien demandé, ignorez cet email : votre mot de passe reste inchangé.",
    ].join("\n"),
    html: layout(`
      <p>Bonjour ${escapeHtml(name)},</p>
      <p>Vous avez demandé à réinitialiser votre mot de passe. Ce lien est valable ${expiresInMinutes} minutes.</p>
      ${button(link, "Choisir un nouveau mot de passe")}
      <p style="color: #6b7280; font-size: 13px">
        Si vous n'avez rien demandé, ignorez cet email : votre mot de passe reste inchangé.
      </p>
    `),
  });
}

/** Vérifie la connexion et l'authentification SMTP (utile pour diagnostiquer la configuration). */
export async function verifyMailer(): Promise<void> {
  await transporter.verify();
}
