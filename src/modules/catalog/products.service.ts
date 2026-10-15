import { Op, type Transaction, type WhereOptions } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Category, Product, Unit } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { currencyDecimals, isWhole, sameDecimal, significantDecimals } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { pick, recordAudit, type AuditActor } from "../audit/audit.service.js";
import { findUsableCategory } from "./categories.service.js";
import { likePattern, rethrowAsConflict } from "./catalog.helpers.js";
import type { CreateProductInput, ListProductsQuery, UpdateProductInput } from "./catalog.schemas.js";

const AUDIT_FIELDS: (keyof Product)[] = [
  "sku",
  "barcode",
  "name",
  "categoryId",
  "unitId",
  "alertThreshold",
  "status",
];
const PRICE_FIELDS: (keyof Product)[] = ["salePrice", "purchasePriceHint"];

const CONFLICTS = {
  products_company_sku_key: "Ce SKU est déjà utilisé par un autre produit",
  products_company_barcode_key: "Ce code-barres est déjà utilisé par un autre produit",
};

const PRODUCT_INCLUDE = [
  { model: Unit, as: "unit", attributes: ["id", "name", "symbol", "allowsDecimal"] },
  { model: Category, as: "category", attributes: ["id", "name"] },
];

/** Montant compatible avec la devise : en FCFA, pas de décimales (D-01). */
function assertAmount(access: CompanyAccess, value: string | null | undefined, label: string): void {
  if (value && significantDecimals(value) > currencyDecimals(access.currency)) {
    throw AppError.badRequest(`${label} : pas de décimales en ${access.currency}`);
  }
}

/** Unité de l'entreprise, non archivée. */
async function findUsableUnit(companyId: string, id: string, transaction: Transaction): Promise<Unit> {
  const unit = await Unit.findOne({ where: { id, companyId }, transaction });
  if (!unit || unit.archivedAt) {
    throw AppError.badRequest("Unité inconnue ou archivée");
  }
  return unit;
}

/** Une quantité en pièces doit être entière ; au kg ou au litre, les décimales sont permises. */
function assertQuantityForUnit(unit: Unit, value: string | undefined, label: string): void {
  if (value !== undefined && !unit.allowsDecimal && !isWhole(value)) {
    throw AppError.badRequest(`${label} : quantité entière attendue pour l'unité « ${unit.name} »`);
  }
}

export async function listProducts(companyId: string, query: ListProductsQuery) {
  const search = query.search ? likePattern(query.search) : undefined;
  const where: WhereOptions<Product> = {
    companyId,
    ...(query.status !== "all" && { status: query.status }),
    ...(query.categoryId && { categoryId: query.categoryId }),
    ...(search && {
      [Op.or]: [
        { name: { [Op.iLike]: search } },
        { sku: { [Op.iLike]: search } },
        { barcode: { [Op.iLike]: search } },
      ],
    }),
  };

  const { rows, count } = await Product.findAndCountAll({
    where,
    include: PRODUCT_INCLUDE,
    // id en second critère : un ordre stable d'une page à l'autre
    order: [
      [query.sort, query.order.toUpperCase()],
      ["id", "ASC"],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}

/** Produit de l'entreprise ; 404 sinon (RB-01). */
export async function findProduct(companyId: string, id: string, transaction?: Transaction): Promise<Product> {
  const product = await Product.findOne({ where: { id, companyId }, include: PRODUCT_INCLUDE, transaction });
  if (!product) {
    throw AppError.notFound("Produit introuvable");
  }
  return product;
}

/** Recherche rapide (caisse) par code-barres ou SKU : produits actifs uniquement. */
export async function lookupProduct(companyId: string, by: { barcode?: string; sku?: string }) {
  const product = await Product.findOne({
    where: {
      companyId,
      status: "active",
      ...(by.barcode ? { barcode: by.barcode } : { sku: by.sku!.toUpperCase() }),
    },
    include: PRODUCT_INCLUDE,
  });
  if (!product) {
    throw AppError.notFound("Aucun produit actif pour ce code");
  }
  return product;
}

export async function createProduct(access: CompanyAccess, input: CreateProductInput, actor: AuditActor) {
  assertAmount(access, input.salePrice, "Prix de vente");
  assertAmount(access, input.purchasePriceHint, "Prix d'achat");

  try {
    const id = await sequelize.transaction(async (transaction) => {
      const unit = await findUsableUnit(access.companyId, input.unitId, transaction);
      assertQuantityForUnit(unit, input.alertThreshold, "Seuil d'alerte");
      if (input.categoryId) {
        await findUsableCategory(access.companyId, input.categoryId, transaction);
      }

      // companyId vient des droits (token vérifié), jamais du corps de la requête
      const product = await Product.create({ ...input, companyId: access.companyId }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: "product.create",
          entityType: "product",
          entityId: product.id,
          after: pick(product, [...AUDIT_FIELDS, ...PRICE_FIELDS]),
        },
        transaction,
      );
      return product.id;
    });
    return findProduct(access.companyId, id);
  } catch (error) {
    rethrowAsConflict(error, CONFLICTS, "Ce produit existe déjà");
  }
}

export async function updateProduct(
  access: CompanyAccess,
  id: string,
  input: UpdateProductInput,
  actor: AuditActor,
) {
  try {
    await sequelize.transaction(async (transaction) => {
      // Verrou : deux modifications simultanées ne s'écrasent pas sans laisser de trace
      const product = await Product.findOne({
        where: { id, companyId: access.companyId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!product) {
        throw AppError.notFound("Produit introuvable");
      }

      const changesPrice =
        (input.salePrice !== undefined && !sameDecimal(input.salePrice, product.salePrice)) ||
        (input.purchasePriceHint !== undefined && !sameDecimal(input.purchasePriceHint, product.purchasePriceHint));
      // Modifier un prix est une opération sensible, réservée à prices.manage (RB-03, RB-07)
      if (changesPrice && !access.permissions.has("prices.manage")) {
        throw AppError.forbidden("Modifier un prix nécessite la permission prices.manage");
      }
      assertAmount(access, input.salePrice, "Prix de vente");
      assertAmount(access, input.purchasePriceHint, "Prix d'achat");

      const unit = await findUsableUnit(access.companyId, input.unitId ?? product.unitId, transaction);
      assertQuantityForUnit(unit, input.alertThreshold ?? product.alertThreshold, "Seuil d'alerte");
      if (input.categoryId) {
        await findUsableCategory(access.companyId, input.categoryId, transaction);
      }

      const before = pick(product, AUDIT_FIELDS);
      const beforePrices = pick(product, PRICE_FIELDS);
      await product.update(input, { transaction });

      const audit = { ...actor, companyId: access.companyId, entityType: "product", entityId: product.id };
      if (changesPrice) {
        // Entrée dédiée : l'historique des prix se retrouve facilement dans le journal
        await recordAudit(
          { ...audit, action: "product.price_change", before: beforePrices, after: pick(product, PRICE_FIELDS) },
          transaction,
        );
      }
      const after = pick(product, AUDIT_FIELDS);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        const action =
          before.status !== after.status ? (after.status === "archived" ? "product.archive" : "product.restore") : "product.update";
        await recordAudit({ ...audit, action, before, after }, transaction);
      }
    });
    return findProduct(access.companyId, id);
  } catch (error) {
    rethrowAsConflict(error, CONFLICTS, "Ce produit existe déjà");
  }
}
