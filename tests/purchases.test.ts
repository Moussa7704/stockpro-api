import { describe, expect, it } from "vitest";
import { AuditLog, StockLevel, StockMovement, Unit } from "../src/models/index.js";
import { addMember, api, bearer, createCompany, login, type Session } from "./helpers/auth.js";

const YEAR = new Date().getUTCFullYear();

const post = (session: Session, path: string, body: object = {}, idempotencyKey?: string) => {
  const call = api().post(path).set("Authorization", bearer(session));
  return (idempotencyKey ? call.set("Idempotency-Key", idempotencyKey) : call).send(body);
};
const patch = (session: Session, path: string, body: object) =>
  api().patch(path).set("Authorization", bearer(session)).send(body);
const get = (session: Session, path: string) => api().get(path).set("Authorization", bearer(session));

async function setup(name = "Commerce A", email = "owner@test.com") {
  const { company, shop } = await createCompany(name, email);
  const session = await login(email);
  const piece = (await Unit.findOne({ where: { companyId: company.id, name: "Pièce" } }))!;
  const rice = (await post(session, "/api/products", { sku: "RIZ", name: "Riz", unitId: piece.id, salePrice: 1500 })).body
    .product;
  const oil = (await post(session, "/api/products", { sku: "HUILE", name: "Huile", unitId: piece.id, salePrice: 2500 })).body
    .product;
  const supplier = (await post(session, "/api/suppliers", { name: "Grossiste Dakar" })).body.supplier;
  return { company, shop, session, rice, oil, supplier };
}

async function stockOf(shopId: string, productId: string) {
  return StockLevel.findOne({ where: { shopId, productId } });
}

/** Commande envoyée : 10 riz à 1000 et 5 huiles à 2000. */
async function sentOrder(ctx: Awaited<ReturnType<typeof setup>>) {
  const order = (await post(ctx.session, "/api/purchases/orders", {
    shopId: ctx.shop.id,
    supplierId: ctx.supplier.id,
    lines: [
      { productId: ctx.rice.id, quantity: 10, unitCost: 1000 },
      { productId: ctx.oil.id, quantity: 5, unitCost: 2000 },
    ],
  }).expect(201)).body.order;
  await post(ctx.session, `/api/purchases/orders/${order.id}/send`).expect(200);
  return order;
}

describe("Bons de commande", () => {
  it("calcule les totaux en décimal exact et n'augmente jamais le stock", async () => {
    const ctx = await setup();

    const order = await sentOrder(ctx);

    expect(order).toMatchObject({ number: `BTQ1-BC-${YEAR}-000001`, status: "draft", total: "20000.00" });
    expect(order.lines.find((line: { productId: string }) => line.productId === ctx.rice.id)).toMatchObject({
      quantityOrdered: "10.000",
      lineTotal: "10000.00",
      quantityRemaining: "10.000",
    });
    expect(await stockOf(ctx.shop.id, ctx.rice.id)).toBeNull();
    expect(await StockMovement.count()).toBe(0);
  });

  it("seul un brouillon se modifie ; refuse les centimes en FCFA", async () => {
    const ctx = await setup();
    const draft = (await post(ctx.session, "/api/purchases/orders", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      lines: [{ productId: ctx.rice.id, quantity: 2, unitCost: 1000 }],
    })).body.order;

    const updated = await patch(ctx.session, `/api/purchases/orders/${draft.id}`, {
      lines: [{ productId: ctx.rice.id, quantity: 3, unitCost: 1100 }],
    }).expect(200);
    expect(updated.body.order.total).toBe("3300.00");

    await patch(ctx.session, `/api/purchases/orders/${draft.id}`, {
      lines: [{ productId: ctx.rice.id, quantity: 3, unitCost: "1100.50" }],
    }).expect(400);
    await post(ctx.session, `/api/purchases/orders/${draft.id}/send`).expect(200);
    await patch(ctx.session, `/api/purchases/orders/${draft.id}`, { notes: "trop tard" }).expect(409);
  });

  it("refuse un fournisseur archivé", async () => {
    const ctx = await setup();
    await patch(ctx.session, `/api/suppliers/${ctx.supplier.id}`, { archived: true });

    await post(ctx.session, "/api/purchases/orders", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      lines: [{ productId: ctx.rice.id, quantity: 1, unitCost: 1000 }],
    }).expect(400);
  });
});

describe("Réceptions (RB-06)", () => {
  it("livraison partielle puis complète : stock, coût moyen et statut de commande", async () => {
    const ctx = await setup();
    const order = await sentOrder(ctx);
    const riceLine = order.lines.find((line: { productId: string }) => line.productId === ctx.rice.id);

    // 1re livraison : 4 riz seulement
    const first = (await post(ctx.session, "/api/purchases/receipts", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      orderId: order.id,
      supplierReference: "BL-778",
      lines: [{ productId: ctx.rice.id, quantity: 4, unitCost: 1000, orderLineId: riceLine.id }],
    }).expect(201)).body.receipt;
    expect(first).toMatchObject({ number: `BTQ1-REC-${YEAR}-000001`, status: "draft", total: "4000.00" });
    // Brouillon : pas encore de stock
    expect(await stockOf(ctx.shop.id, ctx.rice.id)).toBeNull();

    await post(ctx.session, `/api/purchases/receipts/${first.id}/validate`).expect(200);
    expect(await stockOf(ctx.shop.id, ctx.rice.id)).toMatchObject({ quantity: "4.000", averageCost: "1000.0000" });
    let current = (await get(ctx.session, `/api/purchases/orders/${order.id}`)).body.order;
    expect(current.status).toBe("partially_received");

    // 2e livraison sans détail : tout le reste, au coût de la commande
    const rest = (await post(ctx.session, "/api/purchases/receipts", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      orderId: order.id,
    }).expect(201)).body.receipt;
    expect(rest.lines).toHaveLength(2);
    await post(ctx.session, `/api/purchases/receipts/${rest.id}/validate`).expect(200);

    current = (await get(ctx.session, `/api/purchases/orders/${order.id}`)).body.order;
    expect(current.status).toBe("received");
    expect(await stockOf(ctx.shop.id, ctx.rice.id)).toMatchObject({ quantity: "10.000" });
    expect(await stockOf(ctx.shop.id, ctx.oil.id)).toMatchObject({ quantity: "5.000", averageCost: "2000.0000" });
    expect(await StockMovement.count({ where: { type: "purchase_receipt" } })).toBe(3);
  });

  it("met à jour le coût moyen pondéré avec le prix réellement payé", async () => {
    const ctx = await setup();
    for (const unitCost of [1000, 1300]) {
      const receipt = (await post(ctx.session, "/api/purchases/receipts", {
        shopId: ctx.shop.id,
        supplierId: ctx.supplier.id,
        lines: [{ productId: ctx.rice.id, quantity: 10, unitCost }],
      })).body.receipt;
      await post(ctx.session, `/api/purchases/receipts/${receipt.id}/validate`).expect(200);
    }

    expect((await stockOf(ctx.shop.id, ctx.rice.id))?.averageCost).toBe("1150.0000");
  });

  it("refuse de recevoir plus que la quantité commandée", async () => {
    const ctx = await setup();
    const order = await sentOrder(ctx);
    const riceLine = order.lines.find((line: { productId: string }) => line.productId === ctx.rice.id);

    const receipt = (await post(ctx.session, "/api/purchases/receipts", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      orderId: order.id,
      lines: [{ productId: ctx.rice.id, quantity: 11, unitCost: 1000, orderLineId: riceLine.id }],
    })).body.receipt;

    await post(ctx.session, `/api/purchases/receipts/${receipt.id}/validate`).expect(400);
    expect(await stockOf(ctx.shop.id, ctx.rice.id)).toBeNull();
  });

  it("une validation rejouée avec la même clé d'idempotence ne reçoit pas deux fois", async () => {
    const ctx = await setup();
    const receipt = (await post(ctx.session, "/api/purchases/receipts", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      lines: [{ productId: ctx.rice.id, quantity: 6, unitCost: 1000 }],
    })).body.receipt;
    const key = "reception-abc-123";

    const first = await post(ctx.session, `/api/purchases/receipts/${receipt.id}/validate`, {}, key).expect(200);
    const replay = await post(ctx.session, `/api/purchases/receipts/${receipt.id}/validate`, {}, key).expect(200);

    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect((await stockOf(ctx.shop.id, ctx.rice.id))?.quantity).toBe("6.000");
    // Sans la clé, la 2e validation est refusée (déjà validée), sans rien changer
    await post(ctx.session, `/api/purchases/receipts/${receipt.id}/validate`).expect(409);
  });

  it("une clé d'idempotence réutilisée pour une autre opération est refusée", async () => {
    const ctx = await setup();
    const make = async () =>
      (await post(ctx.session, "/api/purchases/receipts", {
        shopId: ctx.shop.id,
        supplierId: ctx.supplier.id,
        lines: [{ productId: ctx.rice.id, quantity: 1, unitCost: 1000 }],
      })).body.receipt;
    const a = await make();
    const b = await make();

    await post(ctx.session, `/api/purchases/receipts/${a.id}/validate`, {}, "meme-cle-123").expect(200);
    await post(ctx.session, `/api/purchases/receipts/${b.id}/validate`, {}, "meme-cle-123").expect(422);
  });

  it("une commande partiellement reçue se clôture (pas d'annulation) et n'attend plus rien", async () => {
    const ctx = await setup();
    const order = await sentOrder(ctx);
    // Ligne saisie sans orderLineId : rattachée automatiquement à la ligne "huile" de la commande
    const partial = (await post(ctx.session, "/api/purchases/receipts", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      orderId: order.id,
      lines: [{ productId: ctx.oil.id, quantity: 1, unitCost: 2000 }],
    })).body.receipt;
    await post(ctx.session, `/api/purchases/receipts/${partial.id}/validate`).expect(200);

    const current = (await get(ctx.session, `/api/purchases/orders/${order.id}`)).body.order;
    expect(current.status).toBe("partially_received");
    expect(current.lines.find((line: { productId: string }) => line.productId === ctx.oil.id).quantityRemaining).toBe("4.000");

    await post(ctx.session, `/api/purchases/orders/${order.id}/cancel`).expect(409);
    await post(ctx.session, `/api/purchases/orders/${order.id}/close`).expect(200);
    await post(ctx.session, "/api/purchases/receipts", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      orderId: order.id,
    }).expect(409);
  });

  it("une commande seulement envoyée peut être annulée", async () => {
    const ctx = await setup();
    const order = await sentOrder(ctx);

    await post(ctx.session, `/api/purchases/orders/${order.id}/cancel`).expect(200);
  });
});

describe("Retours fournisseurs", () => {
  it("sort le stock à la validation, valorisé au coût moyen, jamais sous zéro", async () => {
    const ctx = await setup();
    const receipt = (await post(ctx.session, "/api/purchases/receipts", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      lines: [{ productId: ctx.rice.id, quantity: 5, unitCost: 1200 }],
    })).body.receipt;
    await post(ctx.session, `/api/purchases/receipts/${receipt.id}/validate`);

    const tooMuch = (await post(ctx.session, "/api/purchases/returns", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      reason: "Erreur de quantité",
      lines: [{ productId: ctx.rice.id, quantity: 6 }],
    }).expect(201)).body.return;
    await post(ctx.session, `/api/purchases/returns/${tooMuch.id}/validate`).expect(409);

    const ok = (await post(ctx.session, "/api/purchases/returns", {
      shopId: ctx.shop.id,
      supplierId: ctx.supplier.id,
      receiptId: receipt.id,
      reason: "Sacs abîmés",
      lines: [{ productId: ctx.rice.id, quantity: 2 }],
    })).body.return;
    const validated = (await post(ctx.session, `/api/purchases/returns/${ok.id}/validate`).expect(200)).body.return;

    expect(validated).toMatchObject({ number: `BTQ1-RF-${YEAR}-000002`, status: "validated", total: "2400.00" });
    expect((await stockOf(ctx.shop.id, ctx.rice.id))?.quantity).toBe("3.000");
  });
});

describe("Factures et paiements fournisseurs", () => {
  function invoice(ctx: Awaited<ReturnType<typeof setup>>, body: object = {}) {
    return post(ctx.session, "/api/purchases/invoices", {
      supplierId: ctx.supplier.id,
      reference: "FAC-2026-001",
      invoiceDate: "2026-10-01",
      dueDate: "2026-10-31",
      total: 50000,
      ...body,
    });
  }

  it("paiements partiels jusqu'au solde, jamais au-delà du reste dû", async () => {
    const ctx = await setup();
    const created = (await invoice(ctx).expect(201)).body.invoice;
    expect(created).toMatchObject({ status: "unpaid", remaining: "50000.00" });

    const partial = (await post(ctx.session, `/api/purchases/invoices/${created.id}/payments`, {
      amount: 20000,
      method: "mobile_money",
    }).expect(201)).body.invoice;
    expect(partial).toMatchObject({ status: "partially_paid", amountPaid: "20000.00", remaining: "30000.00" });

    await post(ctx.session, `/api/purchases/invoices/${created.id}/payments`, { amount: 30001, method: "cash" }).expect(400);
    const paid = (await post(ctx.session, `/api/purchases/invoices/${created.id}/payments`, {
      amount: 30000,
      method: "bank_transfer",
    }).expect(201)).body.invoice;
    expect(paid).toMatchObject({ status: "paid", remaining: "0.00" });
    expect(paid.payments).toHaveLength(2);
    await post(ctx.session, `/api/purchases/invoices/${created.id}/payments`, { amount: 1, method: "cash" }).expect(409);
    expect(await AuditLog.count({ where: { action: "supplier_payment.create" } })).toBe(2);
  });

  it("deux paiements simultanés ne dépassent jamais le total", async () => {
    const ctx = await setup();
    const created = (await invoice(ctx, { total: 10000 })).body.invoice;

    const responses = await Promise.all(
      [1, 2, 3].map(() => post(ctx.session, `/api/purchases/invoices/${created.id}/payments`, { amount: 6000, method: "cash" })),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([201, 400, 400]);
    const final = (await get(ctx.session, `/api/purchases/invoices/${created.id}`)).body.invoice;
    expect(final.amountPaid).toBe("6000.00");
  });

  it("un paiement rejoué avec la même clé n'est enregistré qu'une fois", async () => {
    const ctx = await setup();
    const created = (await invoice(ctx)).body.invoice;

    await post(ctx.session, `/api/purchases/invoices/${created.id}/payments`, { amount: 5000, method: "cash" }, "paiement-xyz-1").expect(201);
    await post(ctx.session, `/api/purchases/invoices/${created.id}/payments`, { amount: 5000, method: "cash" }, "paiement-xyz-1").expect(201);

    const final = (await get(ctx.session, `/api/purchases/invoices/${created.id}`)).body.invoice;
    expect(final.payments).toHaveLength(1);
    expect(final.amountPaid).toBe("5000.00");
  });

  it("référence unique par fournisseur, annulation sans paiement, dettes et retards", async () => {
    const ctx = await setup();
    const late = (await invoice(ctx, { reference: "OLD-1", invoiceDate: "2020-01-01", dueDate: "2020-02-01", total: 7000 })).body
      .invoice;
    await invoice(ctx, { reference: "old-1" }).expect(409);
    const toCancel = (await invoice(ctx, { reference: "ERREUR", dueDate: null, total: 999 })).body.invoice;
    await post(ctx.session, `/api/purchases/invoices/${toCancel.id}/cancel`).expect(200);

    expect(late.overdue).toBe(true);
    expect((await get(ctx.session, "/api/purchases/invoices?overdue=true")).body.total).toBe(1);
    const balances = (await get(ctx.session, "/api/purchases/supplier-balances").expect(200)).body.balances;
    expect(balances).toEqual([
      expect.objectContaining({ outstanding: "7000.00", overdue: "7000.00", openInvoices: 1 }),
    ]);
  });

  it("les factures sont réservées à supplier_payments.manage", async () => {
    const ctx = await setup();
    await addMember(ctx.company.id, "stock@test.com", "stock_keeper", { allShops: true });
    await addMember(ctx.company.id, "compta@test.com", "accountant");
    const keeper = await login("stock@test.com");
    const accountant = await login("compta@test.com");

    // Le gestionnaire de stock gère les achats mais pas les paiements ; le comptable l'inverse
    await get(keeper, "/api/purchases/orders").expect(200);
    await get(keeper, "/api/purchases/invoices").expect(403);
    await get(accountant, "/api/purchases/invoices").expect(200);
    await get(accountant, "/api/purchases/orders").expect(403);
  });
});

describe("Isolation des achats entre entreprises (RB-01)", () => {
  it("documents et dettes de A introuvables ou inutilisables depuis B", async () => {
    const a = await setup("Commerce A", "owner-a@test.com");
    const b = await setup("Commerce B", "owner-b@test.com");
    const orderA = await sentOrder(a);
    const invoiceA = (await post(a.session, "/api/purchases/invoices", {
      supplierId: a.supplier.id,
      reference: "A-1",
      invoiceDate: "2026-10-01",
      total: 1000,
    })).body.invoice;

    await get(b.session, `/api/purchases/orders/${orderA.id}`).expect(404);
    await post(b.session, `/api/purchases/orders/${orderA.id}/cancel`).expect(404);
    await get(b.session, `/api/purchases/invoices/${invoiceA.id}`).expect(404);
    await post(b.session, `/api/purchases/invoices/${invoiceA.id}/payments`, { amount: 1, method: "cash" }).expect(404);

    // Fournisseur, commande ou produit de A utilisés depuis B
    await post(b.session, "/api/purchases/orders", {
      shopId: b.shop.id,
      supplierId: a.supplier.id,
      lines: [{ productId: b.rice.id, quantity: 1, unitCost: 1000 }],
    }).expect(400);
    await post(b.session, "/api/purchases/receipts", {
      shopId: b.shop.id,
      supplierId: b.supplier.id,
      orderId: orderA.id,
    }).expect(400);
    await post(b.session, "/api/purchases/receipts", {
      shopId: b.shop.id,
      supplierId: b.supplier.id,
      lines: [{ productId: a.rice.id, quantity: 1, unitCost: 1000 }],
    }).expect(400);

    expect((await get(b.session, "/api/purchases/orders")).body.total).toBe(0);
    expect((await get(b.session, "/api/purchases/supplier-balances")).body.balances).toHaveLength(0);
  });
});
