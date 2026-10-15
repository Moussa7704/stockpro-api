import { Shop } from "../../models/index.js";
import type { CompanyAccess } from "../access/access.service.js";
import type { ReportColumn, ReportTable } from "./exporters.js";
import type * as reports from "./reports.service.js";

/** Mise en tableau des rapports pour l'export Excel / PDF. */

const frenchDate = (day: string) => day.split("-").reverse().join("/");

export async function headerLines(access: CompanyAccess, shopId: string | undefined, period?: { from: string; to: string }) {
  const shop = shopId ? await Shop.findOne({ where: { id: shopId, companyId: access.companyId }, attributes: ["name"] }) : null;
  return [
    access.companyName,
    shop ? `Boutique : ${shop.name}` : "Toutes les boutiques",
    ...(period ? [`Du ${frenchDate(period.from)} au ${frenchDate(period.to)}`] : []),
  ];
}

const salesColumns: ReportColumn[] = [
  { key: "salesCount", header: "Ventes", type: "integer", width: 8 },
  { key: "revenue", header: "Chiffre d'affaires", type: "money" },
  { key: "discounts", header: "Remises", type: "money" },
  { key: "refunds", header: "Retours", type: "money" },
  { key: "netRevenue", header: "CA net", type: "money" },
  { key: "cost", header: "Coût des ventes", type: "money" },
  { key: "grossMargin", header: "Marge brute", type: "money" },
  { key: "marginRate", header: "Taux de marge", type: "percent", width: 10 },
];

const PERIOD_LABELS = { day: "Jour", week: "Semaine du", month: "Mois" } as const;

export function salesTable(report: Awaited<ReturnType<typeof reports.salesReport>>, subtitle: string[]): ReportTable {
  const label = (period: string) => (report.groupBy === "month" ? period.slice(0, 7).split("-").reverse().join("/") : frenchDate(period));
  return {
    title: "Ventes par période",
    subtitle,
    currency: report.currency,
    columns: [{ key: "period", header: PERIOD_LABELS[report.groupBy], width: 12 }, ...salesColumns],
    rows: report.rows.map((row) => ({ ...row, period: label(row.period) })),
    totals: { ...report.totals, period: "Total" },
    filename: `ventes_${report.from}_${report.to}`,
  };
}

export function topProductsTable(report: Awaited<ReturnType<typeof reports.topProducts>>, subtitle: string[]): ReportTable {
  return {
    title: "Meilleurs produits",
    subtitle,
    currency: report.currency,
    columns: [
      { key: "rank", header: "#", type: "integer", width: 5 },
      { key: "sku", header: "Réf.", width: 12 },
      { key: "name", header: "Produit", width: 28 },
      { key: "quantity", header: "Quantité", type: "quantity", width: 10 },
      { key: "unit", header: "Unité", width: 7 },
      { key: "revenue", header: "CA net", type: "money" },
      { key: "cost", header: "Coût", type: "money" },
      { key: "grossMargin", header: "Marge", type: "money" },
      { key: "marginRate", header: "Taux", type: "percent", width: 9 },
    ],
    rows: report.items.map((item, index) => ({ ...item, rank: index + 1 })),
    filename: `meilleurs-produits_${report.from}_${report.to}`,
  };
}

export function stockValueTable(report: Awaited<ReturnType<typeof reports.stockValue>>, subtitle: string[]): ReportTable {
  return {
    title: "Valeur du stock",
    subtitle: [...subtitle, `Au ${frenchDate(report.date)} — valorisation au coût moyen pondéré`],
    currency: report.currency,
    columns: [
      { key: "shopName", header: "Boutique", width: 16 },
      { key: "sku", header: "Réf.", width: 12 },
      { key: "name", header: "Produit", width: 26 },
      { key: "quantity", header: "Quantité", type: "quantity", width: 10 },
      { key: "unit", header: "Unité", width: 7 },
      { key: "averageCost", header: "Coût moyen", type: "money" },
      { key: "value", header: "Valeur (coût)", type: "money" },
      { key: "retailValue", header: "Valeur (vente)", type: "money" },
    ],
    rows: report.items,
    totals: { shopName: "Total", value: report.totals.value, retailValue: report.totals.retailValue },
    filename: `valeur-stock_${report.date}`,
  };
}

export function expensesTable(report: Awaited<ReturnType<typeof reports.expensesReport>>, subtitle: string[]): ReportTable {
  return {
    title: "Dépenses par catégorie",
    subtitle,
    currency: report.currency,
    columns: [
      { key: "name", header: "Catégorie", width: 30 },
      { key: "count", header: "Nombre", type: "integer", width: 10 },
      { key: "amount", header: "Montant", type: "money", width: 16 },
    ],
    rows: report.byCategory,
    totals: { name: "Total", amount: report.total },
    filename: `depenses_${report.from}_${report.to}`,
  };
}

export function profitAndLossTable(report: Awaited<ReturnType<typeof reports.profitAndLoss>>, subtitle: string[]): ReportTable {
  const { sales } = report;
  return {
    title: "Compte de résultat simplifié",
    subtitle: [...subtitle, "Estimation : coût des ventes au coût moyen pondéré, hors taxes et amortissements"],
    currency: report.currency,
    columns: [
      { key: "label", header: "Poste", width: 34 },
      { key: "amount", header: "Montant", type: "money", width: 18 },
    ],
    rows: [
      { label: "Chiffre d'affaires (ventes validées)", amount: sales.revenue },
      { label: "- Retours clients", amount: sales.refunds },
      { label: "= Chiffre d'affaires net", amount: sales.netRevenue },
      { label: "- Coût des ventes", amount: sales.cost },
      { label: `= Marge brute${sales.marginRate ? ` (${sales.marginRate.replace(".", ",")} %)` : ""}`, amount: sales.grossMargin },
      ...report.expenses.byCategory.map((category) => ({ label: `- Dépenses : ${category.name}`, amount: category.amount })),
    ],
    totals: { label: "= Résultat net estimé", amount: report.netResult },
    filename: `resultat_${report.from}_${report.to}`,
  };
}
