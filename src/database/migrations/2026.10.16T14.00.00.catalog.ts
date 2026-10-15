import { DataTypes, type Transaction } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * Catalogue (cahier des charges §5.3) : unités, catégories, fournisseurs, produits.
 * Mêmes principes d'isolation que le socle : UNIQUE (company_id, id) + clés étrangères composites.
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

// Unités ajoutées aux entreprises déjà existantes. Copie figée : les nouvelles entreprises
// reçoivent celles de src/modules/catalog/units.service.ts (une migration ne change plus)
const DEFAULT_UNITS = [
  { name: "Pièce", symbol: "pce", allowsDecimal: false },
  { name: "Kilogramme", symbol: "kg", allowsDecimal: true },
  { name: "Litre", symbol: "L", allowsDecimal: true },
  { name: "Mètre", symbol: "m", allowsDecimal: true },
];

export const up: Migration = async ({ context: queryInterface }) => {
  const sql = (query: string, transaction: Transaction) =>
    queryInterface.sequelize.query(query, { transaction });

  await queryInterface.sequelize.transaction(async (transaction) => {
    // --- units
    await queryInterface.createTable(
      "units",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        name: { type: DataTypes.STRING(40), allowNull: false },
        symbol: { type: DataTypes.STRING(10), allowNull: false },
        // false : quantités entières uniquement (on ne vend pas 1,5 pièce)
        allows_decimal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        archived_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE units ADD CONSTRAINT units_company_id_id_key UNIQUE (company_id, id);
       CREATE UNIQUE INDEX units_company_name_key ON units (company_id, lower(name));`,
      transaction,
    );

    // --- categories (arborescence : parent_id facultatif, dans la même entreprise)
    await queryInterface.createTable(
      "categories",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        parent_id: { type: DataTypes.UUID, allowNull: true },
        name: { type: DataTypes.STRING(80), allowNull: false },
        archived_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE categories ADD CONSTRAINT categories_company_id_id_key UNIQUE (company_id, id);
       ALTER TABLE categories ADD CONSTRAINT categories_parent_same_company_fkey
         FOREIGN KEY (company_id, parent_id) REFERENCES categories (company_id, id)
         ON UPDATE CASCADE ON DELETE RESTRICT;
       ALTER TABLE categories ADD CONSTRAINT categories_not_own_parent CHECK (parent_id <> id);
       -- Nom unique au même niveau ; COALESCE car deux NULL ne sont jamais égaux pour UNIQUE
       CREATE UNIQUE INDEX categories_company_parent_name_key ON categories
         (company_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'), lower(name));`,
      transaction,
    );

    // --- suppliers
    await queryInterface.createTable(
      "suppliers",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        name: { type: DataTypes.STRING(150), allowNull: false },
        contact_name: { type: DataTypes.STRING(100), allowNull: true },
        phone: { type: DataTypes.STRING(30), allowNull: true },
        email: { type: DataTypes.STRING(255), allowNull: true },
        address: { type: DataTypes.STRING(255), allowNull: true },
        notes: { type: DataTypes.TEXT, allowNull: true },
        archived_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE suppliers ADD CONSTRAINT suppliers_company_id_id_key UNIQUE (company_id, id);
       CREATE UNIQUE INDEX suppliers_company_name_key ON suppliers (company_id, lower(name));`,
      transaction,
    );

    // --- products
    await queryInterface.createTable(
      "products",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        sku: { type: DataTypes.STRING(64), allowNull: false },
        barcode: { type: DataTypes.STRING(64), allowNull: true },
        name: { type: DataTypes.STRING(150), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        category_id: { type: DataTypes.UUID, allowNull: true },
        unit_id: { type: DataTypes.UUID, allowNull: false },
        // Montants en NUMERIC (décimal exact), jamais en flottant (RB-05)
        sale_price: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
        purchase_price_hint: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
        // Quantité : 3 décimales pour les produits vendus au poids ou au volume
        alert_threshold: { type: DataTypes.DECIMAL(14, 3), allowNull: false, defaultValue: 0 },
        status: {
          type: DataTypes.ENUM("active", "archived"),
          allowNull: false,
          defaultValue: "active",
        },
        ...timestamps,
      },
      { transaction },
    );
    await sql(
      `ALTER TABLE products ADD CONSTRAINT products_company_id_id_key UNIQUE (company_id, id);
       ALTER TABLE products ADD CONSTRAINT products_company_sku_key UNIQUE (company_id, sku);
       CREATE UNIQUE INDEX products_company_barcode_key ON products (company_id, barcode)
         WHERE barcode IS NOT NULL;
       CREATE INDEX products_company_name_idx ON products (company_id, lower(name));
       CREATE INDEX products_company_category_idx ON products (company_id, category_id);
       ALTER TABLE products ADD CONSTRAINT products_category_same_company_fkey
         FOREIGN KEY (company_id, category_id) REFERENCES categories (company_id, id)
         ON UPDATE CASCADE ON DELETE RESTRICT;
       ALTER TABLE products ADD CONSTRAINT products_unit_same_company_fkey
         FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id)
         ON UPDATE CASCADE ON DELETE RESTRICT;
       ALTER TABLE products ADD CONSTRAINT products_prices_positive
         CHECK (sale_price >= 0 AND (purchase_price_hint IS NULL OR purchase_price_hint >= 0));
       ALTER TABLE products ADD CONSTRAINT products_alert_threshold_positive CHECK (alert_threshold >= 0);`,
      transaction,
    );

    // Unités par défaut pour les entreprises qui existent déjà
    for (const unit of DEFAULT_UNITS) {
      await queryInterface.sequelize.query(
        `INSERT INTO units (id, company_id, name, symbol, allows_decimal, created_at, updated_at)
         SELECT gen_random_uuid(), id, :name, :symbol, :allowsDecimal, now(), now() FROM companies`,
        { replacements: unit, transaction },
      );
    }
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("products", { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_products_status";', { transaction });
    await queryInterface.dropTable("suppliers", { transaction });
    await queryInterface.dropTable("categories", { transaction });
    await queryInterface.dropTable("units", { transaction });
  });
};
