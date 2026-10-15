import { DataTypes, type Transaction } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * Caisse (cahier des charges §5.6, §5.7, RB-05, RB-08, RB-09, RB-10) :
 * - payment_methods : moyens de paiement de l'entreprise
 * - cash_sessions : fond de caisse, clôture, écart (une seule session ouverte par caissier × boutique)
 * - customers + customer_ledger_entries (compte client en ajout seul)
 * - sales + sale_lines (prix et coût figés) + sale_payments
 * - sale_returns + sale_return_lines (retours clients liés à la ligne vendue)
 */

const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
};

const companyForeignKey = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: "companies", key: "id" },
  onUpdate: "CASCADE",
  onDelete: "RESTRICT",
};

const userForeignKey = (allowNull: boolean) => ({
  type: DataTypes.UUID,
  allowNull,
  references: { model: "users", key: "id" },
  onUpdate: "CASCADE",
  onDelete: "RESTRICT",
});

const money = (allowNull = false) => ({ type: DataTypes.DECIMAL(14, 2), allowNull });
const quantity = (allowNull = false) => ({ type: DataTypes.DECIMAL(14, 3), allowNull });

// Moyens de paiement ajoutés aux entreprises existantes (copie figée, cf. modules/pos)
const DEFAULT_METHODS = [
  { code: "cash", name: "Espèces", type: "cash", sortOrder: 1 },
  { code: "mobile_money", name: "Mobile Money", type: "mobile_money", sortOrder: 2 },
  { code: "card", name: "Carte bancaire", type: "card", sortOrder: 3 },
];

export const up: Migration = async ({ context: queryInterface }) => {
  const sql = (query: string, transaction: Transaction) => queryInterface.sequelize.query(query, { transaction });
  const sameCompanyFk = (table: string, column: string, target: string, transaction: Transaction) =>
    sql(
      `ALTER TABLE ${table} ADD CONSTRAINT ${table}_${column}_same_company_fkey
         FOREIGN KEY (company_id, ${column}) REFERENCES ${target} (company_id, id)
         ON UPDATE CASCADE ON DELETE RESTRICT;`,
      transaction,
    );
  const companyScoped = (table: string, transaction: Transaction) =>
    sql(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_company_id_id_key UNIQUE (company_id, id);`, transaction);
  const appendOnly = (table: string, transaction: Transaction) =>
    sql(
      `CREATE TRIGGER ${table}_no_update_or_delete BEFORE UPDATE OR DELETE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION append_only_guard();`,
      transaction,
    );

  await queryInterface.sequelize.transaction(async (transaction) => {
    // Fonction commune aux journaux en ajout seul (compte client, paiements de vente)
    await sql(
      `CREATE FUNCTION append_only_guard() RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION '% est en ajout seul : modification et suppression interdites', TG_TABLE_NAME;
       END;
       $$ LANGUAGE plpgsql;`,
      transaction,
    );

    // --- Moyens de paiement
    await queryInterface.createTable(
      "payment_methods",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        code: { type: DataTypes.STRING(30), allowNull: false },
        name: { type: DataTypes.STRING(60), allowNull: false },
        // cash : entre dans le tiroir-caisse (fond, écart de caisse, rendu de monnaie)
        type: {
          type: DataTypes.ENUM("cash", "mobile_money", "card", "bank", "other"),
          allowNull: false,
        },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        ...timestamps,
      },
      { transaction },
    );
    await companyScoped("payment_methods", transaction);
    await sql(
      "ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_company_code_key UNIQUE (company_id, code);",
      transaction,
    );

    // --- Sessions de caisse
    await queryInterface.createTable(
      "cash_sessions",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        shop_id: { type: DataTypes.UUID, allowNull: false },
        cashier_id: userForeignKey(false),
        status: { type: DataTypes.ENUM("open", "closed"), allowNull: false, defaultValue: "open" },
        opened_at: { type: DataTypes.DATE, allowNull: false },
        opening_float: money(),
        closed_at: { type: DataTypes.DATE, allowNull: true },
        closed_by: userForeignKey(true),
        expected_cash: money(true),
        counted_cash: money(true),
        difference: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await companyScoped("cash_sessions", transaction);
    await sameCompanyFk("cash_sessions", "shop_id", "shops", transaction);
    await sql(
      `ALTER TABLE cash_sessions ADD CONSTRAINT cash_sessions_amounts_check
         CHECK (opening_float >= 0 AND (counted_cash IS NULL OR counted_cash >= 0));
       -- RB-08 : une seule session ouverte par caissier et par boutique
       CREATE UNIQUE INDEX cash_sessions_one_open_key ON cash_sessions (shop_id, cashier_id) WHERE status = 'open';
       CREATE INDEX cash_sessions_company_opened_idx ON cash_sessions (company_id, opened_at);`,
      transaction,
    );

    // --- Clients et compte client
    await queryInterface.createTable(
      "customers",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        name: { type: DataTypes.STRING(150), allowNull: false },
        phone: { type: DataTypes.STRING(30), allowNull: true },
        email: { type: DataTypes.STRING(255), allowNull: true },
        address: { type: DataTypes.STRING(255), allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        // null : pas de crédit autorisé au-delà de 0 ; sinon dette maximale
        credit_limit: money(true),
        // Dette actuelle (somme du compte client) : positive = le client doit de l'argent
        balance: { ...money(), defaultValue: 0 },
        archived_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await companyScoped("customers", transaction);
    await sql(
      `ALTER TABLE customers ADD CONSTRAINT customers_credit_limit_check CHECK (credit_limit IS NULL OR credit_limit >= 0);
       CREATE UNIQUE INDEX customers_company_phone_key ON customers (company_id, phone) WHERE phone IS NOT NULL;
       CREATE INDEX customers_company_name_idx ON customers (company_id, lower(name));`,
      transaction,
    );

    await queryInterface.createTable(
      "customer_ledger_entries",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        customer_id: { type: DataTypes.UUID, allowNull: false },
        type: {
          type: DataTypes.ENUM("sale_credit", "sale_cancellation", "payment", "return_credit", "adjustment"),
          allowNull: false,
        },
        // Signé : + augmente la dette du client, − la diminue
        amount: money(),
        balance_after: money(),
        source_type: { type: DataTypes.STRING(40), allowNull: false },
        source_id: { type: DataTypes.UUID, allowNull: false },
        created_by: userForeignKey(true),
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    await sameCompanyFk("customer_ledger_entries", "customer_id", "customers", transaction);
    await sql(
      `ALTER TABLE customer_ledger_entries ADD CONSTRAINT customer_ledger_amount_not_zero CHECK (amount <> 0);
       CREATE INDEX customer_ledger_customer_idx ON customer_ledger_entries (customer_id, created_at);`,
      transaction,
    );
    await appendOnly("customer_ledger_entries", transaction);

    // --- Ventes
    await queryInterface.createTable(
      "sales",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        shop_id: { type: DataTypes.UUID, allowNull: false },
        cash_session_id: { type: DataTypes.UUID, allowNull: false },
        customer_id: { type: DataTypes.UUID, allowNull: true },
        number: { type: DataTypes.STRING(40), allowNull: false },
        status: { type: DataTypes.ENUM("completed", "cancelled"), allowNull: false, defaultValue: "completed" },
        subtotal: money(),
        discount_total: money(),
        total: money(),
        amount_paid: money(),
        change_given: { ...money(), defaultValue: 0 },
        // Reste dû, porté au compte du client
        balance_due: { ...money(), defaultValue: 0 },
        notes: { type: DataTypes.TEXT, allowNull: true },
        created_by: userForeignKey(false),
        cancelled_at: { type: DataTypes.DATE, allowNull: true },
        cancelled_by: userForeignKey(true),
        cancel_reason: { type: DataTypes.STRING(255), allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await companyScoped("sales", transaction);
    await sameCompanyFk("sales", "shop_id", "shops", transaction);
    await sameCompanyFk("sales", "cash_session_id", "cash_sessions", transaction);
    await sameCompanyFk("sales", "customer_id", "customers", transaction);
    await sql(
      `ALTER TABLE sales ADD CONSTRAINT sales_company_number_key UNIQUE (company_id, number);
       ALTER TABLE sales ADD CONSTRAINT sales_amounts_check CHECK (
         subtotal >= 0 AND discount_total >= 0 AND total >= 0 AND total = subtotal - discount_total
         AND amount_paid >= 0 AND balance_due >= 0 AND change_given >= 0
         AND amount_paid + balance_due = total);
       ALTER TABLE sales ADD CONSTRAINT sales_credit_needs_customer CHECK (balance_due = 0 OR customer_id IS NOT NULL);
       CREATE INDEX sales_company_created_idx ON sales (company_id, created_at);
       CREATE INDEX sales_session_idx ON sales (cash_session_id);
       CREATE INDEX sales_customer_idx ON sales (company_id, customer_id);`,
      transaction,
    );

    await queryInterface.createTable(
      "sale_lines",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        sale_id: { type: DataTypes.UUID, allowNull: false },
        product_id: { type: DataTypes.UUID, allowNull: false },
        quantity: quantity(),
        // Prix réellement appliqué : une modification ultérieure du produit ne change rien (RB-03)
        unit_price: money(),
        // Remise de la ligne + part de la remise globale du ticket
        discount: { ...money(), defaultValue: 0 },
        line_total: money(),
        // Coût moyen au moment de la vente : marge exacte (D-05)
        unit_cost: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
        returned_quantity: { ...quantity(), defaultValue: 0 },
        ...timestamps,
      },
      { transaction },
    );
    await companyScoped("sale_lines", transaction);
    await sameCompanyFk("sale_lines", "sale_id", "sales", transaction);
    await sameCompanyFk("sale_lines", "product_id", "products", transaction);
    await sql(
      `ALTER TABLE sale_lines ADD CONSTRAINT sale_lines_values_check CHECK (
         quantity > 0 AND unit_price >= 0 AND discount >= 0 AND line_total >= 0
         AND returned_quantity >= 0 AND returned_quantity <= quantity);`,
      transaction,
    );

    await queryInterface.createTable(
      "sale_payments",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        sale_id: { type: DataTypes.UUID, allowNull: false },
        payment_method_id: { type: DataTypes.UUID, allowNull: false },
        cash_session_id: { type: DataTypes.UUID, allowNull: false },
        amount: money(),
        // Ex. n° de transaction Mobile Money
        reference: { type: DataTypes.STRING(60), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    await sameCompanyFk("sale_payments", "sale_id", "sales", transaction);
    await sameCompanyFk("sale_payments", "payment_method_id", "payment_methods", transaction);
    await sameCompanyFk("sale_payments", "cash_session_id", "cash_sessions", transaction);
    await sql(
      `ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_amount_check CHECK (amount > 0);
       CREATE INDEX sale_payments_session_idx ON sale_payments (cash_session_id);`,
      transaction,
    );
    await appendOnly("sale_payments", transaction);

    // --- Retours clients
    await queryInterface.createTable(
      "sale_returns",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        shop_id: { type: DataTypes.UUID, allowNull: false },
        sale_id: { type: DataTypes.UUID, allowNull: false },
        cash_session_id: { type: DataTypes.UUID, allowNull: true },
        number: { type: DataTypes.STRING(40), allowNull: false },
        reason: { type: DataTypes.STRING(255), allowNull: false },
        refund_amount: money(),
        // method : remboursé par un moyen de paiement ; customer_account : déduit de la dette du client
        refund_to: { type: DataTypes.ENUM("method", "customer_account"), allowNull: false },
        refund_method_id: { type: DataTypes.UUID, allowNull: true },
        created_by: userForeignKey(false),
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    await companyScoped("sale_returns", transaction);
    await sameCompanyFk("sale_returns", "shop_id", "shops", transaction);
    await sameCompanyFk("sale_returns", "sale_id", "sales", transaction);
    await sameCompanyFk("sale_returns", "cash_session_id", "cash_sessions", transaction);
    await sameCompanyFk("sale_returns", "refund_method_id", "payment_methods", transaction);
    await sql(
      `ALTER TABLE sale_returns ADD CONSTRAINT sale_returns_company_number_key UNIQUE (company_id, number);
       ALTER TABLE sale_returns ADD CONSTRAINT sale_returns_refund_check CHECK (
         refund_amount >= 0 AND (refund_to <> 'method' OR refund_method_id IS NOT NULL));
       CREATE INDEX sale_returns_session_idx ON sale_returns (cash_session_id);`,
      transaction,
    );

    await queryInterface.createTable(
      "sale_return_lines",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        return_id: { type: DataTypes.UUID, allowNull: false },
        sale_line_id: { type: DataTypes.UUID, allowNull: false },
        product_id: { type: DataTypes.UUID, allowNull: false },
        quantity: quantity(),
        // false : article abîmé, non remis en vente
        restock: { type: DataTypes.BOOLEAN, allowNull: false },
        refund_amount: money(),
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    await sameCompanyFk("sale_return_lines", "return_id", "sale_returns", transaction);
    await sameCompanyFk("sale_return_lines", "sale_line_id", "sale_lines", transaction);
    await sameCompanyFk("sale_return_lines", "product_id", "products", transaction);
    await sql(
      "ALTER TABLE sale_return_lines ADD CONSTRAINT sale_return_lines_values_check CHECK (quantity > 0 AND refund_amount >= 0);",
      transaction,
    );

    // Moyens de paiement par défaut des entreprises existantes
    for (const method of DEFAULT_METHODS) {
      await queryInterface.sequelize.query(
        `INSERT INTO payment_methods (id, company_id, code, name, type, sort_order, created_at, updated_at)
         SELECT gen_random_uuid(), id, :code, :name, :type, :sortOrder, now(), now() FROM companies`,
        { replacements: method, transaction },
      );
    }
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    for (const table of [
      "sale_return_lines",
      "sale_returns",
      "sale_payments",
      "sale_lines",
      "sales",
      "customer_ledger_entries",
      "customers",
      "cash_sessions",
      "payment_methods",
    ]) {
      await queryInterface.dropTable(table, { transaction });
    }
    await queryInterface.sequelize.query(
      `DROP FUNCTION IF EXISTS append_only_guard();
       DROP TYPE IF EXISTS "enum_sale_returns_refund_to";
       DROP TYPE IF EXISTS "enum_sales_status";
       DROP TYPE IF EXISTS "enum_customer_ledger_entries_type";
       DROP TYPE IF EXISTS "enum_cash_sessions_status";
       DROP TYPE IF EXISTS "enum_payment_methods_type";`,
      { transaction },
    );
  });
};
