import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import type { Response as SuperResponse } from "supertest";
import { describe, expect, it } from "vitest";
import { sequelize } from "../src/config/database.js";
import { ExpenseCategory, PaymentMethod, Unit } from "../src/models/index.js";
import { previousPeriod } from "../src/modules/reports/reports.service.js";
import { addMember, api, bearer, createCompany, login, type Session } from "./helpers/auth.js";

// Entreprises de test : fuseau Africa/Abidjan (UTC) → le jour de l'entreprise est le jour UTC
const TODAY = new Date().toISOString().slice(0, 10);
const addDaysTo = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const post = (session: Session, path: string, body: object = {}, key?: string) => {
  const call = api().post(path).set("Authorization", bearer(session));
  return (key ? call.set("Idempotency-Key", key) : call).send(body);
};
const get = (session: Session, path: string) => api().get(path).set("Authorization", bearer(session));

/** Télécharge un fichier binaire (Excel / PDF) et le renvoie sous forme de Buffer. */
const download = (session: Session, path: string) =>
  get(session, path)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });

async function loadWorkbook(body: Buffer) {
  const workbook = new ExcelJS.Workbook();
  // exceljs déclare son propre type Buffer (antérieur aux Buffer génériques de Node)
  await workbook.xlsx.load(body as unknown as ExcelJS.Buffer);
  return workbook;
}

/**
 * Activité connue du jour, sur du riz acheté 1 000 et vendu 1 500 (stock initial 50) :
 * - vente 1 : 2 riz en espèces (3 000, coût 2 000) ;
 * - vente 2 : 1 riz à crédit (1 500, coût 1 000) ;
 * - vente 3 : 2 riz, annulée → exclue partout ;
 * - retour d'1 riz de la vente 1, remis en stock, remboursé 1 500 en espèces ;
 * - dépense de loyer 2 000.
 * Attendu : CA 4 500, retours 1 500, CA net 3 000, coût 2 000, marge 1 000, résultat −1 000.
 */
async function setup(name = "Commerce A", email = "owner@test.com") {
  const { company, shop } = await createCompany(name, email);
  const owner = await login(email);
  const piece = (await Unit.findOne({ where: { companyId: company.id, name: "Pièce" } }))!;
  const rice = (await post(owner, "/api/products", { sku: "RIZ", name: "Riz", unitId: piece.id, salePrice: 1500, alertThreshold: 60 }))
    .body.product;
  await post(owner, "/api/stock/adjustments", {
    shopId: shop.id,
    reason: "opening_balance",
    lines: [{ productId: rice.id, quantity: 50, unitCost: 1000 }],
  }).expect(201);
  const cash = (await PaymentMethod.findOne({ where: { companyId: company.id, code: "cash" } }))!;
  await post(owner, "/api/pos/sessions", { shopId: shop.id, openingFloat: 10000 }).expect(201);
  return { company, shop, owner, rice, cash };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const sell = (ctx: Ctx, quantity: number, extra: object = {}) =>
  post(
    ctx.owner,
    "/api/pos/sales",
    { shopId: ctx.shop.id, lines: [{ productId: ctx.rice.id, quantity }], payments: [{ methodId: ctx.cash.id, amount: 1500 * quantity }], ...extra },
    randomUUID(),
  ).expect(201);

async function withActivity(name?: string, email?: string) {
  const ctx = await setup(name, email);
  const first = (await sell(ctx, 2)).body.sale;
  const customer = (await post(ctx.owner, "/api/customers", { name: "Awa", creditLimit: 10000 }).expect(201)).body.customer;
  await sell(ctx, 1, { customerId: customer.id, payments: [] });
  const cancelled = (await sell(ctx, 2)).body.sale;
  await post(ctx.owner, `/api/pos/sales/${cancelled.id}/cancel`, { reason: "Erreur de caisse" }).expect(200);
  await post(
    ctx.owner,
    "/api/pos/returns",
    {
      saleId: first.id,
      reason: "Sac abîmé échangé",
      lines: [{ saleLineId: first.lines[0].id, quantity: 1, restock: true }],
      refundTo: "method",
      refundMethodId: ctx.cash.id,
    },
    randomUUID(),
  ).expect(201);
  const rent = (await ExpenseCategory.findOne({ where: { companyId: ctx.company.id, name: "Loyer" } }))!;
  await post(ctx.owner, "/api/expenses", {
    shopId: ctx.shop.id,
    categoryId: rent.id,
    amount: 2000,
    description: "Loyer d'octobre",
    paymentMethodId: ctx.cash.id,
  }).expect(201);
  return { ...ctx, first, customer };
}

/** Antidate des ventes (le contournement des triggers est réservé au test). */
async function backdateSales(companyId: string, days: number) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SET LOCAL session_replication_role = replica", { transaction });
    await sequelize.query(`UPDATE sales SET created_at = created_at - interval '${days} days' WHERE company_id = :companyId`, {
      replacements: { companyId },
      transaction,
    });
  });
}

describe("Rapport des ventes", () => {
  it("calcule CA, retours, coût et marge du jour en excluant les ventes annulées", async () => {
    const ctx = await withActivity();

    const report = (await get(ctx.owner, `/api/reports/sales?from=${TODAY}&to=${TODAY}`).expect(200)).body.report;

    expect(report.rows).toHaveLength(1);
    expect(report.totals).toEqual({
      salesCount: 2,
      grossSales: "4500.00",
      discounts: "0.00",
      revenue: "4500.00",
      refunds: "1500.00",
      netRevenue: "3000.00",
      cost: "2000.00",
      grossMargin: "1000.00",
      marginRate: "33.3",
      averageBasket: "2250.00",
    });
  });

  it("regroupe par jour (avec les jours sans vente) et par mois", async () => {
    const ctx = await setup();
    await sell(ctx, 1);
    await backdateSales(ctx.company.id, 2);
    await sell(ctx, 2);

    const daily = (await get(ctx.owner, `/api/reports/sales?from=${dayOffset(-3)}&to=${TODAY}`).expect(200)).body.report;
    expect(daily.rows.map((row: { period: string; revenue: string }) => [row.period, row.revenue])).toEqual([
      [dayOffset(-3), "0.00"],
      [dayOffset(-2), "1500.00"],
      [dayOffset(-1), "0.00"],
      [TODAY, "3000.00"],
    ]);
    expect(daily.totals.revenue).toBe("4500.00");

    const monthly = (await get(ctx.owner, `/api/reports/sales?from=${dayOffset(-40)}&to=${TODAY}&groupBy=month`).expect(200)).body.report;
    expect(monthly.rows.length).toBeGreaterThanOrEqual(2);
    expect(monthly.rows.every((row: { period: string }) => row.period.endsWith("-01"))).toBe(true);
    expect(monthly.totals.revenue).toBe("4500.00");
  });

  it("valide la période et le format", async () => {
    const ctx = await setup();
    await get(ctx.owner, "/api/reports/sales").expect(400);
    await get(ctx.owner, `/api/reports/sales?from=${TODAY}&to=${dayOffset(-1)}`).expect(400);
    await get(ctx.owner, `/api/reports/sales?from=${dayOffset(-800)}&to=${TODAY}`).expect(400);
    await get(ctx.owner, `/api/reports/sales?from=${TODAY}&to=${TODAY}&format=csv`).expect(400);
    await get(ctx.owner, `/api/reports/sales?from=${TODAY}&to=${TODAY}&groupBy=year`).expect(400);
  });
});

describe("Autres rapports", () => {
  it("meilleurs produits : quantités et CA nets des retours, marge", async () => {
    const ctx = await withActivity();

    const report = (await get(ctx.owner, `/api/reports/top-products?from=${TODAY}&to=${TODAY}`).expect(200)).body.report;

    expect(report.items).toEqual([
      expect.objectContaining({
        sku: "RIZ",
        quantity: "2.000",
        salesCount: 2,
        revenue: "3000.00",
        cost: "2000.00",
        grossMargin: "1000.00",
        marginRate: "33.3",
      }),
    ]);
  });

  it("valeur du stock au CMP et au prix de vente, par boutique", async () => {
    const ctx = await withActivity();

    const report = (await get(ctx.owner, "/api/reports/stock-value").expect(200)).body.report;

    // 50 − 3 vendus + 1 retour remis en stock (la vente annulée a restitué son stock)
    expect(report.items).toEqual([expect.objectContaining({ sku: "RIZ", quantity: "48.000", value: "48000.00", retailValue: "72000.00" })]);
    expect(report.totals).toEqual({ value: "48000.00", retailValue: "72000.00", potentialMargin: "24000.00" });
    expect(report.shops).toEqual([expect.objectContaining({ name: expect.any(String), products: 1, value: "48000.00" })]);
  });

  it("dépenses par catégorie et compte de résultat", async () => {
    const ctx = await withActivity();

    const expenses = (await get(ctx.owner, `/api/reports/expenses?from=${TODAY}&to=${TODAY}`).expect(200)).body.report;
    expect(expenses).toMatchObject({ total: "2000.00", byCategory: [expect.objectContaining({ name: "Loyer", count: 1, amount: "2000.00" })] });

    const pnl = (await get(ctx.owner, `/api/reports/profit-and-loss?from=${TODAY}&to=${TODAY}`).expect(200)).body.report;
    expect(pnl.sales).toMatchObject({ netRevenue: "3000.00", cost: "2000.00", grossMargin: "1000.00" });
    expect(pnl.expenses.total).toBe("2000.00");
    expect(pnl.netResult).toBe("-1000.00");
  });
});

describe("Tableau de bord", () => {
  it("résume la journée, la veille, le mois, le stock, les créances et les caisses ouvertes", async () => {
    const ctx = await withActivity();

    const dashboard = (await get(ctx.owner, "/api/reports/dashboard").expect(200)).body.dashboard;

    expect(dashboard.date).toBe(TODAY);
    expect(dashboard.today).toMatchObject({ salesCount: 2, netRevenue: "3000.00", grossMargin: "1000.00" });
    expect(dashboard.yesterday).toMatchObject({ salesCount: 0, netRevenue: "0.00" });
    expect(dashboard.month).toMatchObject({ netRevenue: "3000.00", expenses: "2000.00", netResult: "-1000.00" });
    expect(dashboard.last7Days).toHaveLength(7);
    expect(dashboard.last7Days.at(-1)).toEqual({ date: TODAY, salesCount: 2, netRevenue: "3000.00" });
    expect(dashboard.topProducts[0]).toMatchObject({ sku: "RIZ", revenue: "3000.00" });
    // Seuil d'alerte à 60 : le riz (48) est en stock bas
    expect(dashboard.stock).toEqual({ value: "48000.00", lowStockCount: 1, outOfStockCount: 0 });
    expect(dashboard.customers).toEqual({ debtorsCount: 1, totalDebt: "1500.00" });
    expect(dashboard.openCashSessions).toBe(1);
    // Sans période : le mois en cours jusqu'à aujourd'hui, comparé aux jours juste avant
    expect(dashboard.period).toMatchObject({ from: `${TODAY.slice(0, 8)}01`, to: TODAY, netRevenue: "3000.00", expenses: "2000.00", netResult: "-1000.00", groupBy: "day" });
    expect(dashboard.period.previous).toMatchObject({ to: addDaysTo(`${TODAY.slice(0, 8)}01`, -1), salesCount: 0 });
    expect(dashboard.period.chart).toHaveLength(dashboard.period.days);
  });

  it("filtre par boutique et respecte le périmètre du gérant", async () => {
    const ctx = await withActivity();
    const annex = (await post(ctx.owner, "/api/shops", { name: "Annexe", code: "BTQ2" }).expect(201)).body.shop;

    const annexOnly = (await get(ctx.owner, `/api/reports/dashboard?shopId=${annex.id}`).expect(200)).body.dashboard;
    expect(annexOnly.today).toMatchObject({ salesCount: 0, netRevenue: "0.00" });
    expect(annexOnly.stock.value).toBe("0.00");

    await addMember(ctx.company.id, "manager@test.com", "manager", { shopIds: [annex.id] });
    const manager = await login("manager@test.com");
    const scoped = (await get(manager, `/api/reports/sales?from=${TODAY}&to=${TODAY}`).expect(200)).body.report;
    expect(scoped.totals.revenue).toBe("0.00");
    await get(manager, `/api/reports/stock-value?shopId=${ctx.shop.id}`).expect(404);
  });
});

describe("Tableau de bord sur une période passée", () => {
  it("une date précise : chiffres de ce jour, comparés à la veille, top produits du jour", async () => {
    const ctx = await withActivity();
    // Les ventes partent 40 jours en arrière ; le retour et la dépense restent aujourd'hui
    await backdateSales(ctx.company.id, 40);
    const day = dayOffset(-40);

    const dashboard = (await get(ctx.owner, `/api/reports/dashboard?from=${day}&to=${day}`).expect(200)).body.dashboard;

    expect(dashboard.period).toMatchObject({ from: day, to: day, days: 1, groupBy: "day", salesCount: 2, revenue: "4500.00", refunds: "0.00", expenses: "0.00" });
    expect(dashboard.period.previous).toMatchObject({ from: dayOffset(-41), to: dayOffset(-41), salesCount: 0 });
    expect(dashboard.period.chart).toEqual([{ period: day, salesCount: 2, netRevenue: "4500.00" }]);
    // Le top produits suit la période (retour rattaché à la vente d'origine)
    expect(dashboard.topProducts[0]).toMatchObject({ sku: "RIZ", revenue: "3000.00" });
    // Aujourd'hui reste aujourd'hui : seul le retour y figure ; le stock est celui de l'instant
    expect(dashboard.today).toMatchObject({ salesCount: 0, refunds: "1500.00" });
    expect(dashboard.stock.value).toBe("48000.00");
  });

  it("une longue période : graphique par mois", async () => {
    const ctx = await setup();
    const from = dayOffset(-200);

    const dashboard = (await get(ctx.owner, `/api/reports/dashboard?from=${from}&to=${TODAY}`).expect(200)).body.dashboard;

    expect(dashboard.period).toMatchObject({ from, to: TODAY, days: 201, groupBy: "month" });
    expect(dashboard.period.chart.length).toBeGreaterThanOrEqual(7);
    expect(dashboard.period.chart.every((point: { period: string }) => point.period.endsWith("-01"))).toBe(true);
    expect(dashboard.period.previous).toMatchObject({ from: dayOffset(-401), to: dayOffset(-201) });
  });

  it("refuse une période incomplète, inversée, trop longue ou dans le futur", async () => {
    const ctx = await setup();
    const call = (query: string) => get(ctx.owner, `/api/reports/dashboard?${query}`).expect(400);

    await call(`from=${TODAY}`);
    await call(`from=${TODAY}&to=${dayOffset(-1)}`);
    await call(`from=${dayOffset(-800)}&to=${TODAY}`);
    const future = await call(`from=${TODAY}&to=${dayOffset(1)}`);
    expect(future.body.error.message).toBe("La période ne peut pas dépasser aujourd'hui");
  });

  it("période de comparaison : mois entiers → mois précédents, sinon autant de jours juste avant", () => {
    expect(previousPeriod({ from: "2026-10-05", to: "2026-10-05" })).toEqual({ from: "2026-10-04", to: "2026-10-04" });
    expect(previousPeriod({ from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(previousPeriod({ from: "2026-03-01", to: "2026-03-31" })).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousPeriod({ from: "2026-01-01", to: "2026-01-31" })).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(previousPeriod({ from: "2026-07-01", to: "2026-09-30" })).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(previousPeriod({ from: "2026-10-01", to: "2026-10-17" })).toEqual({ from: "2026-09-14", to: "2026-09-30" });
    expect(previousPeriod({ from: "2026-03-10", to: "2026-03-19" })).toEqual({ from: "2026-02-28", to: "2026-03-09" });
  });
});

describe("Exports Excel et PDF", () => {
  it("exporte le rapport des ventes en Excel avec des valeurs numériques", async () => {
    const ctx = await withActivity();

    const response = await download(ctx.owner, `/api/reports/sales?from=${TODAY}&to=${TODAY}&format=xlsx`).expect(200);

    expect(response.headers["content-type"]).toContain("spreadsheetml");
    expect(response.headers["content-disposition"]).toBe(`attachment; filename="ventes_${TODAY}_${TODAY}.xlsx"`);
    const workbook = await loadWorkbook(response.body as Buffer);
    const sheet = workbook.worksheets[0]!;
    const values = (row: number) => (sheet.getRow(row).values as unknown[]).slice(1);
    expect(sheet.getCell("A1").value).toBe("Ventes par période");
    expect(sheet.getCell("A2").value).toBe("Commerce A");

    const headerRow = sheet.getColumn(1).values.indexOf("Jour");
    expect(values(headerRow)).toEqual(["Jour", "Ventes", "Chiffre d'affaires", "Remises", "Retours", "CA net", "Coût des ventes", "Marge brute", "Taux de marge"]);
    expect(values(headerRow + 2)).toEqual(["Total", 2, 4500, 0, 1500, 3000, 2000, 1000, 33.3]);
  });

  it("exporte chaque rapport en PDF", async () => {
    const ctx = await withActivity();
    const period = `from=${TODAY}&to=${TODAY}&format=pdf`;

    for (const path of [
      `/api/reports/sales?${period}`,
      `/api/reports/top-products?${period}`,
      `/api/reports/expenses?${period}`,
      `/api/reports/profit-and-loss?${period}`,
      "/api/reports/stock-value?format=pdf",
    ]) {
      const response: SuperResponse = await download(ctx.owner, path).expect(200);
      expect(response.headers["content-type"]).toBe("application/pdf");
      expect((response.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    }
  });

  it("produit un fichier même sans données", async () => {
    const ctx = await setup();
    const response = await download(ctx.owner, `/api/reports/expenses?from=${TODAY}&to=${TODAY}&format=xlsx`).expect(200);
    const workbook = await loadWorkbook(response.body as Buffer);
    expect(workbook.worksheets[0]!.getCell("A1").value).toBe("Dépenses par catégorie");
  });
});

describe("Accès aux rapports", () => {
  it("réservés à reports.view : ni caissier ni gestionnaire de stock", async () => {
    const ctx = await setup();
    await addMember(ctx.company.id, "cashier@test.com", "cashier", { shopIds: [ctx.shop.id] });
    await addMember(ctx.company.id, "stock@test.com", "stock_keeper", { shopIds: [ctx.shop.id] });
    await addMember(ctx.company.id, "compta@test.com", "accountant", { allShops: true });

    await get(await login("cashier@test.com"), "/api/reports/dashboard").expect(403);
    await get(await login("stock@test.com"), "/api/reports/stock-value").expect(403);
    await get(await login("compta@test.com"), "/api/reports/dashboard").expect(200);
  });

  it("isolation : une entreprise ne voit jamais les chiffres d'une autre", async () => {
    const a = await withActivity();
    const b = await setup("Commerce B", "owner-b@test.com");

    const dashboard = (await get(b.owner, "/api/reports/dashboard").expect(200)).body.dashboard;
    expect(dashboard.today.salesCount).toBe(0);
    expect(dashboard.customers.totalDebt).toBe("0.00");
    expect(dashboard.stock.value).toBe("50000.00");

    await get(b.owner, `/api/reports/dashboard?shopId=${a.shop.id}`).expect(404);
    await get(b.owner, `/api/reports/sales?from=${TODAY}&to=${TODAY}&shopId=${a.shop.id}`).expect(404);
    const top = (await get(b.owner, `/api/reports/top-products?from=${TODAY}&to=${TODAY}`).expect(200)).body.report;
    expect(top.items).toEqual([]);
    const expenses = (await get(b.owner, `/api/reports/expenses?from=${TODAY}&to=${TODAY}`).expect(200)).body.report;
    expect(expenses.total).toBe("0.00");
  });
});
