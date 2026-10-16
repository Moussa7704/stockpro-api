import { describe, expect, it } from "vitest";
import { sequelize } from "../src/config/database.js";
import { AuditLog, StockAdjustment, StockLevel, StockMovement, Unit } from "../src/models/index.js";
import { addMember, api, bearer, createCompany, createShop, login, type Session } from "./helpers/auth.js";

const YEAR = new Date().getUTCFullYear();

const post = (session: Session, path: string, body: object = {}) =>
  api().post(path).set("Authorization", bearer(session)).send(body);
const put = (session: Session, path: string, body: object) =>
  api().put(path).set("Authorization", bearer(session)).send(body);
const get = (session: Session, path: string) => api().get(path).set("Authorization", bearer(session));

/** Entreprise + propriétaire + 2 produits (riz à la pièce, sucre au kilo) + une 2e boutique. */
async function setup(name = "Commerce A", email = "owner@test.com") {
  const { company, shop } = await createCompany(name, email);
  const session = await login(email);
  const units = await Unit.findAll({ where: { companyId: company.id } });
  const piece = units.find((unit) => unit.name === "Pièce")!;
  const kilo = units.find((unit) => unit.name === "Kilogramme")!;
  const rice = (
    await post(session, "/api/products", { sku: "RIZ", name: "Riz", unitId: piece.id, salePrice: 1500, alertThreshold: 5 })
  ).body.product;
  const sugar = (await post(session, "/api/products", { sku: "SUCRE", name: "Sucre", unitId: kilo.id, salePrice: 800 }))
    .body.product;
  const shop2 = await createShop(company.id, "BTQ2");
  return { company, shop, shop2, session, rice, sugar };
}

const adjust = (session: Session, shopId: string, lines: object[], reason = "opening_balance") =>
  post(session, "/api/stock/adjustments", { shopId, reason, lines });

async function level(shopId: string, productId: string) {
  return StockLevel.findOne({ where: { shopId, productId } });
}

describe("Ajustements et coût moyen pondéré", () => {
  it("le stock d'ouverture crée un solde valorisé et une pièce numérotée", async () => {
    const { session, shop, rice } = await setup();

    const response = await adjust(session, shop.id, [{ productId: rice.id, quantity: 10, unitCost: 1000 }]).expect(201);

    expect(response.body.adjustment).toMatchObject({
      number: `BTQ1-AJ-${YEAR}-000001`,
      reason: "opening_balance",
      lines: [{ quantity: "10.000", balanceAfter: "10.000" }],
    });
    expect(await level(shop.id, rice.id)).toMatchObject({ quantity: "10.000", averageCost: "1000.0000" });
    expect(await AuditLog.count({ where: { action: "stock.adjust" } })).toBe(1);
  });

  it("calcule le coût moyen pondéré en décimal exact et fige le coût des sorties", async () => {
    const { session, shop, rice } = await setup();
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 10, unitCost: 1000 }]);
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 20, unitCost: 1600 }]);

    // (10 × 1000 + 20 × 1600) / 30 = 1400
    expect((await level(shop.id, rice.id))?.averageCost).toBe("1400.0000");

    await adjust(session, shop.id, [{ productId: rice.id, quantity: -3 }], "damage").expect(201);
    const exit = await StockMovement.findOne({ where: { quantity: "-3.000" } });
    expect(exit).toMatchObject({ unitCost: "1400.0000", balanceAfter: "27.000" });
    // Une sortie ne change pas le coût moyen
    expect((await level(shop.id, rice.id))?.averageCost).toBe("1400.0000");
  });

  it("refuse de passer sous zéro : rien n'est enregistré et aucun numéro n'est consommé", async () => {
    const { session, shop, rice } = await setup();
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 2, unitCost: 1000 }]);

    const response = await adjust(session, shop.id, [{ productId: rice.id, quantity: -5 }], "loss");

    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("Stock insuffisant pour « Riz »");
    expect((await level(shop.id, rice.id))?.quantity).toBe("2.000");
    expect(await StockMovement.count()).toBe(1);
    // Le numéro 2 n'a pas été "brûlé" par l'échec
    const next = await adjust(session, shop.id, [{ productId: rice.id, quantity: -1 }], "loss").expect(201);
    expect(next.body.adjustment.number).toBe(`BTQ1-AJ-${YEAR}-000002`);
  });

  it("respecte l'unité : pas de demi-pièce, mais 2,5 kg de sucre", async () => {
    const { session, shop, rice, sugar } = await setup();

    await adjust(session, shop.id, [{ productId: rice.id, quantity: "2.5" }]).expect(400);
    await adjust(session, shop.id, [{ productId: sugar.id, quantity: "2.5", unitCost: 700 }]).expect(201);
  });

  it("refuse un coût unitaire sur une sortie et un produit en double", async () => {
    const { session, shop, rice } = await setup();

    await adjust(session, shop.id, [{ productId: rice.id, quantity: -1, unitCost: 1000 }], "loss").expect(400);
    await adjust(session, shop.id, [
      { productId: rice.id, quantity: 1 },
      { productId: rice.id, quantity: 2 },
    ]).expect(400);
  });
});

describe("Concurrence et intégrité", () => {
  it("des sorties simultanées ne rendent jamais le stock négatif", async () => {
    const { session, shop, rice } = await setup();
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 5, unitCost: 1000 }]);

    // 5 sorties de 2 en même temps sur un stock de 5 : seules 2 peuvent passer
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map(() => adjust(session, shop.id, [{ productId: rice.id, quantity: -2 }], "loss")),
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 201, 409, 409, 409]);
    expect((await level(shop.id, rice.id))?.quantity).toBe("1.000");
    // Les numéros des 2 ajustements réussis se suivent sans trou
    const numbers = (await StockAdjustment.findAll({ order: [["number", "ASC"]] })).map((item) => item.number);
    expect(numbers).toEqual([1, 2, 3].map((n) => `BTQ1-AJ-${YEAR}-00000${n}`));
  });

  it("le journal des mouvements est en ajout seul, même en SQL direct", async () => {
    const { session, shop, rice } = await setup();
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 5, unitCost: 1000 }]);

    await expect(sequelize.query("UPDATE stock_movements SET quantity = 999")).rejects.toThrow(/ajout seul/);
    await expect(sequelize.query("DELETE FROM stock_movements")).rejects.toThrow(/ajout seul/);
  });
});

describe("Consultation, coûts et alertes", () => {
  it("le propriétaire voit les coûts, le caissier seulement les quantités", async () => {
    const { session, company, shop, rice } = await setup();
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 10, unitCost: 1000 }]);
    await addMember(company.id, "cashier@test.com", "cashier", { shopIds: [shop.id] });
    const cashier = await login("cashier@test.com");

    const owner = (await get(session, "/api/stock").expect(200)).body.items[0];
    expect(owner).toMatchObject({ quantity: "10.000", averageCost: "1000.0000", stockValue: "10000.00" });

    const seenByCashier = (await get(cashier, "/api/stock").expect(200)).body.items[0];
    expect(seenByCashier.quantity).toBe("10.000");
    expect(seenByCashier.averageCost).toBeUndefined();
    const movement = (await get(cashier, "/api/stock/movements").expect(200)).body.items[0];
    expect(movement.unitCost).toBeUndefined();
  });

  it("signale les produits sous leur seuil, y compris jamais reçus dans une boutique", async () => {
    const { session, shop, shop2, rice } = await setup();
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 3, unitCost: 1000 }]);

    const alerts = (await get(session, "/api/stock/alerts").expect(200)).body.alerts;

    // Seuil 5 : 0 en BTQ2 (jamais reçu, rupture en tête), 3 en BTQ1 ; le sucre n'a pas de seuil
    expect(
      alerts.map((alert: { shop: { code: string }; quantity: string; status: string }) => [alert.shop.code, Number(alert.quantity), alert.status]),
    ).toEqual([
      ["BTQ2", 0, "out_of_stock"],
      ["BTQ1", 3, "low_stock"],
    ]);
    expect(alerts[1]).toMatchObject({ alertThreshold: "5.000", product: { sku: rice.sku, unit: expect.any(String) }, shop: { name: expect.any(String) } });
    expect(alerts.every((alert: { product: { id: string } }) => alert.product.id === rice.id)).toBe(true);
    expect((await get(session, "/api/stock?lowStock=true")).body.total).toBe(1);
    expect((await get(session, `/api/stock/products/${rice.id}`)).body.stock).toHaveLength(2);
    expect(shop2.code).toBe("BTQ2");
  });

  it("signale la rupture d'un produit sans seuil déjà stocké, pas celle d'un produit jamais reçu", async () => {
    const { session, shop, sugar } = await setup();
    await adjust(session, shop.id, [{ productId: sugar.id, quantity: 2, unitCost: 500 }]);
    await adjust(session, shop.id, [{ productId: sugar.id, quantity: -2 }], "loss");

    const alerts = (await get(session, "/api/stock/alerts").expect(200)).body.alerts;
    const sugarAlerts = alerts.filter((alert: { product: { id: string } }) => alert.product.id === sugar.id);

    // Rupture en BTQ1 uniquement : jamais reçu en BTQ2, le sucre n'y est pas suivi
    expect(sugarAlerts).toHaveLength(1);
    expect(sugarAlerts[0]).toMatchObject({ shop: { code: "BTQ1" }, status: "out_of_stock", alertThreshold: "0.000" });
    const lowStock = (await get(session, "/api/stock?lowStock=true").expect(200)).body.items;
    expect(lowStock.some((item: { product: { id: string }; lowStock: boolean }) => item.product.id === sugar.id && item.lowStock)).toBe(true);
  });

  it("un gérant limité à une boutique ne voit et n'ajuste que celle-ci", async () => {
    const { session, company, shop, shop2, rice } = await setup();
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 4, unitCost: 1000 }]);
    await adjust(session, shop2.id, [{ productId: rice.id, quantity: 7, unitCost: 1000 }]);
    await addMember(company.id, "manager@test.com", "manager", { shopIds: [shop.id] });
    const manager = await login("manager@test.com");

    const items = (await get(manager, "/api/stock").expect(200)).body.items;
    expect(items.map((item: { shop: { code: string } }) => item.shop.code)).toEqual(["BTQ1"]);
    await get(manager, `/api/stock?shopId=${shop2.id}`).expect(404);
    await adjust(manager, shop2.id, [{ productId: rice.id, quantity: -1 }], "loss").expect(404);
  });
});

describe("Transferts entre boutiques", () => {
  it("brouillon → expédition (sortie) → réception partielle (entrée + écart tracé)", async () => {
    const { session, shop, shop2, rice } = await setup();
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 10, unitCost: 1200 }]);

    const draft = (await post(session, "/api/stock/transfers", {
      fromShopId: shop.id,
      toShopId: shop2.id,
      lines: [{ productId: rice.id, quantity: 6 }],
    }).expect(201)).body.transfer;
    expect(draft).toMatchObject({ number: `BTQ1-TR-${YEAR}-000001`, status: "draft" });
    // Un brouillon ne touche pas au stock
    expect((await level(shop.id, rice.id))?.quantity).toBe("10.000");

    const shipped = (await post(session, `/api/stock/transfers/${draft.id}/ship`).expect(200)).body.transfer;
    expect(shipped.status).toBe("shipped");
    expect(shipped.lines[0].unitCost).toBe("1200.0000");
    expect((await level(shop.id, rice.id))?.quantity).toBe("4.000");

    const lineId = shipped.lines[0].id;
    await post(session, `/api/stock/transfers/${draft.id}/receive`, { lines: [{ lineId, quantityReceived: 7 }] }).expect(400);
    const received = (await post(session, `/api/stock/transfers/${draft.id}/receive`, {
      lines: [{ lineId, quantityReceived: 5 }],
    }).expect(200)).body.transfer;

    expect(received.status).toBe("received");
    expect(await level(shop2.id, rice.id)).toMatchObject({ quantity: "5.000", averageCost: "1200.0000" });
    const log = await AuditLog.findOne({ where: { action: "transfer.receive_with_discrepancy" } });
    expect(log?.after).toMatchObject({ discrepancies: [{ sent: "6.000", received: "5" }] });
    // Déjà reçu : impossible de recevoir à nouveau
    await post(session, `/api/stock/transfers/${draft.id}/receive`).expect(409);
  });

  it("refuse d'expédier plus que le stock, et seul un brouillon s'annule", async () => {
    const { session, shop, shop2, rice } = await setup();
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 2, unitCost: 1000 }]);
    const transfer = (await post(session, "/api/stock/transfers", {
      fromShopId: shop.id,
      toShopId: shop2.id,
      lines: [{ productId: rice.id, quantity: 3 }],
    })).body.transfer;

    await post(session, `/api/stock/transfers/${transfer.id}/ship`).expect(409);
    await post(session, `/api/stock/transfers/${transfer.id}/cancel`).expect(200);
    await post(session, `/api/stock/transfers/${transfer.id}/ship`).expect(409);
  });

  it("seule la boutique d'arrivée réceptionne ; un caissier ne transfère pas", async () => {
    const { session, company, shop, shop2, rice } = await setup();
    await adjust(session, shop.id, [{ productId: rice.id, quantity: 5, unitCost: 1000 }]);
    await addMember(company.id, "from@test.com", "manager", { shopIds: [shop.id] });
    await addMember(company.id, "cashier@test.com", "cashier", { allShops: true });
    const fromManager = await login("from@test.com");
    const cashier = await login("cashier@test.com");

    const transfer = (await post(fromManager, "/api/stock/transfers", {
      fromShopId: shop.id,
      toShopId: shop2.id,
      lines: [{ productId: rice.id, quantity: 2 }],
    }).expect(201)).body.transfer;
    await post(fromManager, `/api/stock/transfers/${transfer.id}/ship`).expect(200);

    await post(fromManager, `/api/stock/transfers/${transfer.id}/receive`).expect(403);
    await post(cashier, `/api/stock/transfers/${transfer.id}/receive`).expect(403);
    await post(session, `/api/stock/transfers/${transfer.id}/receive`).expect(200);
  });
});

describe("Inventaires", () => {
  it("corrige l'écart avec le stock au moment de la validation", async () => {
    const { session, shop, rice, sugar } = await setup();
    await adjust(session, shop.id, [
      { productId: rice.id, quantity: 10, unitCost: 1000 },
      { productId: sugar.id, quantity: "4.5", unitCost: 700 },
    ]);

    const inventory = (await post(session, "/api/stock/inventories", { shopId: shop.id }).expect(201)).body.inventory;
    expect(inventory.number).toBe(`BTQ1-INV-${YEAR}-000001`);
    await put(session, `/api/stock/inventories/${inventory.id}/lines`, {
      lines: [{ productId: rice.id, countedQuantity: 9 }],
    }).expect(200);
    // Saisie en plusieurs fois : la 2e saisie corrige la première et ajoute le sucre
    await put(session, `/api/stock/inventories/${inventory.id}/lines`, {
      lines: [
        { productId: rice.id, countedQuantity: 8 },
        { productId: sugar.id, countedQuantity: "4.5" },
      ],
    }).expect(200);

    // Une sortie pendant le comptage : le théorique passe de 10 à 9
    await adjust(session, shop.id, [{ productId: rice.id, quantity: -1 }], "loss");

    const validated = (await post(session, `/api/stock/inventories/${inventory.id}/validate`).expect(200)).body.inventory;
    expect(validated.status).toBe("validated");
    const riceLine = validated.lines.find((line: { productId: string }) => line.productId === rice.id);
    expect(riceLine).toMatchObject({ countedQuantity: "8.000", expectedQuantity: "9.000" });
    expect((await level(shop.id, rice.id))?.quantity).toBe("8.000");
    // Sucre exact : pas de mouvement inutile
    expect(await StockMovement.count({ where: { type: "inventory_adjustment" } })).toBe(1);

    await put(session, `/api/stock/inventories/${inventory.id}/lines`, {
      lines: [{ productId: rice.id, countedQuantity: 1 }],
    }).expect(409);
  });

  it("un inventaire vide ne se valide pas, un annulé non plus", async () => {
    const { session, shop } = await setup();
    const inventory = (await post(session, "/api/stock/inventories", { shopId: shop.id })).body.inventory;

    await post(session, `/api/stock/inventories/${inventory.id}/validate`).expect(400);
    await post(session, `/api/stock/inventories/${inventory.id}/cancel`).expect(200);
    await post(session, `/api/stock/inventories/${inventory.id}/validate`).expect(409);
  });
});

describe("Isolation du stock entre entreprises (RB-01)", () => {
  it("aucune donnée de stock de A n'est visible, modifiable ou utilisable depuis B", async () => {
    const a = await setup("Commerce A", "owner-a@test.com");
    const b = await setup("Commerce B", "owner-b@test.com");
    const adjustmentA = (await adjust(a.session, a.shop.id, [{ productId: a.rice.id, quantity: 5, unitCost: 1000 }])).body
      .adjustment;
    const transferA = (await post(a.session, "/api/stock/transfers", {
      fromShopId: a.shop.id,
      toShopId: a.shop2.id,
      lines: [{ productId: a.rice.id, quantity: 1 }],
    })).body.transfer;
    const inventoryA = (await post(a.session, "/api/stock/inventories", { shopId: a.shop.id })).body.inventory;

    await get(b.session, `/api/stock/adjustments/${adjustmentA.id}`).expect(404);
    await get(b.session, `/api/stock/transfers/${transferA.id}`).expect(404);
    await post(b.session, `/api/stock/transfers/${transferA.id}/ship`).expect(404);
    await get(b.session, `/api/stock/inventories/${inventoryA.id}`).expect(404);
    await post(b.session, `/api/stock/inventories/${inventoryA.id}/validate`).expect(404);
    await get(b.session, `/api/stock/products/${a.rice.id}`).expect(404);
    await get(b.session, `/api/stock?shopId=${a.shop.id}`).expect(404);

    // Agir sur une boutique de A, ou utiliser un produit de A, depuis B
    await adjust(b.session, a.shop.id, [{ productId: b.rice.id, quantity: 1 }]).expect(404);
    await adjust(b.session, b.shop.id, [{ productId: a.rice.id, quantity: 1 }]).expect(400);
    await post(b.session, "/api/stock/transfers", {
      fromShopId: b.shop.id,
      toShopId: a.shop.id,
      lines: [{ productId: b.rice.id, quantity: 1 }],
    }).expect(404);

    expect((await get(b.session, "/api/stock")).body.total).toBe(0);
    expect((await get(b.session, "/api/stock/movements")).body.total).toBe(0);
  });
});
