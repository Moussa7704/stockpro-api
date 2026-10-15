import { afterAll, beforeEach, vi } from "vitest";
import { sequelize } from "../src/config/database.js";
import { assertTestDatabase } from "./test-env.js";
import { clearMailbox } from "./helpers/mailbox.js";

// Aucun vrai email : chaque envoi est rangé dans la boîte simulée
vi.mock("../src/utils/mailer.js", async () => {
  const { mailbox } = await import("./helpers/mailbox.js");
  return {
    sendOtpEmail: vi.fn(async ({ to, code }: { to: string; code: string }) => {
      mailbox.push({ type: "otp", to, code });
    }),
    sendInvitationEmail: vi.fn(async ({ to, link }: { to: string; link: string }) => {
      mailbox.push({ type: "invitation", to, link });
    }),
    sendPasswordResetEmail: vi.fn(async ({ to, link }: { to: string; link: string }) => {
      mailbox.push({ type: "reset", to, link });
    }),
    sendPasswordChangedEmail: vi.fn(async ({ to }: { to: string }) => {
      mailbox.push({ type: "password-changed", to });
    }),
    sendCompanyAccessEmail: vi.fn(async ({ to, companyName }: { to: string; companyName: string }) => {
      mailbox.push({ type: "company-access", to, companyName });
    }),
    verifyMailer: vi.fn(async () => {}),
  };
});

assertTestDatabase();

// Chaque test part de tables vides : aucun test ne dépend d'un autre
beforeEach(async () => {
  await sequelize.query(
    `TRUNCATE TABLE products, categories, units, suppliers,
       audit_logs, membership_shops, memberships, role_permissions, roles, shops,
       companies, refresh_tokens, email_otp_codes, password_tokens, users RESTART IDENTITY CASCADE;`,
  );
  clearMailbox();
});

afterAll(async () => {
  await sequelize.close();
});
