import { QueryTypes } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Decimal, roundMoney } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { addDays, companyTimezone, localDate, localDayRange } from "../company/company-time.js";
import { visibleShopIds } from "../stock/stock-access.js";
import { listStockAlerts } from "../stock/stock-queries.service.js";
import type { PeriodQuery, SalesReportQuery, StockValueQuery, TopProductsQuery } from "./reports.schemas.js";

/**
 * Rapports (réservés à reports.view). Conventions :
 * - chiffre d'affaires = ventes validées (encaissées ou à crédit), hors ventes annulées ;
 * - un retour diminue le chiffre d'affaires du jour où il est fait, au montant remboursé ;
 * - coût des ventes = coût figé sur chaque ligne (CMP au moment de la vente) ; un article
 *   retourné et remis en stock en sort, un article retourné non revendable reste une perte ;
 * - marge brute = chiffre d'affaires net − coût des ventes ; résultat = marge − dépenses.
 * Les montants restent des chaînes décimales ; les jours sont ceux du fuseau de l'entreprise.
 */

type Replacements = Record<string, unknown>;

interface Scope {
  replacements: Replacements;
  currency: string;
  timezone: string;
  /** Fragment SQL " AND <colonne> IN (...)" à ajouter au WHERE (vide = toutes les boutiques). */
  shop: (column: string) => string;
}

async function reportScope(access: CompanyAccess, shopId?: string): Promise<Scope> {
  const [shopIds, timezone] = await Promise.all([visibleShopIds(access, shopId), companyTimezone(access.companyId)]);
  return {
    replacements: { companyId: access.companyId, timezone, shopIds },
    currency: access.currency,
    timezone,
    shop: (column) => (shopIds === null ? "" : shopIds.length === 0 ? " AND false" : ` AND ${column} IN (:shopIds)`),
  };
}

const money = (value: Decimal.Value | null, currency: string) => roundMoney(value ?? 0, currency);

/** Taux de marge en % du chiffre d'affaires net (null si aucun chiffre d'affaires). */
function marginRate(margin: Decimal.Value, revenue: Decimal.Value): string | null {
  const base = new Decimal(revenue);
  return base.isZero() ? null : new Decimal(margin).dividedBy(base).times(100).toFixed(1);
}

// --- Ventes par période
export interface SalesFigures {
  salesCount: number;
  grossSales: string;
  discounts: string;
  revenue: string;
  refunds: string;
  netRevenue: string;
  cost: string;
  grossMargin: string;
  marginRate: string | null;
  averageBasket: string;
}

interface SalesRow {
  period: string;
  sales_count: string;
  gross: string;
  discounts: string;
  revenue: string;
  cost: string;
  refunds: string;
  cost_back: string;
}

function figures(rows: Omit<SalesRow, "period">[], currency: string): SalesFigures {
  const sum = (key: keyof Omit<SalesRow, "period">) => rows.reduce((total, row) => total.plus(row[key]), new Decimal(0));
  const salesCount = rows.reduce((total, row) => total + Number(row.sales_count), 0);
  const revenue = sum("revenue");
  const netRevenue = revenue.minus(sum("refunds"));
  const cost = sum("cost").minus(sum("cost_back"));
  const margin = netRevenue.minus(cost);
  return {
    salesCount,
    grossSales: money(sum("gross"), currency),
    discounts: money(sum("discounts"), currency),
    revenue: money(revenue, currency),
    refunds: money(sum("refunds"), currency),
    netRevenue: money(netRevenue, currency),
    cost: money(cost, currency),
    grossMargin: money(margin, currency),
    marginRate: marginRate(margin, netRevenue),
    averageBasket: salesCount === 0 ? money(0, currency) : money(revenue.dividedBy(salesCount), currency),
  };
}

async function salesRows(scope: Scope, from: string, to: string, unit: "day" | "week" | "month") {
  const replacements = { ...scope.replacements, from, to, unit };
  return sequelize.query<SalesRow>(
    `WITH periods AS (
       SELECT generate_series(
                date_trunc(:unit, CAST(:from AS date)::timestamp),
                CAST(:to AS date)::timestamp,
                CAST('1 ' || :unit AS interval))::date AS period
     ),
     sold AS (
       SELECT date_trunc(:unit, s.created_at AT TIME ZONE :timezone)::date AS period,
              count(*) AS sales_count, sum(s.subtotal) AS gross, sum(s.discount_total) AS discounts,
              sum(s.total) AS revenue, sum(c.cost) AS cost
       FROM sales s
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(l.quantity * l.unit_cost), 0) AS cost FROM sale_lines l WHERE l.sale_id = s.id
       ) c
       WHERE s.company_id = :companyId AND s.status = 'completed'
         AND ${localDayRange("s.created_at")}${scope.shop("s.shop_id")}
       GROUP BY 1
     ),
     returned AS (
       SELECT date_trunc(:unit, r.created_at AT TIME ZONE :timezone)::date AS period,
              sum(rl.refund_amount) AS refunds,
              sum(CASE WHEN rl.restock THEN rl.quantity * sl.unit_cost ELSE 0 END) AS cost_back
       FROM sale_return_lines rl
       JOIN sale_returns r ON r.id = rl.return_id
       JOIN sale_lines sl ON sl.id = rl.sale_line_id
       WHERE r.company_id = :companyId AND ${localDayRange("r.created_at")}${scope.shop("r.shop_id")}
       GROUP BY 1
     )
     SELECT to_char(p.period, 'YYYY-MM-DD') AS period,
            COALESCE(sold.sales_count, 0) AS sales_count, COALESCE(sold.gross, 0) AS gross,
            COALESCE(sold.discounts, 0) AS discounts, COALESCE(sold.revenue, 0) AS revenue,
            COALESCE(sold.cost, 0) AS cost, COALESCE(returned.refunds, 0) AS refunds,
            COALESCE(returned.cost_back, 0) AS cost_back
     FROM periods p
     LEFT JOIN sold USING (period)
     LEFT JOIN returned USING (period)
     ORDER BY p.period`,
    { replacements, type: QueryTypes.SELECT },
  );
}

export async function salesReport(access: CompanyAccess, query: Omit<SalesReportQuery, "format">) {
  const scope = await reportScope(access, query.shopId);
  const rows = await salesRows(scope, query.from, query.to, query.groupBy);
  return {
    from: query.from,
    to: query.to,
    groupBy: query.groupBy,
    currency: scope.currency,
    timezone: scope.timezone,
    rows: rows.map((row) => ({ period: row.period, ...figures([row], scope.currency) })),
    totals: figures(rows, scope.currency),
  };
}

// --- Meilleurs produits
export async function topProducts(access: CompanyAccess, query: Omit<TopProductsQuery, "format">) {
  const scope = await reportScope(access, query.shopId);
  const orderBy = { revenue: "revenue", quantity: "quantity", margin: "margin" }[query.sortBy];
  // Ici les retours sont rattachés à la vente d'origine : on mesure ce que chaque produit a vraiment rapporté
  const rows = await sequelize.query<{
    product_id: string;
    sku: string;
    name: string;
    unit: string;
    quantity: string;
    revenue: string;
    cost: string;
    margin: string;
    sales_count: string;
  }>(
    `SELECT p.id AS product_id, p.sku, p.name, u.symbol AS unit,
            sum(l.quantity - l.returned_quantity) AS quantity,
            sum(l.line_total - rf.refund) AS revenue,
            sum(l.quantity * l.unit_cost - rf.restocked * l.unit_cost) AS cost,
            sum(l.line_total - rf.refund) - sum(l.quantity * l.unit_cost - rf.restocked * l.unit_cost) AS margin,
            count(DISTINCT s.id) AS sales_count
     FROM sale_lines l
     JOIN sales s ON s.id = l.sale_id AND s.status = 'completed'
     JOIN products p ON p.id = l.product_id
     JOIN units u ON u.id = p.unit_id
     CROSS JOIN LATERAL (
       SELECT COALESCE(sum(rl.refund_amount), 0) AS refund,
              COALESCE(sum(CASE WHEN rl.restock THEN rl.quantity ELSE 0 END), 0) AS restocked
       FROM sale_return_lines rl WHERE rl.sale_line_id = l.id
     ) rf
     WHERE s.company_id = :companyId AND ${localDayRange("s.created_at")}${scope.shop("s.shop_id")}
     GROUP BY p.id, p.sku, p.name, u.symbol
     ORDER BY ${orderBy} DESC, p.name
     LIMIT :limit`,
    { replacements: { ...scope.replacements, from: query.from, to: query.to, limit: query.limit }, type: QueryTypes.SELECT },
  );
  return {
    from: query.from,
    to: query.to,
    sortBy: query.sortBy,
    currency: scope.currency,
    items: rows.map((row) => ({
      productId: row.product_id,
      sku: row.sku,
      name: row.name,
      unit: row.unit,
      quantity: new Decimal(row.quantity).toFixed(3),
      salesCount: Number(row.sales_count),
      revenue: money(row.revenue, scope.currency),
      cost: money(row.cost, scope.currency),
      grossMargin: money(row.margin, scope.currency),
      marginRate: marginRate(row.margin, row.revenue),
    })),
  };
}

// --- Valeur du stock
export async function stockValue(access: CompanyAccess, query: Omit<StockValueQuery, "format">) {
  const scope = await reportScope(access, query.shopId);
  const rows = await sequelize.query<{
    shop_id: string;
    shop_name: string;
    product_id: string;
    sku: string;
    name: string;
    unit: string;
    quantity: string;
    average_cost: string;
    value: string;
    retail_value: string;
  }>(
    `SELECT sh.id AS shop_id, sh.name AS shop_name, p.id AS product_id, p.sku, p.name, u.symbol AS unit,
            sl.quantity, sl.average_cost, sl.quantity * sl.average_cost AS value, sl.quantity * p.sale_price AS retail_value
     FROM stock_levels sl
     JOIN shops sh ON sh.id = sl.shop_id
     JOIN products p ON p.id = sl.product_id
     JOIN units u ON u.id = p.unit_id
     WHERE sl.company_id = :companyId AND sl.quantity <> 0${scope.shop("sl.shop_id")}
     ORDER BY sh.name, p.name`,
    { replacements: scope.replacements, type: QueryTypes.SELECT },
  );

  const byShop = new Map<string, { shopId: string; name: string; value: Decimal; retailValue: Decimal; products: number }>();
  for (const row of rows) {
    const shop = byShop.get(row.shop_id) ?? { shopId: row.shop_id, name: row.shop_name, value: new Decimal(0), retailValue: new Decimal(0), products: 0 };
    shop.value = shop.value.plus(row.value);
    shop.retailValue = shop.retailValue.plus(row.retail_value);
    shop.products += 1;
    byShop.set(row.shop_id, shop);
  }
  const value = rows.reduce((total, row) => total.plus(row.value), new Decimal(0));
  const retailValue = rows.reduce((total, row) => total.plus(row.retail_value), new Decimal(0));

  return {
    date: localDate(scope.timezone),
    currency: scope.currency,
    // Valeur au coût (CMP) et au prix de vente actuel : l'écart est la marge potentielle
    totals: {
      value: money(value, scope.currency),
      retailValue: money(retailValue, scope.currency),
      potentialMargin: money(retailValue.minus(value), scope.currency),
    },
    shops: [...byShop.values()].map((shop) => ({
      shopId: shop.shopId,
      name: shop.name,
      products: shop.products,
      value: money(shop.value, scope.currency),
      retailValue: money(shop.retailValue, scope.currency),
    })),
    items: rows.map((row) => ({
      shopId: row.shop_id,
      shopName: row.shop_name,
      productId: row.product_id,
      sku: row.sku,
      name: row.name,
      unit: row.unit,
      quantity: new Decimal(row.quantity).toFixed(3),
      averageCost: new Decimal(row.average_cost).toFixed(4),
      value: money(row.value, scope.currency),
      retailValue: money(row.retail_value, scope.currency),
    })),
  };
}

// --- Dépenses par catégorie
async function expenseRows(scope: Scope, from: string, to: string) {
  return sequelize.query<{ category_id: string; name: string; count: string; amount: string }>(
    `SELECT c.id AS category_id, c.name, count(e.id) AS count, sum(e.amount) AS amount
     FROM expenses e JOIN expense_categories c ON c.id = e.category_id
     WHERE e.company_id = :companyId AND e.status = 'recorded'
       AND e.spent_at BETWEEN CAST(:from AS date) AND CAST(:to AS date)${scope.shop("e.shop_id")}
     GROUP BY c.id, c.name
     ORDER BY sum(e.amount) DESC, c.name`,
    { replacements: { ...scope.replacements, from, to }, type: QueryTypes.SELECT },
  );
}

function expenseSummary(rows: Awaited<ReturnType<typeof expenseRows>>, currency: string) {
  return {
    total: money(rows.reduce((total, row) => total.plus(row.amount), new Decimal(0)), currency),
    byCategory: rows.map((row) => ({
      categoryId: row.category_id,
      name: row.name,
      count: Number(row.count),
      amount: money(row.amount, currency),
    })),
  };
}

export async function expensesReport(access: CompanyAccess, query: Omit<PeriodQuery, "format">) {
  const scope = await reportScope(access, query.shopId);
  const rows = await expenseRows(scope, query.from, query.to);
  return { from: query.from, to: query.to, currency: scope.currency, ...expenseSummary(rows, scope.currency) };
}

// --- Compte de résultat simplifié
export async function profitAndLoss(access: CompanyAccess, query: Omit<PeriodQuery, "format">) {
  const scope = await reportScope(access, query.shopId);
  const [sales, expenses] = await Promise.all([
    salesRows(scope, query.from, query.to, "month"),
    expenseRows(scope, query.from, query.to),
  ]);
  const totals = figures(sales, scope.currency);
  const expenseTotals = expenseSummary(expenses, scope.currency);
  return {
    from: query.from,
    to: query.to,
    currency: scope.currency,
    sales: totals,
    expenses: expenseTotals,
    netResult: money(new Decimal(totals.grossMargin).minus(expenseTotals.total), scope.currency),
  };
}

// --- Tableau de bord
export async function dashboard(access: CompanyAccess, shopId?: string) {
  const scope = await reportScope(access, shopId);
  const today = localDate(scope.timezone);
  const yesterday = addDays(today, -1);
  const monthStart = `${today.slice(0, 8)}01`;
  const weekStart = addDays(today, -6);

  const [lastDays, month, monthExpenses, top, [stock], alerts, [debt], [sessions]] = await Promise.all([
    salesRows(scope, addDays(today, -7), today, "day"),
    salesRows(scope, monthStart, today, "month"),
    expenseRows(scope, monthStart, today),
    topProducts(access, { from: monthStart, to: today, shopId, sortBy: "revenue", limit: 5 }),
    sequelize.query<{ value: string }>(
      `SELECT COALESCE(sum(sl.quantity * sl.average_cost), 0) AS value
       FROM stock_levels sl
       WHERE sl.company_id = :companyId${scope.shop("sl.shop_id")}`,
      { replacements: scope.replacements, type: QueryTypes.SELECT },
    ),
    // Même règle que la liste des alertes : chaque produit d'une boutique compte une seule fois
    listStockAlerts(access, shopId),
    // Les clients ne sont pas rattachés à une boutique : encours de toute l'entreprise
    sequelize.query<{ count: string; amount: string }>(
      `SELECT count(*) AS count, COALESCE(sum(balance), 0) AS amount FROM customers
       WHERE company_id = :companyId AND balance > 0`,
      { replacements: scope.replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query<{ count: string }>(
      `SELECT count(*) AS count FROM cash_sessions cs
       WHERE cs.company_id = :companyId AND cs.status = 'open'${scope.shop("cs.shop_id")}`,
      { replacements: scope.replacements, type: QueryTypes.SELECT },
    ),
  ]);

  const day = (date: string) => figures(lastDays.filter((row) => row.period === date), scope.currency);
  const monthFigures = figures(month, scope.currency);
  const monthExpenseTotal = expenseSummary(monthExpenses, scope.currency).total;

  return {
    date: today,
    currency: scope.currency,
    timezone: scope.timezone,
    today: day(today),
    yesterday: day(yesterday),
    month: {
      from: monthStart,
      ...monthFigures,
      expenses: monthExpenseTotal,
      netResult: money(new Decimal(monthFigures.grossMargin).minus(monthExpenseTotal), scope.currency),
    },
    // 7 derniers jours (aujourd'hui compris) pour le graphique
    last7Days: lastDays
      .filter((row) => row.period >= weekStart)
      .map((row) => ({ date: row.period, salesCount: Number(row.sales_count), netRevenue: figures([row], scope.currency).netRevenue })),
    topProducts: top.items,
    stock: {
      value: money(stock!.value, scope.currency),
      lowStockCount: alerts.filter((alert) => alert.status === "low_stock").length,
      outOfStockCount: alerts.filter((alert) => alert.status === "out_of_stock").length,
    },
    customers: { debtorsCount: Number(debt!.count), totalDebt: money(debt!.amount, scope.currency) },
    openCashSessions: Number(sessions!.count),
  };
}
