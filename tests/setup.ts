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

// Toutes les tables de l'application (enfants avant parents). À compléter à chaque nouvelle table.
const TABLES = [
  "idempotency_keys",
  "supplier_payments",
  "supplier_invoices",
  "supplier_return_lines",
  "supplier_returns",
  "goods_receipt_lines",
  "goods_receipts",
  "purchase_order_lines",
  "purchase_orders",
  "stock_movements",
  "inventory_count_lines",
  "inventory_counts",
  "stock_transfer_lines",
  "stock_transfers",
  "stock_adjustments",
  "stock_levels",
  "document_sequences",
  "products",
  "categories",
  "units",
  "suppliers",
  "audit_logs",
  "membership_shops",
  "memberships",
  "role_permissions",
  "roles",
  "shops",
  "companies",
  "refresh_tokens",
  "email_otp_codes",
  "password_tokens",
  "users",
];

/**
 * Chaque test part de tables vides : aucun test ne dépend d'un autre.
 * DELETE plutôt que TRUNCATE : TRUNCATE recrée les fichiers des tables (≈ 10 s pour 23 tables
 * sous Windows, avant CHAQUE test), DELETE sur des tables presque vides prend quelques ms.
 * session_replication_role = replica coupe les triggers le temps du nettoyage (dont le trigger
 * "ajout seul" du journal de stock) : réservé à un superutilisateur, d'où TEST_DB_USER=postgres.
 */
beforeEach(async () => {
  await sequelize.query(
    `SET session_replication_role = replica;
     ${TABLES.map((table) => `DELETE FROM ${table};`).join("\n")}
     SET session_replication_role = DEFAULT;`,
  );
  clearMailbox();
});

afterAll(async () => {
  await sequelize.close();
});
