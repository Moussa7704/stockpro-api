import { describe, expect, it } from "vitest";
import { AuditLog, Unit } from "../src/models/index.js";
import { addMember, api, bearer, createCompany, login, type Session } from "./helpers/auth.js";

/** Entreprise avec un propriétaire connecté, et ses unités par défaut. */
async function setup(name = "Commerce A", email = "owner@test.com") {
  const created = await createCompany(name, email);
  const session = await login(email);
  const units = await Unit.findAll({ where: { companyId: created.company.id } });
  const piece = units.find((unit) => unit.name === "Pièce")!;
  const kilo = units.find((unit) => unit.name === "Kilogramme")!;
  return { ...created, session, piece, kilo };
}

const post = (session: Session, path: string, body: object) =>
  api().post(path).set("Authorization", bearer(session)).send(body);
const patch = (session: Session, path: string, body: object) =>
  api().patch(path).set("Authorization", bearer(session)).send(body);
const get = (session: Session, path: string) => api().get(path).set("Authorization", bearer(session));

const product = (unitId: string, extra: object = {}) => ({
  sku: "riz-25kg",
  name: "Riz parfumé 25 kg",
  unitId,
  salePrice: 15000,
  ...extra,
});

describe("Unités", () => {
  it("chaque nouvelle entreprise reçoit les unités par défaut", async () => {
    const { session } = await setup();

    const response = await get(session, "/api/units").expect(200);

    expect(response.body.units.map((unit: { symbol: string }) => unit.symbol).sort()).toEqual(["L", "kg", "m", "pce"].sort());
  });

  it("crée une unité, refuse un doublon (sans tenir compte de la casse) et l'archive", async () => {
    const { session } = await setup();

    const created = await post(session, "/api/units", { name: "Carton", symbol: "ctn" }).expect(201);
    await post(session, "/api/units", { name: "CARTON", symbol: "c" }).expect(409);
    await patch(session, `/api/units/${created.body.unit.id}`, { archived: true }).expect(200);

    const active = await get(session, "/api/units");
    expect(active.body.units.map((unit: { name: string }) => unit.name)).not.toContain("Carton");
  });

  it("un caissier lit les unités mais ne peut pas en créer", async () => {
    const { company } = await setup();
    await addMember(company.id, "cashier@test.com", "cashier", { allShops: true });
    const cashier = await login("cashier@test.com");

    await get(cashier, "/api/units").expect(200);
    await post(cashier, "/api/units", { name: "Sac", symbol: "sac" }).expect(403);
  });
});

describe("Catégories", () => {
  it("construit une arborescence, nom unique au même niveau seulement", async () => {
    const { session } = await setup();
    const food = (await post(session, "/api/categories", { name: "Alimentation" }).expect(201)).body.category;
    const drinks = (await post(session, "/api/categories", { name: "Boissons" }).expect(201)).body.category;

    await post(session, "/api/categories", { name: "Sucré", parentId: food.id }).expect(201);
    await post(session, "/api/categories", { name: "sucré", parentId: food.id }).expect(409);
    // Même nom sous un autre parent : autorisé
    await post(session, "/api/categories", { name: "Sucré", parentId: drinks.id }).expect(201);
    await post(session, "/api/categories", { name: "ALIMENTATION" }).expect(409);
  });

  it("empêche les cycles (une catégorie sous sa propre sous-catégorie)", async () => {
    const { session } = await setup();
    const parent = (await post(session, "/api/categories", { name: "Parent" })).body.category;
    const child = (await post(session, "/api/categories", { name: "Enfant", parentId: parent.id })).body.category;
    const grandChild = (await post(session, "/api/categories", { name: "Petit-enfant", parentId: child.id })).body
      .category;

    await patch(session, `/api/categories/${parent.id}`, { parentId: grandChild.id }).expect(400);
    await patch(session, `/api/categories/${parent.id}`, { parentId: parent.id }).expect(400);
  });

  it("refuse un parent archivé", async () => {
    const { session } = await setup();
    const parent = (await post(session, "/api/categories", { name: "Ancienne" })).body.category;
    await patch(session, `/api/categories/${parent.id}`, { archived: true }).expect(200);

    await post(session, "/api/categories", { name: "Nouvelle", parentId: parent.id }).expect(400);
  });
});

describe("Fournisseurs", () => {
  it("crée, recherche et pagine", async () => {
    const { session } = await setup();
    for (const name of ["Grossiste Dakar", "Import Abidjan", "Grossiste Bamako"]) {
      await post(session, "/api/suppliers", { name, phone: "+221 77 000 00 00" }).expect(201);
    }
    await post(session, "/api/suppliers", { name: "grossiste dakar" }).expect(409);

    const search = await get(session, "/api/suppliers?search=grossiste").expect(200);
    expect(search.body.total).toBe(2);

    const page = await get(session, "/api/suppliers?page=2&pageSize=2").expect(200);
    expect(page.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page.body.items).toHaveLength(1);
  });

  it("la recherche traite % et _ comme des caractères normaux", async () => {
    const { session } = await setup();
    await post(session, "/api/suppliers", { name: "Fournisseur A" }).expect(201);

    const response = await get(session, `/api/suppliers?search=${encodeURIComponent("%")}`).expect(200);

    expect(response.body.total).toBe(0);
  });

  it("le gestionnaire de stock gère les fournisseurs, le caissier les consulte seulement", async () => {
    const { company } = await setup();
    await addMember(company.id, "stock@test.com", "stock_keeper", { allShops: true });
    await addMember(company.id, "cashier@test.com", "cashier", { allShops: true });
    const keeper = await login("stock@test.com");
    const cashier = await login("cashier@test.com");

    await post(keeper, "/api/suppliers", { name: "Grossiste" }).expect(201);
    await get(cashier, "/api/suppliers").expect(200);
    await post(cashier, "/api/suppliers", { name: "Autre" }).expect(403);
  });
});

describe("Produits", () => {
  it("crée un produit : SKU en majuscules, montants en décimal exact", async () => {
    const { session, piece } = await setup();
    const category = (await post(session, "/api/categories", { name: "Céréales" })).body.category;

    const response = await post(session, "/api/products", product(piece.id, {
      barcode: "6001234567890",
      categoryId: category.id,
      purchasePriceHint: "12500",
      alertThreshold: 5,
    })).expect(201);

    expect(response.body.product).toMatchObject({
      sku: "RIZ-25KG",
      salePrice: "15000.00",
      purchasePriceHint: "12500.00",
      alertThreshold: "5.000",
      status: "active",
      unit: { id: piece.id, symbol: "pce" },
      category: { id: category.id, name: "Céréales" },
    });
    expect(await AuditLog.count({ where: { action: "product.create" } })).toBe(1);
  });

  it("refuse des centimes en FCFA et une quantité décimale pour une unité « pièce »", async () => {
    const { session, piece, kilo } = await setup();

    await post(session, "/api/products", product(piece.id, { salePrice: "1500.50" })).expect(400);
    await post(session, "/api/products", product(piece.id, { alertThreshold: "2.5" })).expect(400);
    // Au kilo, un seuil de 2,5 kg est valide
    await post(session, "/api/products", product(kilo.id, { alertThreshold: "2.5" })).expect(201);
  });

  it("SKU et code-barres sont uniques dans l'entreprise, pas entre entreprises", async () => {
    const { session, piece } = await setup();
    await post(session, "/api/products", product(piece.id, { barcode: "6001234567890" })).expect(201);

    const sameSku = await post(session, "/api/products", product(piece.id, { sku: "RIZ-25KG", name: "Autre" }));
    expect(sameSku.status).toBe(409);
    expect(sameSku.body.error.message).toBe("Ce SKU est déjà utilisé par un autre produit");

    const sameBarcode = await post(session, "/api/products", product(piece.id, { sku: "AUTRE", barcode: "6001234567890" }));
    expect(sameBarcode.body.error.message).toBe("Ce code-barres est déjà utilisé par un autre produit");

    const other = await setup("Commerce B", "owner-b@test.com");
    await post(other.session, "/api/products", product(other.piece.id, { barcode: "6001234567890" })).expect(201);
  });

  it("liste avec recherche (nom, SKU, code-barres), filtre, tri et pagination", async () => {
    const { session, piece } = await setup();
    const drinks = (await post(session, "/api/categories", { name: "Boissons" })).body.category;
    await post(session, "/api/products", product(piece.id, { sku: "RIZ", name: "Riz", salePrice: 15000 }));
    await post(session, "/api/products", product(piece.id, { sku: "HUILE", name: "Huile", salePrice: 2500, barcode: "1111222233" }));
    await post(session, "/api/products", product(piece.id, { sku: "JUS", name: "Jus", salePrice: 500, categoryId: drinks.id }));

    expect((await get(session, "/api/products?search=hui")).body.total).toBe(1);
    expect((await get(session, "/api/products?search=1111")).body.items[0].sku).toBe("HUILE");
    expect((await get(session, `/api/products?categoryId=${drinks.id}`)).body.items[0].sku).toBe("JUS");

    const sorted = await get(session, "/api/products?sort=salePrice&order=desc").expect(200);
    expect(sorted.body.items.map((item: { sku: string }) => item.sku)).toEqual(["RIZ", "HUILE", "JUS"]);

    const page = await get(session, "/api/products?pageSize=2&page=2").expect(200);
    expect(page.body).toMatchObject({ total: 3, page: 2 });
    expect(page.body.items).toHaveLength(1);
  });

  it("recherche rapide en caisse par code-barres ou SKU, produits actifs uniquement", async () => {
    const { session, piece } = await setup();
    const created = (await post(session, "/api/products", product(piece.id, { barcode: "6001234567890" }))).body.product;

    expect((await get(session, "/api/products/lookup?barcode=6001234567890").expect(200)).body.product.id).toBe(created.id);
    expect((await get(session, "/api/products/lookup?sku=riz-25kg").expect(200)).body.product.id).toBe(created.id);
    await get(session, "/api/products/lookup").expect(400);

    await patch(session, `/api/products/${created.id}`, { status: "archived" }).expect(200);
    await get(session, "/api/products/lookup?barcode=6001234567890").expect(404);
    // Archivé : absent de la liste par défaut, visible avec status=all
    expect((await get(session, "/api/products")).body.total).toBe(0);
    expect((await get(session, "/api/products?status=all")).body.total).toBe(1);
    expect(await AuditLog.count({ where: { action: "product.archive" } })).toBe(1);
  });

  it("changer un prix exige prices.manage et laisse une trace avant / après", async () => {
    const { session, company, piece } = await setup();
    const created = (await post(session, "/api/products", product(piece.id))).body.product;
    await addMember(company.id, "stock@test.com", "stock_keeper", { allShops: true });
    const keeper = await login("stock@test.com");

    // Le gestionnaire de stock modifie le nom, mais pas le prix
    await patch(keeper, `/api/products/${created.id}`, { name: "Riz parfumé" }).expect(200);
    await patch(keeper, `/api/products/${created.id}`, { salePrice: 16000 }).expect(403);
    // Même prix écrit autrement : ce n'est pas un changement
    await patch(keeper, `/api/products/${created.id}`, { salePrice: "15000.00" }).expect(200);

    await patch(session, `/api/products/${created.id}`, { salePrice: 16000 }).expect(200);
    const log = await AuditLog.findOne({ where: { action: "product.price_change" } });
    expect(log?.before).toMatchObject({ salePrice: "15000.00" });
    expect(log?.after).toMatchObject({ salePrice: "16000" });
  });

  it("refuse une unité ou une catégorie archivée", async () => {
    const { session } = await setup();
    const unit = (await post(session, "/api/units", { name: "Sac", symbol: "sac" })).body.unit;
    await patch(session, `/api/units/${unit.id}`, { archived: true });

    await post(session, "/api/products", product(unit.id)).expect(400);
  });
});

describe("Isolation du catalogue entre entreprises (RB-01)", () => {
  it("les ressources de l'entreprise A sont introuvables ou inutilisables depuis B", async () => {
    const a = await setup("Commerce A", "owner-a@test.com");
    const b = await setup("Commerce B", "owner-b@test.com");
    const categoryA = (await post(a.session, "/api/categories", { name: "Catégorie A" })).body.category;
    const supplierA = (await post(a.session, "/api/suppliers", { name: "Fournisseur A" })).body.supplier;
    const productA = (await post(a.session, "/api/products", product(a.piece.id, { barcode: "999888777" }))).body.product;

    // Lecture et modification : 404
    await get(b.session, `/api/products/${productA.id}`).expect(404);
    await patch(b.session, `/api/products/${productA.id}`, { name: "Piraté" }).expect(404);
    await get(b.session, `/api/suppliers/${supplierA.id}`).expect(404);
    await patch(b.session, `/api/suppliers/${supplierA.id}`, { name: "Piraté" }).expect(404);
    await patch(b.session, `/api/categories/${categoryA.id}`, { name: "Piratée" }).expect(404);
    await patch(b.session, `/api/units/${a.piece.id}`, { name: "Piratée" }).expect(404);
    await get(b.session, "/api/products/lookup?barcode=999888777").expect(404);

    // Référencer une catégorie ou une unité de A depuis B : refusé
    await post(b.session, "/api/products", product(a.piece.id)).expect(400);
    await post(b.session, "/api/products", product(b.piece.id, { categoryId: categoryA.id })).expect(400);
    await post(b.session, "/api/categories", { name: "Sous-cat", parentId: categoryA.id }).expect(400);

    // Les listes ne mélangent jamais les entreprises
    expect((await get(b.session, "/api/products")).body.total).toBe(0);
    expect((await get(b.session, "/api/suppliers")).body.total).toBe(0);
    expect((await get(b.session, "/api/categories")).body.categories).toHaveLength(0);
  });
});
