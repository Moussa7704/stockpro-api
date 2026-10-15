import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuditLog, Company, Customer, CustomerLedgerEntry, PaymentMethod, Sale, StockLevel, Unit } from "../src/models/index.js";
import { addMember, api, bearer, createCompany, login, type Session } from "./helpers/auth.js";

const YEAR = new Date().getUTCFullYear();

const post = (session: Session, path: string, body: object = {}, key?: string) => {
  const call = api().post(path).set("Authorization", bearer(session));
  return (key ? call.set("Idempotency-Key", key) : call).send(body);
};
const patch = (session: Session, path: string, body: object) =>
  api().patch(path).set("Authorization", bearer(session)).send(body);
const get = (session: Session, path: string) => api().get(path).set("Authorization", bearer(session));

/** Vente : chaque appel a sa propre clé d'idempotence (sauf si on en impose une). */
const sell = (session: Session, body: object, key: string = randomUUID()) => post(session, "/api/pos/sales", body, key);
const refund = (session: Session, body: object, key: string = randomUUID()) => post(session, "/api/pos/returns", body, key);

/**
 * Entreprise prête à vendre : riz (pièce, 1 500, stock 10 au coût 1 000), sucre (kg, 800, stock 5 au
 * coût 600), un caissier sur BTQ1 avec une session ouverte (fond de caisse 10 000).
 */
async function setup(name = "Commerce A", email = "owner@test.com") {
  const { company, shop } = await createCompany(name, email);
  const owner = await login(email);
  const units = await Unit.findAll({ where: { companyId: company.id } });
  const piece = units.find((unit) => unit.name === "Pièce")!;
  const kilo = units.find((unit) => unit.name === "Kilogramme")!;
  const rice = (await post(owner, "/api/products", { sku: "RIZ", name: "Riz", unitId: piece.id, salePrice: 1500 })).body.product;
  const sugar = (await post(owner, "/api/products", { sku: "SUCRE", name: "Sucre", unitId: kilo.id, salePrice: 800 })).body.product;
  await post(owner, "/api/stock/adjustments", {
    shopId: shop.id,
    reason: "opening_balance",
    lines: [
      { productId: rice.id, quantity: 10, unitCost: 1000 },
      { productId: sugar.id, quantity: 5, unitCost: 600 },
    ],
  }).expect(201);

  const methods = await PaymentMethod.findAll({ where: { companyId: company.id } });
  const cash = methods.find((method) => method.code === "cash")!;
  const mobileMoney = methods.find((method) => method.code === "mobile_money")!;

  const cashierEmail = `cashier-${email}`;
  await addMember(company.id, cashierEmail, "cashier", { shopIds: [shop.id] });
  const cashier = await login(cashierEmail);
  const session = (await post(cashier, "/api/pos/sessions", { shopId: shop.id, openingFloat: 10000 }).expect(201)).body.session;

  return { company, shop, owner, cashier, rice, sugar, cash, mobileMoney, session };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
const riceSale = (ctx: Ctx, quantity = 2, payments?: object[]) => ({
  shopId: ctx.shop.id,
  lines: [{ productId: ctx.rice.id, quantity }],
  payments: payments ?? [{ methodId: ctx.cash.id, amount: 1500 * quantity }],
});

async function riceStock(ctx: Ctx) {
  return (await StockLevel.findOne({ where: { shopId: ctx.shop.id, productId: ctx.rice.id } }))!.quantity;
}

describe("Vente : préconditions", () => {
  it("exige une clé d'idempotence et une session de caisse ouverte", async () => {
    const ctx = await setup();

    await post(ctx.cashier, "/api/pos/sales", riceSale(ctx)).expect(400);

    await post(ctx.cashier, `/api/pos/sessions/${ctx.session.id}/close`, { countedCash: 10000 }).expect(200);
    const response = await sell(ctx.cashier, riceSale(ctx));
    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("Ouvrez une session de caisse avant de vendre");
  });

  it("une seule session ouverte par caissier et par boutique", async () => {
    const ctx = await setup();

    await post(ctx.cashier, "/api/pos/sessions", { shopId: ctx.shop.id, openingFloat: 0 }).expect(409);
  });
});

describe("Vente en espèces", () => {
  it("calcule le total côté serveur, rend la monnaie, décrémente le stock et fige le coût", async () => {
    const ctx = await setup();

    const response = await sell(ctx.cashier, {
      ...riceSale(ctx, 2, [{ methodId: ctx.cash.id, amount: 5000 }]),
      // Tentative d'imposer un total : ignorée (champ inconnu supprimé par la validation)
      total: 1,
    }).expect(201);

    const sale = response.body.sale;
    expect(sale).toMatchObject({
      number: `BTQ1-T-${YEAR}-000001`,
      status: "completed",
      subtotal: "3000.00",
      total: "3000.00",
      amountPaid: "3000.00",
      changeGiven: "2000.00",
      balanceDue: "0.00",
    });
    expect(sale.payments).toEqual([expect.objectContaining({ amount: "3000.00" })]);
    // Le caissier ne voit pas le coût d'achat ; il est bien figé en base
    expect(sale.lines[0].unitCost).toBeUndefined();
    expect((await get(ctx.owner, `/api/pos/sales/${sale.id}`)).body.sale.lines[0].unitCost).toBe("1000.0000");
    expect(await riceStock(ctx)).toBe("8.000");
  });

  it("vend au poids (2,5 kg de sucre) et arrondit à l'unité en FCFA", async () => {
    const ctx = await setup();

    const sale = (await sell(ctx.cashier, {
      shopId: ctx.shop.id,
      lines: [{ productId: ctx.sugar.id, quantity: "2.5" }],
      payments: [{ methodId: ctx.cash.id, amount: 2000 }],
    }).expect(201)).body.sale;

    expect(sale.total).toBe("2000.00");
  });

  it("paiement mixte : la monnaie n'est rendue que sur les espèces", async () => {
    const ctx = await setup();

    const mixed = (await sell(ctx.cashier, riceSale(ctx, 2, [
      { methodId: ctx.mobileMoney.id, amount: 1000, reference: "MM-889" },
      { methodId: ctx.cash.id, amount: 2500 },
    ])).expect(201)).body.sale;
    expect(mixed.changeGiven).toBe("500.00");
    expect(mixed.payments.map((payment: { amount: string }) => payment.amount).sort()).toEqual(["1000.00", "2000.00"]);

    // Trop payé en Mobile Money : impossible de rendre la monnaie
    await sell(ctx.cashier, riceSale(ctx, 1, [{ methodId: ctx.mobileMoney.id, amount: 5000 }])).expect(400);
  });

  it("stock insuffisant : rien n'est enregistré et aucun numéro n'est consommé", async () => {
    const ctx = await setup();

    const response = await sell(ctx.cashier, riceSale(ctx, 11));

    expect(response.status).toBe(409);
    expect(await Sale.count()).toBe(0);
    expect(await riceStock(ctx)).toBe("10.000");
    const next = (await sell(ctx.cashier, riceSale(ctx, 1)).expect(201)).body.sale;
    expect(next.number).toBe(`BTQ1-T-${YEAR}-000001`);
  });
});

describe("Concurrence et idempotence", () => {
  it("le dernier article ne peut pas être vendu deux fois", async () => {
    const ctx = await setup();
    // On ne garde que 3 riz en stock
    await post(ctx.owner, "/api/stock/adjustments", {
      shopId: ctx.shop.id,
      reason: "correction",
      lines: [{ productId: ctx.rice.id, quantity: -7 }],
    }).expect(201);

    const responses = await Promise.all([1, 2, 3, 4, 5].map(() => sell(ctx.cashier, riceSale(ctx, 1))));

    expect(responses.map((response) => response.status).sort()).toEqual([201, 201, 201, 409, 409]);
    expect(await riceStock(ctx)).toBe("0.000");
    const numbers = (await Sale.findAll({ order: [["number", "ASC"]] })).map((sale) => sale.number);
    expect(numbers).toEqual([1, 2, 3].map((n) => `BTQ1-T-${YEAR}-00000${n}`));
  });

  it("une vente rejouée après une coupure réseau n'est enregistrée qu'une fois", async () => {
    const ctx = await setup();
    const key = randomUUID();

    const first = await sell(ctx.cashier, riceSale(ctx, 2), key).expect(201);
    const replay = await sell(ctx.cashier, riceSale(ctx, 2), key).expect(201);

    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.sale.id).toBe(first.body.sale.id);
    expect(await Sale.count()).toBe(1);
    expect(await riceStock(ctx)).toBe("8.000");
  });
});

describe("Prix et remises (RB-10)", () => {
  it("un prix modifié en caisse exige l'accord d'un gérant, et il est tracé", async () => {
    const ctx = await setup();
    const body = { shopId: ctx.shop.id, lines: [{ productId: ctx.rice.id, quantity: 1, unitPrice: 1200 }], payments: [{ methodId: ctx.cash.id, amount: 1200 }] };

    await sell(ctx.cashier, body).expect(403);
    // Le propriétaire n'a pas de session ouverte : il en ouvre une
    await post(ctx.owner, "/api/pos/sessions", { shopId: ctx.shop.id, openingFloat: 0 }).expect(201);
    const sale = (await sell(ctx.owner, body).expect(201)).body.sale;

    expect(sale.total).toBe("1200.00");
    const log = await AuditLog.findOne({ where: { action: "sale.create", entityId: sale.id } });
    expect(log?.after).toMatchObject({ priceOverrides: [{ catalogPrice: "1500.00", appliedPrice: "1200.00" }] });
  });

  it("le caissier accorde une remise dans la limite fixée par l'entreprise", async () => {
    const ctx = await setup();
    const withDiscount = (percent: number) => ({
      shopId: ctx.shop.id,
      lines: [{ productId: ctx.rice.id, quantity: 2 }],
      discount: { type: "percent", value: percent },
      payments: [{ methodId: ctx.cash.id, amount: 3000 }],
    });

    // Par défaut : aucune remise sans accord
    await sell(ctx.cashier, withDiscount(10)).expect(403);

    await patch(ctx.owner, "/api/company", { settings: { maxCashierDiscountPercent: 10 } }).expect(200);
    const sale = (await sell(ctx.cashier, withDiscount(10)).expect(201)).body.sale;
    expect(sale).toMatchObject({ subtotal: "3000.00", discountTotal: "300.00", total: "2700.00", changeGiven: "300.00" });
    await sell(ctx.cashier, withDiscount(15)).expect(403);
  });

  it("la remise du ticket est répartie sur les lignes, au franc près", async () => {
    const ctx = await setup();
    await Company.update({ settings: { maxCashierDiscountPercent: 100 } }, { where: { id: ctx.company.id } });

    const sale = (await sell(ctx.cashier, {
      shopId: ctx.shop.id,
      lines: [
        { productId: ctx.rice.id, quantity: 1 },
        { productId: ctx.sugar.id, quantity: 1, discount: { type: "amount", value: 100 } },
      ],
      discount: { type: "amount", value: 1000 },
      payments: [{ methodId: ctx.cash.id, amount: 1200 }],
    }).expect(201)).body.sale;

    // 1 500 + 800 − 100 = 2 200, puis −1 000 réparti : total 1 200
    expect(sale.total).toBe("1200.00");
    const lineTotals = sale.lines.map((line: { lineTotal: string }) => Number(line.lineTotal));
    expect(lineTotals.reduce((a: number, b: number) => a + b, 0)).toBe(1200);
  });
});

describe("Vente à crédit et compte client", () => {
  it("le reste dû passe au compte du client, dans la limite de son plafond", async () => {
    const ctx = await setup();
    // Sans client : refusé
    await sell(ctx.cashier, riceSale(ctx, 2, [{ methodId: ctx.cash.id, amount: 1000 }])).expect(400);

    const customer = (await post(ctx.cashier, "/api/customers", { name: "Awa Diallo", phone: "+221 77 000 00 01" }).expect(201)).body
      .customer;
    const credit = { ...riceSale(ctx, 2, [{ methodId: ctx.cash.id, amount: 1000 }]), customerId: customer.id };
    // Client sans crédit autorisé
    await sell(ctx.cashier, credit).expect(400);
    // Le caissier ne fixe pas lui-même un plafond de crédit
    await patch(ctx.cashier, `/api/customers/${customer.id}`, { creditLimit: 5000 }).expect(403);
    await patch(ctx.owner, `/api/customers/${customer.id}`, { creditLimit: 5000 }).expect(200);

    const sale = (await sell(ctx.cashier, credit).expect(201)).body.sale;
    expect(sale).toMatchObject({ total: "3000.00", amountPaid: "1000.00", balanceDue: "2000.00" });
    expect((await Customer.findByPk(customer.id))?.balance).toBe("2000.00");
    expect(await CustomerLedgerEntry.count({ where: { customerId: customer.id, type: "sale_credit" } })).toBe(1);

    // Il reste 3 000 de crédit : une vente à crédit de 4 500 est refusée
    const tooMuch = await sell(ctx.cashier, { ...riceSale(ctx, 3, []), customerId: customer.id });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.message).toBe("Plafond de crédit dépassé (disponible : 3000.00)");
  });

  it("téléphone client unique (espaces ignorés)", async () => {
    const ctx = await setup();
    await post(ctx.cashier, "/api/customers", { name: "Client 1", phone: "+221 77 111 22 33" }).expect(201);

    await post(ctx.cashier, "/api/customers", { name: "Client 2", phone: "+221771112233" }).expect(409);
  });
});

describe("Session de caisse : clôture et écart (RB-08)", () => {
  it("calcule les espèces attendues et enregistre l'écart du comptage", async () => {
    const ctx = await setup();
    await sell(ctx.cashier, riceSale(ctx, 2, [{ methodId: ctx.cash.id, amount: 5000 }])).expect(201);
    await sell(ctx.cashier, riceSale(ctx, 1, [{ methodId: ctx.mobileMoney.id, amount: 1500 }])).expect(201);

    const current = (await get(ctx.cashier, `/api/pos/sessions/current?shopId=${ctx.shop.id}`).expect(200)).body.session;
    // Fond 10 000 + 3 000 encaissés en espèces (la monnaie rendue n'est pas comptée)
    expect(current.summary).toMatchObject({ salesCount: 2, salesTotal: "4500.00", expectedCash: "13000.00" });

    const closed = (await post(ctx.cashier, `/api/pos/sessions/${ctx.session.id}/close`, { countedCash: 12500 }).expect(200)).body
      .session;
    expect(closed).toMatchObject({ status: "closed", expectedCash: "13000.00", countedCash: "12500.00", difference: "-500.00" });
    expect(await AuditLog.count({ where: { action: "cash_session.close_with_difference" } })).toBe(1);
    await post(ctx.cashier, `/api/pos/sessions/${ctx.session.id}/close`, { countedCash: 1 }).expect(409);
  });
});

describe("Annulation et retours", () => {
  it("annulation : stock restitué, argent et crédit compensés, réservée au gérant", async () => {
    const ctx = await setup();
    await patch(ctx.owner, "/api/company", { settings: {} });
    const sale = (await sell(ctx.cashier, riceSale(ctx, 2)).expect(201)).body.sale;

    await post(ctx.cashier, `/api/pos/sales/${sale.id}/cancel`, { reason: "Erreur de saisie" }).expect(403);
    const cancelled = (await post(ctx.owner, `/api/pos/sales/${sale.id}/cancel`, { reason: "Erreur de saisie" }).expect(200)).body
      .sale;

    expect(cancelled.status).toBe("cancelled");
    expect(await riceStock(ctx)).toBe("10.000");
    const summary = (await get(ctx.cashier, `/api/pos/sessions/${ctx.session.id}`)).body.session.summary;
    expect(summary).toMatchObject({ salesCount: 0, expectedCash: "10000.00" });
    await post(ctx.owner, `/api/pos/sales/${sale.id}/cancel`, { reason: "Encore" }).expect(409);
  });

  it("après la clôture de la caisse, on ne peut plus annuler : on fait un retour", async () => {
    const ctx = await setup();
    const sale = (await sell(ctx.cashier, riceSale(ctx, 2)).expect(201)).body.sale;
    await post(ctx.cashier, `/api/pos/sessions/${ctx.session.id}/close`, { countedCash: 13000 });

    await post(ctx.owner, `/api/pos/sales/${sale.id}/cancel`, { reason: "Trop tard" }).expect(409);
  });

  it("retour partiel remboursé en espèces, au prix payé ; article abîmé non réintégré", async () => {
    const ctx = await setup();
    await post(ctx.owner, "/api/pos/sessions", { shopId: ctx.shop.id, openingFloat: 5000 }).expect(201);
    const sale = (await sell(ctx.cashier, riceSale(ctx, 3, [{ methodId: ctx.cash.id, amount: 4500 }])).expect(201)).body.sale;
    const line = sale.lines[0];

    const back = (await refund(ctx.owner, {
      saleId: sale.id,
      reason: "Client mécontent",
      lines: [{ saleLineId: line.id, quantity: 1, restock: true }],
      refundTo: "method",
      refundMethodId: ctx.cash.id,
    }).expect(201)).body.return;
    expect(back).toMatchObject({ number: `BTQ1-RT-${YEAR}-000001`, refundAmount: "1500.00" });
    expect(await riceStock(ctx)).toBe("8.000");

    // Article abîmé : remboursé mais pas remis en vente
    await refund(ctx.owner, {
      saleId: sale.id,
      reason: "Sac percé",
      lines: [{ saleLineId: line.id, quantity: 1, restock: false }],
      refundTo: "method",
      refundMethodId: ctx.cash.id,
    }).expect(201);
    expect(await riceStock(ctx)).toBe("8.000");

    // Il ne reste qu'un riz retournable
    await refund(ctx.owner, {
      saleId: sale.id,
      reason: "Encore",
      lines: [{ saleLineId: line.id, quantity: 2, restock: true }],
      refundTo: "method",
      refundMethodId: ctx.cash.id,
    }).expect(400);
    // Une vente partiellement retournée ne s'annule plus
    await post(ctx.owner, `/api/pos/sales/${sale.id}/cancel`, { reason: "Annuler" }).expect(409);
  });

  it("retour remboursé sur le compte du client : sa dette diminue", async () => {
    const ctx = await setup();
    const customer = (await post(ctx.owner, "/api/customers", { name: "Moussa", creditLimit: 10000 })).body.customer;
    const sale = (await sell(ctx.cashier, { ...riceSale(ctx, 2, []), customerId: customer.id }).expect(201)).body.sale;
    expect((await Customer.findByPk(customer.id))?.balance).toBe("3000.00");

    await refund(ctx.owner, {
      saleId: sale.id,
      reason: "Retour",
      lines: [{ saleLineId: sale.lines[0].id, quantity: 1 }],
      refundTo: "customer_account",
    }).expect(201);

    expect((await Customer.findByPk(customer.id))?.balance).toBe("1500.00");
    const ledger = (await get(ctx.owner, `/api/customers/${customer.id}/ledger`)).body;
    expect(ledger.items.map((entry: { type: string }) => entry.type)).toEqual(["return_credit", "sale_credit"]);
  });
});

describe("Ticket de caisse", () => {
  it("fournit les données et une version texte 80 mm", async () => {
    const ctx = await setup();
    const sale = (await sell(ctx.cashier, riceSale(ctx, 2, [{ methodId: ctx.cash.id, amount: 5000 }]))).body.sale;

    const ticket = (await get(ctx.cashier, `/api/pos/sales/${sale.id}/ticket`).expect(200)).body.ticket;
    expect(ticket).toMatchObject({ number: sale.number, total: "3000.00", changeGiven: "2000.00", currency: "XOF" });

    const text = (await get(ctx.cashier, `/api/pos/sales/${sale.id}/ticket?format=text`).expect(200)).text;
    expect(text).toContain(`Ticket ${sale.number}`);
    expect(text).toMatch(/TOTAL FCFA\s+3 000/);
    expect(text).toMatch(/Monnaie rendue\s+2 000/);
    expect(text.split("\n").every((line) => line.length <= 42)).toBe(true);
  });
});

describe("Isolation de la caisse entre entreprises (RB-01)", () => {
  it("ventes, sessions, clients et moyens de paiement de A inaccessibles depuis B", async () => {
    const a = await setup("Commerce A", "owner-a@test.com");
    const b = await setup("Commerce B", "owner-b@test.com");
    const saleA = (await sell(a.cashier, riceSale(a, 1)).expect(201)).body.sale;
    const customerA = (await post(a.owner, "/api/customers", { name: "Client A", creditLimit: 5000 })).body.customer;

    await get(b.owner, `/api/pos/sales/${saleA.id}`).expect(404);
    await get(b.owner, `/api/pos/sales/${saleA.id}/ticket`).expect(404);
    await post(b.owner, `/api/pos/sales/${saleA.id}/cancel`, { reason: "Piratage" }).expect(404);
    await get(b.owner, `/api/pos/sessions/${a.session.id}`).expect(404);
    await get(b.owner, `/api/customers/${customerA.id}`).expect(404);
    await refund(b.owner, {
      saleId: saleA.id,
      reason: "Piratage",
      lines: [{ saleLineId: saleA.lines[0].id, quantity: 1 }],
      refundTo: "method",
      refundMethodId: b.cash.id,
    }).expect(404);

    // Produit, moyen de paiement ou client de A dans une vente de B
    await sell(b.cashier, { shopId: b.shop.id, lines: [{ productId: a.rice.id, quantity: 1 }], payments: [{ methodId: b.cash.id, amount: 1500 }] }).expect(400);
    await sell(b.cashier, { ...riceSale(b, 1, [{ methodId: a.cash.id, amount: 1500 }]) }).expect(400);
    await sell(b.cashier, { ...riceSale(b, 1, []), customerId: customerA.id }).expect(400);
    await post(b.cashier, "/api/pos/sessions", { shopId: a.shop.id, openingFloat: 0 }).expect(404);

    expect((await get(b.owner, "/api/pos/sales")).body.total).toBe(0);
  });
});
