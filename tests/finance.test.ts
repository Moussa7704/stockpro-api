import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sequelize } from "../src/config/database.js";
import { AuditLog, Customer, CustomerLedgerEntry, ExpenseCategory, PaymentMethod, Unit } from "../src/models/index.js";
import { addMember, api, bearer, createCompany, login, type Session } from "./helpers/auth.js";

const YEAR = new Date().getUTCFullYear();
// Entreprises de test : fuseau Africa/Abidjan (UTC) → le jour de l'entreprise est le jour UTC
const TODAY = new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const post = (session: Session, path: string, body: object = {}, key?: string) => {
  const call = api().post(path).set("Authorization", bearer(session));
  return (key ? call.set("Idempotency-Key", key) : call).send(body);
};
const patch = (session: Session, path: string, body: object) =>
  api().patch(path).set("Authorization", bearer(session)).send(body);
const get = (session: Session, path: string) => api().get(path).set("Authorization", bearer(session));

/**
 * Entreprise avec du riz en stock (1 500 l'unité), un caissier en session (fond 10 000) et un
 * client "Awa" autorisé à 20 000 de crédit.
 */
async function setup(name = "Commerce A", email = "owner@test.com") {
  const { company, shop } = await createCompany(name, email);
  const owner = await login(email);
  const piece = (await Unit.findOne({ where: { companyId: company.id, name: "Pièce" } }))!;
  const rice = (await post(owner, "/api/products", { sku: "RIZ", name: "Riz", unitId: piece.id, salePrice: 1500 })).body.product;
  await post(owner, "/api/stock/adjustments", {
    shopId: shop.id,
    reason: "opening_balance",
    lines: [{ productId: rice.id, quantity: 50, unitCost: 1000 }],
  }).expect(201);

  const methods = await PaymentMethod.findAll({ where: { companyId: company.id } });
  const cash = methods.find((method) => method.code === "cash")!;
  const mobileMoney = methods.find((method) => method.code === "mobile_money")!;

  const cashierEmail = `cashier-${email}`;
  await addMember(company.id, cashierEmail, "cashier", { shopIds: [shop.id] });
  const cashier = await login(cashierEmail);
  const session = (await post(cashier, "/api/pos/sessions", { shopId: shop.id, openingFloat: 10000 }).expect(201)).body.session;
  const customer = (await post(owner, "/api/customers", { name: "Awa", creditLimit: 20000 }).expect(201)).body.customer;

  return { company, shop, owner, cashier, rice, cash, mobileMoney, session, customer };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Vente à crédit de `quantity` sacs de riz (rien payé). */
const creditSale = (ctx: Ctx, quantity = 2) =>
  post(
    ctx.cashier,
    "/api/pos/sales",
    { shopId: ctx.shop.id, customerId: ctx.customer.id, lines: [{ productId: ctx.rice.id, quantity }], payments: [] },
    randomUUID(),
  ).expect(201);

const pay = (ctx: Ctx, session: Session, body: object, key: string = randomUUID()) =>
  post(session, `/api/customers/${ctx.customer.id}/payments`, { shopId: ctx.shop.id, ...body }, key);

const balanceOf = async (id: string) => (await Customer.findByPk(id))!.balance;
const summaryOf = async (ctx: Ctx) => (await get(ctx.owner, `/api/pos/sessions/${ctx.session.id}`).expect(200)).body.session.summary;

/** Antidate des écritures : le journal est en ajout seul, on contourne le trigger pour le test. */
async function backdate(table: string, where: string, days: number) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SET LOCAL session_replication_role = replica", { transaction });
    await sequelize.query(`UPDATE ${table} SET created_at = created_at - interval '${days} days' WHERE ${where}`, {
      transaction,
    });
  });
}

describe("Règlement de dette client", () => {
  it("encaisse en espèces : solde diminué, écriture au compte, espèces attendues augmentées", async () => {
    const ctx = await setup();
    await creditSale(ctx, 2);
    expect(await balanceOf(ctx.customer.id)).toBe("3000.00");

    const payment = (await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 1000, reference: "Reçu 12" }).expect(201))
      .body.payment;

    expect(payment).toMatchObject({
      amount: "1000.00",
      cashSessionId: ctx.session.id,
      customerBalance: "2000.00",
      paymentMethod: expect.objectContaining({ code: "cash" }),
    });
    const entry = await CustomerLedgerEntry.findOne({ where: { customerId: ctx.customer.id, type: "payment" } });
    expect(entry).toMatchObject({ amount: "-1000.00", balanceAfter: "2000.00", sourceType: "customer_payment", sourceId: payment.id });

    const summary = await summaryOf(ctx);
    expect(summary).toMatchObject({ customerPayments: "1000.00", cashCustomerPayments: "1000.00", expectedCash: "11000.00" });
    expect(await AuditLog.count({ where: { action: "customer.payment", entityId: payment.id } })).toBe(1);

    const list = (await get(ctx.cashier, `/api/customers/${ctx.customer.id}/payments`).expect(200)).body;
    expect(list.items).toHaveLength(1);
  });

  it("refuse de dépasser la dette (pas d'avance) et exige une clé d'idempotence", async () => {
    const ctx = await setup();
    await creditSale(ctx, 2);

    await post(ctx.cashier, `/api/customers/${ctx.customer.id}/payments`, {
      shopId: ctx.shop.id,
      paymentMethodId: ctx.cash.id,
      amount: 1000,
    }).expect(400);
    const tooMuch = await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 3001 });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.message).toMatch(/dépasse la dette/);
    await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: "1000.50" }).expect(400);
    await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 0 }).expect(400);

    await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 3000 }).expect(201);
    expect(await balanceOf(ctx.customer.id)).toBe("0.00");
  });

  it("rejoue un règlement avec la même clé sans encaisser deux fois", async () => {
    const ctx = await setup();
    await creditSale(ctx, 2);
    const key = randomUUID();

    const first = (await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 1000 }, key).expect(201)).body;
    const replay = (await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 1000 }, key).expect(201)).body;

    expect(replay.payment.id).toBe(first.payment.id);
    expect(await balanceOf(ctx.customer.id)).toBe("2000.00");
    await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 500 }, key).expect(422);
  });

  it("deux règlements simultanés ne soldent jamais plus que la dette", async () => {
    const ctx = await setup();
    await creditSale(ctx, 2);

    const results = await Promise.all([
      pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 2000 }),
      pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 2000 }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([201, 400]);
    expect(await balanceOf(ctx.customer.id)).toBe("1000.00");
  });

  it("espèces sans session : refusé ; Mobile Money sans session : accepté hors tiroir", async () => {
    const ctx = await setup();
    await creditSale(ctx, 2);

    const noSession = await pay(ctx, ctx.owner, { paymentMethodId: ctx.cash.id, amount: 1000 });
    expect(noSession.status).toBe(409);
    expect(noSession.body.error.message).toBe("Ouvrez une session de caisse pour encaisser en espèces");

    const mobile = (await pay(ctx, ctx.owner, { paymentMethodId: ctx.mobileMoney.id, amount: 1000 }).expect(201)).body.payment;
    expect(mobile.cashSessionId).toBeNull();

    // Mobile Money encaissé par le caissier : rattaché à sa session, sans toucher au tiroir
    await pay(ctx, ctx.cashier, { paymentMethodId: ctx.mobileMoney.id, amount: 500 }).expect(201);
    expect(await summaryOf(ctx)).toMatchObject({ customerPayments: "500.00", cashCustomerPayments: "0.00", expectedCash: "10000.00" });
  });

  it("un rôle sans customer_payments.manage ne peut pas encaisser", async () => {
    const ctx = await setup();
    await creditSale(ctx, 2);
    await addMember(ctx.company.id, "stock@test.com", "stock_keeper", { shopIds: [ctx.shop.id] });
    const keeper = await login("stock@test.com");

    await pay(ctx, keeper, { paymentMethodId: ctx.mobileMoney.id, amount: 1000 }).expect(403);
  });

  it("la clôture tient compte des règlements en espèces", async () => {
    const ctx = await setup();
    await creditSale(ctx, 2);
    await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 1500 }).expect(201);

    const closed = (await post(ctx.cashier, `/api/pos/sessions/${ctx.session.id}/close`, { countedCash: 11500 }).expect(200)).body
      .session;
    expect(closed).toMatchObject({ expectedCash: "11500.00", difference: "0.00" });
  });
});

describe("Relevé de compte", () => {
  it("donne le solde d'ouverture, les mouvements avec leur référence et le solde de clôture", async () => {
    const ctx = await setup();
    const sale = (await creditSale(ctx, 2)).body.sale;
    await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 1000 }).expect(201);

    const statement = (await get(ctx.cashier, `/api/customers/${ctx.customer.id}/statement?from=${TODAY}&to=${TODAY}`).expect(200))
      .body.statement;

    expect(statement).toMatchObject({
      customer: { id: ctx.customer.id, name: "Awa" },
      openingBalance: "0.00",
      totalDebits: "3000.00",
      totalCredits: "1000.00",
      closingBalance: "2000.00",
    });
    expect(statement.entries).toEqual([
      expect.objectContaining({ type: "sale_credit", reference: sale.number, debit: "3000.00", credit: "0.00", balance: "3000.00" }),
      expect.objectContaining({ type: "payment", reference: "Espèces", debit: "0.00", credit: "1000.00", balance: "2000.00" }),
    ]);
  });

  it("reporte les mouvements antérieurs dans le solde d'ouverture", async () => {
    const ctx = await setup();
    await creditSale(ctx, 2);
    await backdate("customer_ledger_entries", `customer_id = '${ctx.customer.id}'`, 10);
    await creditSale(ctx, 1);

    const statement = (await get(ctx.owner, `/api/customers/${ctx.customer.id}/statement?from=${dayOffset(-5)}&to=${TODAY}`).expect(200))
      .body.statement;
    expect(statement).toMatchObject({ openingBalance: "3000.00", totalDebits: "1500.00", closingBalance: "4500.00" });
    expect(statement.entries).toHaveLength(1);

    const future = (await get(ctx.owner, `/api/customers/${ctx.customer.id}/statement?from=${dayOffset(1)}&to=${dayOffset(2)}`)).body
      .statement;
    expect(future).toMatchObject({ openingBalance: "4500.00", closingBalance: "4500.00", entries: [] });
  });

  it("valide la période", async () => {
    const ctx = await setup();
    const base = `/api/customers/${ctx.customer.id}/statement`;

    await get(ctx.owner, base).expect(400);
    await get(ctx.owner, `${base}?from=${TODAY}&to=${dayOffset(-1)}`).expect(400);
    await get(ctx.owner, `${base}?from=${dayOffset(-400)}&to=${TODAY}`).expect(400);
    await get(ctx.owner, `${base}?from=2026-02-30&to=${TODAY}`).expect(400);
  });
});

describe("Impayés", () => {
  it("liste les débiteurs avec l'ancienneté de la dette (les règlements soldent le plus ancien)", async () => {
    const ctx = await setup();
    await creditSale(ctx, 2);
    await backdate("customer_ledger_entries", `customer_id = '${ctx.customer.id}'`, 45);
    await creditSale(ctx, 2);
    await pay(ctx, ctx.cashier, { paymentMethodId: ctx.cash.id, amount: 1000 }).expect(201);
    // Client sans dette : absent de la liste
    await post(ctx.owner, "/api/customers", { name: "Sans dette" }).expect(201);

    const debtors = (await get(ctx.owner, "/api/customers/debtors").expect(200)).body;

    expect(debtors).toMatchObject({ total: 1, totalDebt: "5000.00" });
    expect(debtors.items[0]).toMatchObject({
      id: ctx.customer.id,
      balance: "5000.00",
      aging: { current: "3000.00", days31To60: "2000.00", days61To90: "0.00", over90: "0.00" },
    });
    expect(new Date(debtors.items[0].oldestUnpaidAt).getTime()).toBeLessThan(Date.now() - 40 * 86_400_000);

    expect((await get(ctx.owner, "/api/customers/debtors?minAmount=6000").expect(200)).body.items).toEqual([]);
  });

  it("réservé aux rôles qui voient les comptes", async () => {
    const ctx = await setup();
    await get(ctx.cashier, "/api/customers/debtors").expect(403);
  });
});

async function setupWithCategory() {
  const ctx = await setup();
  const category = (await ExpenseCategory.findOne({ where: { companyId: ctx.company.id, name: "Électricité et eau" } }))!;
  return { ...ctx, categoryId: category.id };
}

const expense = (ctx: Awaited<ReturnType<typeof setupWithCategory>>, body: object = {}) =>
  post(ctx.owner, "/api/expenses", {
    shopId: ctx.shop.id,
    categoryId: ctx.categoryId,
    amount: 2000,
    description: "Facture d'électricité",
    paymentMethodId: ctx.cash.id,
    ...body,
  });

describe("Dépenses", () => {
  it("chaque entreprise reçoit ses catégories par défaut ; noms uniques sans tenir compte de la casse", async () => {
    const ctx = await setup();

    const categories = (await get(ctx.owner, "/api/expenses/categories").expect(200)).body.categories;
    expect(categories.map((category: { name: string }) => category.name)).toContain("Loyer");
    expect(categories).toHaveLength(6);

    await post(ctx.owner, "/api/expenses/categories", { name: "loyer" }).expect(409);
    const created = (await post(ctx.owner, "/api/expenses/categories", { name: "Gardiennage" }).expect(201)).body.category;
    await patch(ctx.owner, `/api/expenses/categories/${created.id}`, { archived: true }).expect(200);
    expect((await get(ctx.owner, "/api/expenses/categories").expect(200)).body.categories).toHaveLength(6);
    expect((await get(ctx.owner, "/api/expenses/categories?includeArchived=true").expect(200)).body.categories).toHaveLength(7);
  });

  it("payée depuis le tiroir : numérotée, diminue les espèces attendues ; annulée : les restitue", async () => {
    const ctx = await setupWithCategory();

    const created = (await expense(ctx, { cashSessionId: ctx.session.id }).expect(201)).body.expense;
    expect(created).toMatchObject({
      number: `BTQ1-DEP-${YEAR}-000001`,
      amount: "2000.00",
      spentAt: TODAY,
      status: "recorded",
      cashSessionId: ctx.session.id,
      category: expect.objectContaining({ name: "Électricité et eau" }),
    });
    expect(await summaryOf(ctx)).toMatchObject({ cashExpenses: "2000.00", expectedCash: "8000.00" });

    // Payée hors tiroir (coffre) : la caisse n'est pas touchée
    await expense(ctx, { amount: 5000 }).expect(201);
    expect((await summaryOf(ctx)).expectedCash).toBe("8000.00");

    const cancelled = (await post(ctx.owner, `/api/expenses/${created.id}/cancel`, { reason: "Saisie en double" }).expect(200)).body
      .expense;
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Saisie en double" });
    expect((await summaryOf(ctx)).expectedCash).toBe("10000.00");
    await post(ctx.owner, `/api/expenses/${created.id}/cancel`, { reason: "Encore" }).expect(409);
    expect(await AuditLog.count({ where: { action: "expense.cancel", entityId: created.id } })).toBe(1);
  });

  it("valide le moyen de paiement, la session, la catégorie et la date", async () => {
    const ctx = await setupWithCategory();

    await expense(ctx, { paymentMethodId: ctx.mobileMoney.id, cashSessionId: ctx.session.id }).expect(400);
    await expense(ctx, { cashSessionId: randomUUID() }).expect(400);
    await expense(ctx, { spentAt: dayOffset(2) }).expect(400);
    await expense(ctx, { amount: "10.5" }).expect(400);
    await expense(ctx, { spentAt: dayOffset(-3), paymentMethodId: ctx.mobileMoney.id }).expect(201);

    await patch(ctx.owner, `/api/expenses/categories/${ctx.categoryId}`, { archived: true }).expect(200);
    await expense(ctx).expect(400);
  });

  it("une session clôturée n'accepte plus de dépense et ses dépenses ne s'annulent plus", async () => {
    const ctx = await setupWithCategory();
    const created = (await expense(ctx, { cashSessionId: ctx.session.id }).expect(201)).body.expense;

    const closed = (await post(ctx.cashier, `/api/pos/sessions/${ctx.session.id}/close`, { countedCash: 8000 }).expect(200)).body.session;
    expect(closed).toMatchObject({ expectedCash: "8000.00", difference: "0.00" });

    await expense(ctx, { cashSessionId: ctx.session.id }).expect(409);
    await post(ctx.owner, `/api/expenses/${created.id}/cancel`, { reason: "Trop tard" }).expect(409);
  });

  it("liste filtrée avec le total hors dépenses annulées", async () => {
    const ctx = await setupWithCategory();
    const first = (await expense(ctx, { amount: 1000 }).expect(201)).body.expense;
    await expense(ctx, { amount: 3000, spentAt: dayOffset(-10) }).expect(201);
    await expense(ctx, { amount: 500 }).expect(201);
    await post(ctx.owner, `/api/expenses/${first.id}/cancel`, { reason: "Erreur de saisie" }).expect(200);

    const all = (await get(ctx.owner, "/api/expenses").expect(200)).body;
    expect(all).toMatchObject({ total: 3, totalAmount: "3500.00" });

    const recent = (await get(ctx.owner, `/api/expenses?from=${dayOffset(-1)}&to=${TODAY}`).expect(200)).body;
    expect(recent).toMatchObject({ total: 2, totalAmount: "500.00" });

    const cancelled = (await get(ctx.owner, "/api/expenses?status=cancelled").expect(200)).body;
    expect(cancelled).toMatchObject({ total: 1, totalAmount: "1000.00" });
  });

  it("réservé à expenses.manage : le caissier n'y a pas accès", async () => {
    const ctx = await setupWithCategory();
    await get(ctx.cashier, "/api/expenses").expect(403);
    await post(ctx.cashier, "/api/expenses", {}).expect(403);

    await addMember(ctx.company.id, "compta@test.com", "accountant", { allShops: true });
    const accountant = await login("compta@test.com");
    await post(accountant, "/api/expenses", {
      shopId: ctx.shop.id,
      categoryId: ctx.categoryId,
      amount: 1000,
      description: "Transport",
      paymentMethodId: ctx.mobileMoney.id,
    }).expect(201);
  });
});

describe("Isolation entre entreprises (finances)", () => {
  it("une entreprise ne touche ni aux clients, ni aux dépenses, ni aux caisses d'une autre", async () => {
    const a = await setup();
    const b = await setup("Commerce B", "owner-b@test.com");
    await creditSale(a, 2);
    const categoryA = (await ExpenseCategory.findOne({ where: { companyId: a.company.id } }))!;
    const categoryB = (await ExpenseCategory.findOne({ where: { companyId: b.company.id } }))!;
    const expenseA = (await post(a.owner, "/api/expenses", {
      shopId: a.shop.id,
      categoryId: categoryA.id,
      amount: 1000,
      description: "Loyer",
      paymentMethodId: a.cash.id,
    }).expect(201)).body.expense;
    const paymentA = (await pay(a, a.cashier, { paymentMethodId: a.cash.id, amount: 1000 }).expect(201)).body.payment;

    // Client, règlements et relevé de A : introuvables pour B
    await post(b.cashier, `/api/customers/${a.customer.id}/payments`, { shopId: b.shop.id, paymentMethodId: b.cash.id, amount: 100 }, randomUUID()).expect(404);
    await get(b.owner, `/api/customers/${a.customer.id}/statement?from=${TODAY}&to=${TODAY}`).expect(404);
    await get(b.owner, `/api/customers/${a.customer.id}/payments`).expect(404);
    await get(b.owner, `/api/customers/payments/${paymentA.id}`).expect(404);
    expect((await get(b.owner, "/api/customers/debtors").expect(200)).body.items).toEqual([]);

    // Dépense, catégorie et session de caisse de A : inutilisables pour B
    await get(b.owner, `/api/expenses/${expenseA.id}`).expect(404);
    await post(b.owner, `/api/expenses/${expenseA.id}/cancel`, { reason: "Intrusion" }).expect(404);
    await patch(b.owner, `/api/expenses/categories/${categoryA.id}`, { name: "Piraté" }).expect(404);
    const intruder = { shopId: b.shop.id, amount: 1000, description: "Intrusion", paymentMethodId: b.cash.id };
    await post(b.owner, "/api/expenses", { ...intruder, categoryId: categoryA.id }).expect(400);
    await post(b.owner, "/api/expenses", { ...intruder, categoryId: categoryB.id, cashSessionId: a.session.id }).expect(400);
    await post(b.owner, "/api/expenses", { ...intruder, categoryId: categoryB.id, shopId: a.shop.id }).expect(404);
    expect((await get(b.owner, "/api/expenses").expect(200)).body.total).toBe(0);
  });

  it("un caissier ne voit pas les règlements d'une boutique hors de son périmètre", async () => {
    const ctx = await setup();
    await creditSale(ctx, 2);
    const other = (await post(ctx.owner, "/api/shops", { name: "Annexe", code: "BTQ2" }).expect(201)).body.shop;
    const payment = (await post(
      ctx.owner,
      `/api/customers/${ctx.customer.id}/payments`,
      { shopId: other.id, paymentMethodId: ctx.mobileMoney.id, amount: 500 },
      randomUUID(),
    ).expect(201)).body.payment;

    await get(ctx.cashier, `/api/customers/payments/${payment.id}`).expect(404);
    await pay(ctx, ctx.cashier, { shopId: other.id, paymentMethodId: ctx.mobileMoney.id, amount: 500 }).expect(404);
  });
});
