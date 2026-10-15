import { DataTypes, type Transaction } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * Clients et finances (cahier des charges §5.7) :
 * - customer_payments : règlements de dette client (en ajout seul)
 * - expense_categories + expenses : dépenses, éventuellement payées depuis le tiroir-caisse
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

// Catégories ajoutées aux entreprises existantes (copie figée, cf. modules/expenses)
const DEFAULT_CATEGORIES = ["Loyer", "Électricité et eau", "Salaires", "Transport", "Fournitures", "Autres"];

export const up: Migration = async ({ context: queryInterface }) => {
  const sql = (query: string, transaction: Transaction) => queryInterface.sequelize.query(query, { transaction });
  const sameCompanyFk = (table: string, column: string, target: string, transaction: Transaction) =>
    sql(
      `ALTER TABLE ${table} ADD CONSTRAINT ${table}_${column}_same_company_fkey
         FOREIGN KEY (company_id, ${column}) REFERENCES ${target} (company_id, id)
         ON UPDATE CASCADE ON DELETE RESTRICT;`,
      transaction,
    );

  await queryInterface.sequelize.transaction(async (transaction) => {
    // --- Règlements de dette client
    await queryInterface.createTable(
      "customer_payments",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        customer_id: { type: DataTypes.UUID, allowNull: false },
        shop_id: { type: DataTypes.UUID, allowNull: false },
        payment_method_id: { type: DataTypes.UUID, allowNull: false },
        // Renseignée pour les espèces : l'argent entre dans ce tiroir-caisse
        cash_session_id: { type: DataTypes.UUID, allowNull: true },
        amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
        reference: { type: DataTypes.STRING(60), allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        created_by: userForeignKey(false),
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    await sameCompanyFk("customer_payments", "customer_id", "customers", transaction);
    await sameCompanyFk("customer_payments", "shop_id", "shops", transaction);
    await sameCompanyFk("customer_payments", "payment_method_id", "payment_methods", transaction);
    await sameCompanyFk("customer_payments", "cash_session_id", "cash_sessions", transaction);
    await sql(
      `ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_amount_check CHECK (amount > 0);
       CREATE INDEX customer_payments_customer_idx ON customer_payments (customer_id, created_at);
       CREATE INDEX customer_payments_session_idx ON customer_payments (cash_session_id);
       CREATE TRIGGER customer_payments_no_update_or_delete BEFORE UPDATE OR DELETE ON customer_payments
         FOR EACH ROW EXECUTE FUNCTION append_only_guard();`,
      transaction,
    );

    // --- Catégories de dépenses
    await queryInterface.createTable(
      "expense_categories",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        name: { type: DataTypes.STRING(80), allowNull: false },
        archived_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE expense_categories ADD CONSTRAINT expense_categories_company_id_id_key UNIQUE (company_id, id);
       CREATE UNIQUE INDEX expense_categories_company_name_key ON expense_categories (company_id, lower(name));`,
      transaction,
    );

    // --- Dépenses
    await queryInterface.createTable(
      "expenses",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        shop_id: { type: DataTypes.UUID, allowNull: false },
        category_id: { type: DataTypes.UUID, allowNull: false },
        number: { type: DataTypes.STRING(40), allowNull: false },
        amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
        description: { type: DataTypes.STRING(255), allowNull: false },
        spent_at: { type: DataTypes.DATEONLY, allowNull: false },
        payment_method_id: { type: DataTypes.UUID, allowNull: false },
        // Renseignée si la dépense est payée en espèces DEPUIS le tiroir-caisse
        cash_session_id: { type: DataTypes.UUID, allowNull: true },
        supplier_id: { type: DataTypes.UUID, allowNull: true },
        reference: { type: DataTypes.STRING(60), allowNull: true },
        status: { type: DataTypes.ENUM("recorded", "cancelled"), allowNull: false, defaultValue: "recorded" },
        created_by: userForeignKey(false),
        cancelled_at: { type: DataTypes.DATE, allowNull: true },
        cancelled_by: userForeignKey(true),
        cancel_reason: { type: DataTypes.STRING(255), allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await sameCompanyFk("expenses", "shop_id", "shops", transaction);
    await sameCompanyFk("expenses", "category_id", "expense_categories", transaction);
    await sameCompanyFk("expenses", "payment_method_id", "payment_methods", transaction);
    await sameCompanyFk("expenses", "cash_session_id", "cash_sessions", transaction);
    await sameCompanyFk("expenses", "supplier_id", "suppliers", transaction);
    await sql(
      `ALTER TABLE expenses ADD CONSTRAINT expenses_company_id_id_key UNIQUE (company_id, id);
       ALTER TABLE expenses ADD CONSTRAINT expenses_company_number_key UNIQUE (company_id, number);
       ALTER TABLE expenses ADD CONSTRAINT expenses_amount_check CHECK (amount > 0);
       CREATE INDEX expenses_company_spent_idx ON expenses (company_id, spent_at);
       CREATE INDEX expenses_session_idx ON expenses (cash_session_id);`,
      transaction,
    );

    for (const name of DEFAULT_CATEGORIES) {
      await queryInterface.sequelize.query(
        `INSERT INTO expense_categories (id, company_id, name, created_at, updated_at)
         SELECT gen_random_uuid(), id, :name, now(), now() FROM companies`,
        { replacements: { name }, transaction },
      );
    }
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("expenses", { transaction });
    await queryInterface.dropTable("expense_categories", { transaction });
    await queryInterface.dropTable("customer_payments", { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_expenses_status";', { transaction });
  });
};
