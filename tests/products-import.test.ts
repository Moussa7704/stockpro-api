import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { AuditLog, Category, Product, Unit } from "../src/models/index.js";
import { addMember, api, bearer, createCompany, login, type Session } from "./helpers/auth.js";

async function setup(name = "Commerce A", email = "owner@test.com") {
  const created = await createCompany(name, email);
  const session = await login(email);
  const piece = (await Unit.findOne({ where: { companyId: created.company.id, name: "Pièce" } }))!;
  return { ...created, session, piece };
}

/** Classeur comme en font les boutiques : un titre au-dessus de l'en-tête, une ligne de total en bas. */
async function shopWorkbook(rows: (string | number | null)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Stock");
  sheet.addRow(["Inventaire boutique Marché central"]);
  sheet.addRow([]);
  sheet.addRow(["Réf", "Désignation", "Famille", "Unité", "PU", "Prix d'achat", "Qté"]);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const mapping = {
  sku: "Réf",
  name: "Désignation",
  category: "Famille",
  unit: "Unité",
  salePrice: "PU",
  purchasePrice: "Prix d'achat",
};

const analyze = (session: Session, file: Buffer, filename: string) =>
  api().post("/api/products/import/analyze").set("Authorization", bearer(session)).attach("file", file, filename);

const importFile = (session: Session, file: Buffer, filename: string, options: object) =>
  api()
    .post("/api/products/import")
    .set("Authorization", bearer(session))
    .attach("file", file, filename)
    .field("options", JSON.stringify(options));

describe("Import de produits", () => {
  it("analyse le fichier d'une boutique : en-tête trouvé sous le titre, colonnes reconnues", async () => {
    const { session } = await setup();
    const file = await shopWorkbook([["R1", "Riz 25 kg", "Alimentation", "pce", 15000, 13500, 12]]);

    const response = await analyze(session, file, "stock.xlsx").expect(200);

    const { analysis } = response.body;
    expect(analysis.columns).toEqual(["Réf", "Désignation", "Famille", "Unité", "PU", "Prix d'achat", "Qté"]);
    expect(analysis.rowCount).toBe(1);
    expect(analysis.sample[0]).toEqual({
      line: 4,
      cells: ["R1", "Riz 25 kg", "Alimentation", "pce", "15000", "13500", "12"],
    });
    expect(analysis.suggestedMapping).toEqual(mapping);
  });

  it("aperçu : chaque ligne classée, rien n'est écrit", async () => {
    const { session, company } = await setup();
    const file = await shopWorkbook([
      ["R1", "Riz 25 kg", "Alimentation", "pce", 15000, 13500, 12],
      [null, "Savon", "Hygiène", "pièce", "500", null, 40],
      ["R3", "Huile 1 L", "Alimentation", "bidon", 1200, null, 5],
      [null, "TOTAL", null, null, 16700, null, 57],
    ]);

    const response = await importFile(session, file, "stock.xlsx", { mapping, dryRun: true }).expect(200);

    const { report } = response.body;
    expect(report).toMatchObject({ dryRun: true, totalRows: 4, toCreate: 2, errors: 1, skipped: 1 });
    expect(report.categoriesToCreate.sort()).toEqual(["Alimentation", "Hygiène"]);
    expect(report.rows.map((row: { status: string }) => row.status)).toEqual(["create", "create", "error", "skipped"]);
    // Pas de référence : un SKU est proposé
    expect(report.rows[1]).toMatchObject({ sku: "ART-000001", generatedSku: true });
    expect(report.rows[2].messages).toEqual(["Unité « bidon » inconnue : créez-la d'abord ou corrigez le fichier"]);
    expect(await Product.count({ where: { companyId: company.id } })).toBe(0);
  });

  it("tout ou rien : une ligne en erreur bloque l'import ; corrigé, tout est créé une seule fois", async () => {
    const { session, company } = await setup();
    const withError = await shopWorkbook([
      ["R1", "Riz 25 kg", "Alimentation", "pce", 15000, 13500, 12],
      ["R2", "Sucre 1 kg", "Alimentation", "kg", "abc", null, 3],
    ]);

    const refused = await importFile(session, withError, "stock.xlsx", { mapping }).expect(400);
    expect(refused.body.error.message).toBe("1 ligne(s) en erreur : rien n'a été importé");
    expect(refused.body.error.details.rows[1].messages).toEqual(["Prix de vente « abc » invalide"]);
    expect(await Product.count({ where: { companyId: company.id } })).toBe(0);
    expect(await Category.count({ where: { companyId: company.id } })).toBe(0);

    const fixed = await shopWorkbook([
      ["R1", "Riz 25 kg", "Alimentation", "pce", 15000, 13500, 12],
      ["r2", "Sucre 1 kg", "Alimentation", "kg", "1 250", null, 3],
    ]);
    const created = await importFile(session, fixed, "stock.xlsx", { mapping }).expect(201);
    expect(created.body.report).toMatchObject({ dryRun: false, toCreate: 2, categoriesToCreate: ["Alimentation"] });

    const products = await Product.findAll({ where: { companyId: company.id }, order: [["sku", "ASC"]] });
    expect(products.map((product) => [product.sku, product.salePrice, product.purchasePriceHint])).toEqual([
      ["R1", "15000.00", "13500.00"],
      ["R2", "1250.00", null],
    ]);
    const category = await Category.findOne({ where: { companyId: company.id, name: "Alimentation" } });
    expect(products.every((product) => product.categoryId === category!.id)).toBe(true);
    const audit = await AuditLog.findOne({ where: { companyId: company.id, action: "product.import" } });
    expect(audit!.after).toMatchObject({ filename: "stock.xlsx", created: 2, categoriesCreated: ["Alimentation"] });

    // Même fichier une 2e fois : les produits existent déjà, rien n'est créé ni modifié
    const again = await importFile(session, fixed, "stock.xlsx", { mapping }).expect(200);
    expect(again.body.report).toMatchObject({ toCreate: 0, existing: 2 });
    expect(await Product.count({ where: { companyId: company.id } })).toBe(2);
  });

  it("lit un CSV d'Excel français (point-virgule, accents Windows) avec une unité par défaut", async () => {
    const { session, company, piece } = await setup();
    const csv = "Désignation;Code barre;Prix vente\r\nCafé moulu;6111234567890;2 500\r\n\"Thé ; menthe\";;800\r\n";
    const file = latin1(csv);

    const analysis = (await analyze(session, file, "articles.csv").expect(200)).body.analysis;
    expect(analysis.suggestedMapping).toEqual({ name: "Désignation", barcode: "Code barre", salePrice: "Prix vente" });

    await importFile(session, file, "articles.csv", { mapping: analysis.suggestedMapping, defaultUnitId: piece.id }).expect(201);

    const products = await Product.findAll({ where: { companyId: company.id }, order: [["name", "ASC"]] });
    expect(products.map((product) => [product.name, product.barcode, product.salePrice, product.unitId])).toEqual([
      ["Café moulu", "6111234567890", "2500.00", piece.id],
      ["Thé ; menthe", null, "800.00", piece.id],
    ]);
  });

  it("refuse les centimes en FCFA, les catégories inconnues si demandé, et une colonne absente", async () => {
    const { session } = await setup();
    const file = await shopWorkbook([["R1", "Riz 25 kg", "Alimentation", "pce", "1500,50", null, 1]]);

    const report = (await importFile(session, file, "stock.xlsx", { mapping, dryRun: true, createCategories: false })
      .expect(200)).body.report;
    expect(report.rows[0].messages).toEqual([
      "Prix de vente : pas de décimales en XOF",
      "Catégorie « Alimentation » inconnue",
    ]);

    const missing = await importFile(session, file, "stock.xlsx", { mapping: { ...mapping, barcode: "EAN" } }).expect(400);
    expect(missing.body.error.message).toBe("Colonne « EAN » absente du fichier (champ Code-barres)");
  });

  it("le modèle vierge est reconnu tel quel par l'analyse", async () => {
    const { session } = await setup();

    const template = await api()
      .get("/api/products/import/template")
      .set("Authorization", bearer(session))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const analysis = (await analyze(session, template.body as Buffer, "modele.xlsx").expect(200)).body.analysis;
    expect(Object.keys(analysis.suggestedMapping).sort()).toEqual(
      ["name", "sku", "barcode", "category", "unit", "salePrice", "purchasePrice", "alertThreshold", "description"].sort(),
    );
  });

  it("contrôle le fichier envoyé et les droits", async () => {
    const { session, company } = await setup();
    await addMember(company.id, "cashier@test.com", "cashier", { allShops: true });
    const cashier = await login("cashier@test.com");
    const file = await shopWorkbook([["R1", "Riz 25 kg", "Alimentation", "pce", 15000, null, 1]]);

    await analyze(cashier, file, "stock.xlsx").expect(403);
    await api().post("/api/products/import/analyze").set("Authorization", bearer(session)).expect(400);
    const wrongType = await analyze(session, Buffer.from("%PDF-1.4"), "stock.pdf").expect(400);
    expect(wrongType.body.error.message).toBe("Format non pris en charge : .xlsx ou .csv attendu");
    await analyze(session, Buffer.from("pas un classeur"), "stock.xlsx").expect(400);
    await importFile(session, file, "stock.xlsx", { mapping: { name: "Désignation" } }).expect(400);
  });
});

/** Texte encodé en Windows-1252 (Latin-1 pour ces caractères), comme un CSV enregistré par Excel. */
function latin1(text: string): Buffer {
  return Buffer.from(text, "latin1");
}
