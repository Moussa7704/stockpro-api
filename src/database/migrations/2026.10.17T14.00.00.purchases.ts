import { DataTypes, type Transaction } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * Achats (cahier des charges §5.5, RB-06) et idempotence (RB-05) :
 * - purchase_orders (+ lignes) : n'augmentent JAMAIS le stock
 * - goods_receipts (+ lignes) : seule la réception validée augmente le stock (et le CMP)
 * - supplier_returns (+ lignes) : sortie de stock à la validation
 * - supplier_invoices + supplier_payments : dettes fournisseurs, suivies à part
 * - idempotency_keys : une requête rejouée (coupure réseau) ne crée pas de doublon
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

  await queryInterface.sequelize.transaction(async (transaction) => {
    // --- Bons de commande
    await queryInterface.createTable(
      "purchase_orders",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        shop_id: { type: DataTypes.UUID, allowNull: false },
        supplier_id: { type: DataTypes.UUID, allowNull: false },
        number: { type: DataTypes.STRING(40), allowNull: false },
        status: {
          type: DataTypes.ENUM("draft", "sent", "partially_received", "received", "closed", "cancelled"),
          allowNull: false,
          defaultValue: "draft",
        },
        expected_at: { type: DataTypes.DATEONLY, allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        total: { ...money(), defaultValue: 0 },
        created_by: userForeignKey(false),
        sent_at: { type: DataTypes.DATE, allowNull: true },
        closed_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await companyScoped("purchase_orders", transaction);
    await sql(
      `ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_company_number_key UNIQUE (company_id, number);
       CREATE INDEX purchase_orders_company_status_idx ON purchase_orders (company_id, status);`,
      transaction,
    );
    await sameCompanyFk("purchase_orders", "shop_id", "shops", transaction);
    await sameCompanyFk("purchase_orders", "supplier_id", "suppliers", transaction);

    await queryInterface.createTable(
      "purchase_order_lines",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        order_id: { type: DataTypes.UUID, allowNull: false },
        product_id: { type: DataTypes.UUID, allowNull: false },
        quantity_ordered: quantity(),
        quantity_received: { ...quantity(), defaultValue: 0 },
        unit_cost: money(),
        line_total: money(),
        ...timestamps,
      },
      { transaction },
    );
    await companyScoped("purchase_order_lines", transaction);
    await sql(
      `ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_quantities_check
         CHECK (quantity_ordered > 0 AND quantity_received >= 0 AND quantity_received <= quantity_ordered
                AND unit_cost >= 0);
       ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_order_product_key
         UNIQUE (order_id, product_id);`,
      transaction,
    );
    await sameCompanyFk("purchase_order_lines", "order_id", "purchase_orders", transaction);
    await sameCompanyFk("purchase_order_lines", "product_id", "products", transaction);

    // --- Réceptions
    await queryInterface.createTable(
      "goods_receipts",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        shop_id: { type: DataTypes.UUID, allowNull: false },
        supplier_id: { type: DataTypes.UUID, allowNull: false },
        order_id: { type: DataTypes.UUID, allowNull: true },
        number: { type: DataTypes.STRING(40), allowNull: false },
        status: {
          type: DataTypes.ENUM("draft", "validated", "cancelled"),
          allowNull: false,
          defaultValue: "draft",
        },
        // N° du bon de livraison du fournisseur
        supplier_reference: { type: DataTypes.STRING(60), allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        total: { ...money(), defaultValue: 0 },
        created_by: userForeignKey(false),
        validated_at: { type: DataTypes.DATE, allowNull: true },
        validated_by: userForeignKey(true),
        ...timestamps,
      },
      { transaction },
    );
    await companyScoped("goods_receipts", transaction);
    await sql(
      `ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_company_number_key UNIQUE (company_id, number);
       CREATE INDEX goods_receipts_company_order_idx ON goods_receipts (company_id, order_id);`,
      transaction,
    );
    await sameCompanyFk("goods_receipts", "shop_id", "shops", transaction);
    await sameCompanyFk("goods_receipts", "supplier_id", "suppliers", transaction);
    await sameCompanyFk("goods_receipts", "order_id", "purchase_orders", transaction);

    await queryInterface.createTable(
      "goods_receipt_lines",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        receipt_id: { type: DataTypes.UUID, allowNull: false },
        product_id: { type: DataTypes.UUID, allowNull: false },
        order_line_id: { type: DataTypes.UUID, allowNull: true },
        quantity: quantity(),
        unit_cost: money(),
        line_total: money(),
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE goods_receipt_lines ADD CONSTRAINT goods_receipt_lines_values_check
         CHECK (quantity > 0 AND unit_cost >= 0);
       ALTER TABLE goods_receipt_lines ADD CONSTRAINT goods_receipt_lines_receipt_product_key
         UNIQUE (receipt_id, product_id);`,
      transaction,
    );
    await sameCompanyFk("goods_receipt_lines", "receipt_id", "goods_receipts", transaction);
    await sameCompanyFk("goods_receipt_lines", "product_id", "products", transaction);
    await sameCompanyFk("goods_receipt_lines", "order_line_id", "purchase_order_lines", transaction);

    // --- Retours fournisseurs
    await queryInterface.createTable(
      "supplier_returns",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        shop_id: { type: DataTypes.UUID, allowNull: false },
        supplier_id: { type: DataTypes.UUID, allowNull: false },
        receipt_id: { type: DataTypes.UUID, allowNull: true },
        number: { type: DataTypes.STRING(40), allowNull: false },
        status: {
          type: DataTypes.ENUM("draft", "validated", "cancelled"),
          allowNull: false,
          defaultValue: "draft",
        },
        reason: { type: DataTypes.STRING(255), allowNull: false },
        notes: { type: DataTypes.TEXT, allowNull: true },
        total: { ...money(), defaultValue: 0 },
        created_by: userForeignKey(false),
        validated_at: { type: DataTypes.DATE, allowNull: true },
        validated_by: userForeignKey(true),
        ...timestamps,
      },
      { transaction },
    );
    await companyScoped("supplier_returns", transaction);
    await sql(
      "ALTER TABLE supplier_returns ADD CONSTRAINT supplier_returns_company_number_key UNIQUE (company_id, number);",
      transaction,
    );
    await sameCompanyFk("supplier_returns", "shop_id", "shops", transaction);
    await sameCompanyFk("supplier_returns", "supplier_id", "suppliers", transaction);
    await sameCompanyFk("supplier_returns", "receipt_id", "goods_receipts", transaction);

    await queryInterface.createTable(
      "supplier_return_lines",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        return_id: { type: DataTypes.UUID, allowNull: false },
        product_id: { type: DataTypes.UUID, allowNull: false },
        quantity: quantity(),
        // Valeur unitaire du retour : fixée à la validation (coût moyen si non précisée)
        unit_cost: money(true),
        line_total: money(true),
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE supplier_return_lines ADD CONSTRAINT supplier_return_lines_quantity_check CHECK (quantity > 0);
       ALTER TABLE supplier_return_lines ADD CONSTRAINT supplier_return_lines_return_product_key
         UNIQUE (return_id, product_id);`,
      transaction,
    );
    await sameCompanyFk("supplier_return_lines", "return_id", "supplier_returns", transaction);
    await sameCompanyFk("supplier_return_lines", "product_id", "products", transaction);

    // --- Factures fournisseurs et paiements
    await queryInterface.createTable(
      "supplier_invoices",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        supplier_id: { type: DataTypes.UUID, allowNull: false },
        receipt_id: { type: DataTypes.UUID, allowNull: true },
        // N° de facture du fournisseur
        reference: { type: DataTypes.STRING(60), allowNull: false },
        invoice_date: { type: DataTypes.DATEONLY, allowNull: false },
        due_date: { type: DataTypes.DATEONLY, allowNull: true },
        total: money(),
        amount_paid: { ...money(), defaultValue: 0 },
        status: {
          type: DataTypes.ENUM("unpaid", "partially_paid", "paid", "cancelled"),
          allowNull: false,
          defaultValue: "unpaid",
        },
        notes: { type: DataTypes.TEXT, allowNull: true },
        created_by: userForeignKey(false),
        ...timestamps,
      },
      { transaction },
    );
    await companyScoped("supplier_invoices", transaction);
    await sql(
      `ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_amounts_check
         CHECK (total > 0 AND amount_paid >= 0 AND amount_paid <= total);
       CREATE UNIQUE INDEX supplier_invoices_reference_key
         ON supplier_invoices (company_id, supplier_id, lower(reference));
       CREATE INDEX supplier_invoices_company_status_idx ON supplier_invoices (company_id, status);`,
      transaction,
    );
    await sameCompanyFk("supplier_invoices", "supplier_id", "suppliers", transaction);
    await sameCompanyFk("supplier_invoices", "receipt_id", "goods_receipts", transaction);

    await queryInterface.createTable(
      "supplier_payments",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        supplier_id: { type: DataTypes.UUID, allowNull: false },
        invoice_id: { type: DataTypes.UUID, allowNull: false },
        amount: money(),
        method: {
          type: DataTypes.ENUM("cash", "bank_transfer", "mobile_money", "check", "other"),
          allowNull: false,
        },
        paid_at: { type: DataTypes.DATEONLY, allowNull: false },
        reference: { type: DataTypes.STRING(60), allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        created_by: userForeignKey(false),
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    await sql("ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_amount_check CHECK (amount > 0);", transaction);
    await sameCompanyFk("supplier_payments", "supplier_id", "suppliers", transaction);
    await sameCompanyFk("supplier_payments", "invoice_id", "supplier_invoices", transaction);

    // --- Idempotence
    await queryInterface.createTable(
      "idempotency_keys",
      {
        company_id: { ...companyForeignKey, primaryKey: true },
        key: { type: DataTypes.STRING(100), allowNull: false, primaryKey: true },
        user_id: userForeignKey(false),
        // Empreinte de la requête : la même clé avec un autre contenu est refusée
        request_hash: { type: DataTypes.STRING(64), allowNull: false },
        status: { type: DataTypes.ENUM("processing", "completed"), allowNull: false },
        response_status: { type: DataTypes.INTEGER, allowNull: true },
        response_body: { type: DataTypes.JSONB, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await sql("CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);", transaction);
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    for (const table of [
      "idempotency_keys",
      "supplier_payments",
      "supplier_invoices",
      "supplier_return_lines",
      "supplier_returns",
      "goods_receipt_lines",
      "goods_receipts",
      "purchase_order_lines",
      "purchase_orders",
    ]) {
      await queryInterface.dropTable(table, { transaction });
    }
    await queryInterface.sequelize.query(
      `DROP TYPE IF EXISTS "enum_idempotency_keys_status";
       DROP TYPE IF EXISTS "enum_supplier_payments_method";
       DROP TYPE IF EXISTS "enum_supplier_invoices_status";
       DROP TYPE IF EXISTS "enum_supplier_returns_status";
       DROP TYPE IF EXISTS "enum_goods_receipts_status";
       DROP TYPE IF EXISTS "enum_purchase_orders_status";`,
      { transaction },
    );
  });
};
