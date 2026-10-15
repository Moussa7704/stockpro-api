import { DataTypes, type Transaction } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * Stock (cahier des charges §5.4, RB-02, RB-04, RB-09) :
 * - stock_levels : solde par boutique × produit, jamais négatif (CHECK), coût moyen pondéré
 * - stock_movements : journal en AJOUT SEUL (trigger qui interdit UPDATE et DELETE)
 * - stock_adjustments, stock_transfers (+ lignes), inventory_counts (+ lignes)
 * - document_sequences : numérotation sans trou par entreprise × boutique × type × année
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

const quantity = (allowNull = false) => ({ type: DataTypes.DECIMAL(14, 3), allowNull });
const unitCost = (allowNull = true) => ({ type: DataTypes.DECIMAL(14, 4), allowNull });

export const up: Migration = async ({ context: queryInterface }) => {
  const sql = (query: string, transaction: Transaction) => queryInterface.sequelize.query(query, { transaction });

  // Clé étrangère (company_id, colonne) → table(company_id, id) : jamais deux entreprises mélangées
  const sameCompanyFk = (table: string, column: string, target: string, transaction: Transaction) =>
    sql(
      `ALTER TABLE ${table} ADD CONSTRAINT ${table}_${column}_same_company_fkey
         FOREIGN KEY (company_id, ${column}) REFERENCES ${target} (company_id, id)
         ON UPDATE CASCADE ON DELETE RESTRICT;`,
      transaction,
    );

  await queryInterface.sequelize.transaction(async (transaction) => {
    // --- document_sequences
    await queryInterface.createTable(
      "document_sequences",
      {
        company_id: { ...companyForeignKey, primaryKey: true },
        shop_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        doc_type: { type: DataTypes.STRING(10), allowNull: false, primaryKey: true },
        year: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
        last_number: { type: DataTypes.INTEGER, allowNull: false },
      },
      { transaction },
    );
    await sameCompanyFk("document_sequences", "shop_id", "shops", transaction);

    // --- stock_levels
    await queryInterface.createTable(
      "stock_levels",
      {
        shop_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        product_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        company_id: companyForeignKey,
        quantity: { ...quantity(), defaultValue: 0 },
        average_cost: { ...unitCost(false), defaultValue: 0 },
        ...timestamps,
      },
      { transaction },
    );
    await sameCompanyFk("stock_levels", "shop_id", "shops", transaction);
    await sameCompanyFk("stock_levels", "product_id", "products", transaction);
    await sql(
      `ALTER TABLE stock_levels ADD CONSTRAINT stock_levels_quantity_not_negative CHECK (quantity >= 0);
       ALTER TABLE stock_levels ADD CONSTRAINT stock_levels_average_cost_not_negative CHECK (average_cost >= 0);
       CREATE INDEX stock_levels_company_product_idx ON stock_levels (company_id, product_id);`,
      transaction,
    );

    // --- stock_adjustments (pièce justificative des ajustements manuels)
    await queryInterface.createTable(
      "stock_adjustments",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        shop_id: { type: DataTypes.UUID, allowNull: false },
        number: { type: DataTypes.STRING(40), allowNull: false },
        reason: {
          type: DataTypes.ENUM(
            "opening_balance",
            "correction",
            "loss",
            "damage",
            "theft",
            "expired",
            "gift",
            "other",
          ),
          allowNull: false,
        },
        notes: { type: DataTypes.TEXT, allowNull: true },
        created_by: userForeignKey(false),
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE stock_adjustments ADD CONSTRAINT stock_adjustments_company_id_id_key UNIQUE (company_id, id);
       ALTER TABLE stock_adjustments ADD CONSTRAINT stock_adjustments_company_number_key UNIQUE (company_id, number);`,
      transaction,
    );
    await sameCompanyFk("stock_adjustments", "shop_id", "shops", transaction);

    // --- stock_transfers + lignes
    await queryInterface.createTable(
      "stock_transfers",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        number: { type: DataTypes.STRING(40), allowNull: false },
        from_shop_id: { type: DataTypes.UUID, allowNull: false },
        to_shop_id: { type: DataTypes.UUID, allowNull: false },
        status: {
          type: DataTypes.ENUM("draft", "shipped", "received", "cancelled"),
          allowNull: false,
          defaultValue: "draft",
        },
        notes: { type: DataTypes.TEXT, allowNull: true },
        created_by: userForeignKey(false),
        shipped_at: { type: DataTypes.DATE, allowNull: true },
        shipped_by: userForeignKey(true),
        received_at: { type: DataTypes.DATE, allowNull: true },
        received_by: userForeignKey(true),
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_company_id_id_key UNIQUE (company_id, id);
       ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_company_number_key UNIQUE (company_id, number);
       ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_distinct_shops CHECK (from_shop_id <> to_shop_id);
       CREATE INDEX stock_transfers_company_status_idx ON stock_transfers (company_id, status);`,
      transaction,
    );
    await sameCompanyFk("stock_transfers", "from_shop_id", "shops", transaction);
    await sameCompanyFk("stock_transfers", "to_shop_id", "shops", transaction);

    await queryInterface.createTable(
      "stock_transfer_lines",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        transfer_id: { type: DataTypes.UUID, allowNull: false },
        product_id: { type: DataTypes.UUID, allowNull: false },
        quantity_sent: quantity(),
        // Renseignée à la réception : un écart avec quantity_sent est une perte en transit
        quantity_received: quantity(true),
        // Coût moyen de la boutique source au moment de l'expédition
        unit_cost: unitCost(),
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE stock_transfer_lines ADD CONSTRAINT stock_transfer_lines_quantities_check
         CHECK (quantity_sent > 0 AND (quantity_received IS NULL OR quantity_received >= 0));
       ALTER TABLE stock_transfer_lines ADD CONSTRAINT stock_transfer_lines_transfer_product_key
         UNIQUE (transfer_id, product_id);`,
      transaction,
    );
    await sameCompanyFk("stock_transfer_lines", "transfer_id", "stock_transfers", transaction);
    await sameCompanyFk("stock_transfer_lines", "product_id", "products", transaction);

    // --- inventory_counts + lignes
    await queryInterface.createTable(
      "inventory_counts",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        shop_id: { type: DataTypes.UUID, allowNull: false },
        number: { type: DataTypes.STRING(40), allowNull: false },
        status: {
          type: DataTypes.ENUM("draft", "validated", "cancelled"),
          allowNull: false,
          defaultValue: "draft",
        },
        notes: { type: DataTypes.TEXT, allowNull: true },
        created_by: userForeignKey(false),
        validated_at: { type: DataTypes.DATE, allowNull: true },
        validated_by: userForeignKey(true),
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE inventory_counts ADD CONSTRAINT inventory_counts_company_id_id_key UNIQUE (company_id, id);
       ALTER TABLE inventory_counts ADD CONSTRAINT inventory_counts_company_number_key UNIQUE (company_id, number);`,
      transaction,
    );
    await sameCompanyFk("inventory_counts", "shop_id", "shops", transaction);

    await queryInterface.createTable(
      "inventory_count_lines",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        inventory_id: { type: DataTypes.UUID, allowNull: false },
        product_id: { type: DataTypes.UUID, allowNull: false },
        counted_quantity: quantity(),
        // Quantité théorique figée AU MOMENT DE LA VALIDATION (les ventes du jour sont prises en compte)
        expected_quantity: quantity(true),
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE inventory_count_lines ADD CONSTRAINT inventory_count_lines_counted_not_negative
         CHECK (counted_quantity >= 0);
       ALTER TABLE inventory_count_lines ADD CONSTRAINT inventory_count_lines_inventory_product_key
         UNIQUE (inventory_id, product_id);`,
      transaction,
    );
    await sameCompanyFk("inventory_count_lines", "inventory_id", "inventory_counts", transaction);
    await sameCompanyFk("inventory_count_lines", "product_id", "products", transaction);

    // --- stock_movements : journal en ajout seul
    await queryInterface.createTable(
      "stock_movements",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        shop_id: { type: DataTypes.UUID, allowNull: false },
        product_id: { type: DataTypes.UUID, allowNull: false },
        type: {
          type: DataTypes.ENUM(
            "adjustment",
            "inventory_adjustment",
            "transfer_out",
            "transfer_in",
            "purchase_receipt",
            "supplier_return",
            "sale",
            "customer_return",
            "sale_cancellation",
          ),
          allowNull: false,
        },
        // Signée : positive = entrée, négative = sortie
        quantity: quantity(),
        unit_cost: unitCost(false),
        balance_after: quantity(),
        // Document à l'origine du mouvement (ajustement, transfert, vente…)
        source_type: { type: DataTypes.STRING(40), allowNull: false },
        source_id: { type: DataTypes.UUID, allowNull: false },
        created_by: userForeignKey(true),
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    await sameCompanyFk("stock_movements", "shop_id", "shops", transaction);
    await sameCompanyFk("stock_movements", "product_id", "products", transaction);
    await sql(
      `ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_quantity_not_zero CHECK (quantity <> 0);
       ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_balance_not_negative CHECK (balance_after >= 0);
       CREATE INDEX stock_movements_shop_product_idx ON stock_movements (shop_id, product_id, created_at);
       CREATE INDEX stock_movements_company_created_idx ON stock_movements (company_id, created_at);
       CREATE INDEX stock_movements_source_idx ON stock_movements (source_type, source_id);

       -- RB-04 : on ne corrige jamais un mouvement, on en ajoute un autre (compensatoire)
       CREATE FUNCTION stock_movements_append_only() RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'stock_movements est un journal en ajout seul : modification et suppression interdites';
       END;
       $$ LANGUAGE plpgsql;
       CREATE TRIGGER stock_movements_no_update_or_delete
         BEFORE UPDATE OR DELETE ON stock_movements
         FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();`,
      transaction,
    );
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    for (const table of [
      "stock_movements",
      "inventory_count_lines",
      "inventory_counts",
      "stock_transfer_lines",
      "stock_transfers",
      "stock_adjustments",
      "stock_levels",
      "document_sequences",
    ]) {
      await queryInterface.dropTable(table, { transaction });
    }
    await queryInterface.sequelize.query(
      `DROP FUNCTION IF EXISTS stock_movements_append_only();
       DROP TYPE IF EXISTS "enum_stock_movements_type";
       DROP TYPE IF EXISTS "enum_inventory_counts_status";
       DROP TYPE IF EXISTS "enum_stock_transfers_status";
       DROP TYPE IF EXISTS "enum_stock_adjustments_reason";`,
      { transaction },
    );
  });
};
