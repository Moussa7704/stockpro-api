/**
 * Boîte mail simulée : les fonctions du mailer sont remplacées (tests/setup.ts)
 * et chaque "envoi" est rangé ici, pour que les tests lisent codes et liens.
 */

export type SentEmail =
  | { type: "otp"; to: string; code: string }
  | { type: "invitation"; to: string; link: string }
  | { type: "reset"; to: string; link: string }
  | { type: "password-changed"; to: string }
  | { type: "company-access"; to: string; companyName: string };

export const mailbox: SentEmail[] = [];

export function clearMailbox(): void {
  mailbox.length = 0;
}

function last<T extends SentEmail["type"]>(type: T, to: string) {
  const email = [...mailbox].reverse().find((item) => item.type === type && item.to === to);
  if (!email) {
    throw new Error(`Aucun email "${type}" envoyé à ${to}`);
  }
  return email as Extract<SentEmail, { type: T }>;
}

export function lastOtpCode(to: string): string {
  return last("otp", to).code;
}

/** Jeton contenu dans le dernier lien d'invitation ou de réinitialisation envoyé. */
export function lastLinkToken(type: "invitation" | "reset", to: string): string {
  const token = new URL(last(type, to).link).searchParams.get("token");
  if (!token) {
    throw new Error("Lien sans jeton");
  }
  return token;
}

export function emailsTo(to: string): SentEmail[] {
  return mailbox.filter((item) => item.to === to);
}
