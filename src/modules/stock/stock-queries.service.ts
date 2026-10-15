import { Op, QueryTypes, type WhereOptions } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Product, Shop, StockMovement } from "../../models/index.js";
import type { CompanyAccess } from "../access/access.service.js";
import { likePattern } from "../catalog/catalog.helpers.js";
import { canSeeCosts, visibleShopIds } from "./stock-access.js";
import type { ListMovementsQuery, ListStockQuery } from "./stock.schemas.js";

interface StockRow {
  shop_id: string;
  shop_code: string;
  shop_name: string;
  product_id: string;
  sku: string;
  name: string;
  barcode: string | null;
  unit_symbol: string;
  quantity: string;
  alert_threshold: string;
  low_stock: boolean;
  average_cost: string;
  stock_value: string;
}

function toStockDto(row: StockRow, withCosts: boolean) {
  return {
    shop: { id: row.shop_id, code: row.shop_code, name: row.shop_name },
    product: { id: row.product_id, sku: row.sku, name: row.name, barcode: row.barcode, unit: row.unit_symbol },
    quantity: row.quantity,
    alertThreshold: row.alert_threshold,
    lowStock: row.low_stock,
    ...(withCosts && { averageCost: row.average_cost, stockValue: row.stock_value }),
  };
}

/** Niveaux de stock des boutiques visibles (produits actifs), avec recherche et filtre "stock bas". */
export async function listStockLevels(access: CompanyAccess, query: ListStockQuery) {
  const shopIds = await visibleShopIds(access, query.shopId);
  if (shopIds && shopIds.length === 0) {
    return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }

  const conditions = ["sl.company_id = :companyId", "p.status = 'active'"];
  if (shopIds) conditions.push("sl.shop_id IN (:shopIds)");
  if (query.search) conditions.push("(p.name ILIKE :search OR p.sku ILIKE :search OR p.barcode ILIKE :search)");
  if (query.lowStock) conditions.push("p.alert_threshold > 0 AND sl.quantity <= p.alert_threshold");

  const from = `FROM stock_levels sl
    JOIN products p ON p.company_id = sl.company_id AND p.id = sl.product_id
    JOIN shops s ON s.id = sl.shop_id
    JOIN units u ON u.id = p.unit_id
    WHERE ${conditions.join(" AND ")}`;
  const replacements = {
    companyId: access.companyId,
    shopIds,
    search: query.search ? likePattern(query.search) : null,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };

  const rows = await sequelize.query<StockRow>(
    `SELECT sl.shop_id, s.code AS shop_code, s.name AS shop_name, sl.product_id, p.sku, p.name, p.barcode,
            u.symbol AS unit_symbol, sl.quantity, p.alert_threshold, sl.average_cost,
            (p.alert_threshold > 0 AND sl.quantity <= p.alert_threshold) AS low_stock,
            ROUND(sl.quantity * sl.average_cost, 2) AS stock_value
     ${from}
     ORDER BY p.name, s.code
     LIMIT :limit OFFSET :offset`,
    { replacements, type: QueryTypes.SELECT },
  );
  const [count] = await sequelize.query<{ total: string }>(`SELECT count(*) AS total ${from}`, {
    replacements,
    type: QueryTypes.SELECT,
  });

  const withCosts = canSeeCosts(access);
  return {
    items: rows.map((row) => toStockDto(row, withCosts)),
    total: Number(count!.total),
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * Alertes : produits actifs avec un seuil, dont le stock est sous le seuil dans une boutique
 * visible — y compris les produits jamais reçus dans cette boutique (stock 0).
 */
export async function listStockAlerts(access: CompanyAccess, shopId?: string) {
  const shopIds = await visibleShopIds(access, shopId);
  if (shopIds && shopIds.length === 0) {
    return [];
  }

  const rows = await sequelize.query<{
    shop_id: string;
    shop_code: string;
    product_id: string;
    sku: string;
    name: string;
    quantity: string;
    alert_threshold: string;
  }>(
    `SELECT s.id AS shop_id, s.code AS shop_code, p.id AS product_id, p.sku, p.name,
            COALESCE(sl.quantity, 0) AS quantity, p.alert_threshold
     FROM products p
     JOIN shops s ON s.company_id = p.company_id AND s.archived_at IS NULL
     LEFT JOIN stock_levels sl ON sl.shop_id = s.id AND sl.product_id = p.id
     WHERE p.company_id = :companyId AND p.status = 'active' AND p.alert_threshold > 0
       AND COALESCE(sl.quantity, 0) <= p.alert_threshold
       ${shopIds ? "AND s.id IN (:shopIds)" : ""}
     ORDER BY s.code, p.name`,
    { replacements: { companyId: access.companyId, shopIds }, type: QueryTypes.SELECT },
  );

  return rows.map((row) => ({
    shop: { id: row.shop_id, code: row.shop_code },
    product: { id: row.product_id, sku: row.sku, name: row.name },
    quantity: row.quantity,
    alertThreshold: row.alert_threshold,
  }));
}

/** Journal des mouvements des boutiques visibles, du plus récent au plus ancien. */
export async function listMovements(access: CompanyAccess, query: ListMovementsQuery) {
  const shopIds = await visibleShopIds(access, query.shopId);
  if (shopIds && shopIds.length === 0) {
    return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }

  const where: WhereOptions<StockMovement> = {
    companyId: access.companyId,
    ...(shopIds && { shopId: { [Op.in]: shopIds } }),
    ...(query.productId && { productId: query.productId }),
    ...(query.type && { type: query.type }),
    ...((query.from || query.to) && {
      createdAt: {
        ...(query.from && { [Op.gte]: query.from }),
        ...(query.to && { [Op.lte]: query.to }),
      },
    }),
  };

  const { rows, count } = await StockMovement.findAndCountAll({
    where,
    include: [{ model: Product, as: "product", attributes: ["id", "sku", "name"] }],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  const withCosts = canSeeCosts(access);
  return {
    items: rows.map((movement) => {
      const { unitCost, ...rest } = movement.toJSON();
      return withCosts ? { ...rest, unitCost } : rest;
    }),
    total: count,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** Stock d'un produit dans chaque boutique visible (0 si jamais reçu). */
export async function productStock(access: CompanyAccess, productId: string) {
  const shopIds = await visibleShopIds(access);
  const shops = await Shop.findAll({
    where: {
      companyId: access.companyId,
      archivedAt: null,
      ...(shopIds && { id: { [Op.in]: shopIds } }),
    },
    order: [["code", "ASC"]],
  });
  const levels = await sequelize.query<{ shop_id: string; quantity: string; average_cost: string }>(
    `SELECT shop_id, quantity, average_cost FROM stock_levels WHERE company_id = :companyId AND product_id = :productId`,
    { replacements: { companyId: access.companyId, productId }, type: QueryTypes.SELECT },
  );
  const byShop = new Map(levels.map((level) => [level.shop_id, level]));
  const withCosts = canSeeCosts(access);

  return shops.map((shop) => ({
    shop: { id: shop.id, code: shop.code, name: shop.name },
    quantity: byShop.get(shop.id)?.quantity ?? "0.000",
    ...(withCosts && { averageCost: byShop.get(shop.id)?.average_cost ?? "0.0000" }),
  }));
}
