import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/models/index.js";
import { addMember, api, bearer, createCompany, createShop, login } from "./helpers/auth.js";

describe("Boutiques", () => {
  it("le propriétaire crée une boutique (code en majuscules, unique dans l'entreprise)", async () => {
    await createCompany("Commerce A", "owner@test.com");
    const owner = await login("owner@test.com");

    const response = await api()
      .post("/api/shops")
      .set("Authorization", bearer(owner))
      .send({ name: "Marché central", code: "mc1", address: "Rue 12" })
      .expect(201);

    expect(response.body.shop).toMatchObject({ name: "Marché central", code: "MC1", address: "Rue 12" });
    expect(await AuditLog.count({ where: { action: "shop.create" } })).toBe(1);

    await api()
      .post("/api/shops")
      .set("Authorization", bearer(owner))
      .send({ name: "Doublon", code: "MC1" })
      .expect(409);
  });

  it("le même code peut exister dans deux entreprises différentes", async () => {
    await createCompany("Commerce A", "owner-a@test.com");
    await createCompany("Commerce B", "owner-b@test.com");

    // Chaque entreprise a déjà sa boutique BTQ1 : le code est unique PAR entreprise
    const ownerB = await login("owner-b@test.com");
    const response = await api().get("/api/shops").set("Authorization", bearer(ownerB)).expect(200);
    expect(response.body.shops.map((shop: { code: string }) => shop.code)).toEqual(["BTQ1"]);
  });

  it("un caissier ne voit que ses boutiques et ne peut pas en créer", async () => {
    const { company, shop } = await createCompany("Commerce A", "owner@test.com");
    const other = await createShop(company.id, "BTQ2");
    await addMember(company.id, "cashier@test.com", "cashier", { shopIds: [shop.id] });
    const cashier = await login("cashier@test.com");

    const response = await api().get("/api/shops").set("Authorization", bearer(cashier)).expect(200);
    expect(response.body.shops.map((item: { id: string }) => item.id)).toEqual([shop.id]);

    // Boutique de son entreprise mais hors de son périmètre : 404, comme si elle n'existait pas
    await api().get(`/api/shops/${other.id}`).set("Authorization", bearer(cashier)).expect(404);
    await api()
      .post("/api/shops")
      .set("Authorization", bearer(cashier))
      .send({ name: "Pirate", code: "PIR" })
      .expect(403);
  });

  it("archive une boutique au lieu de la supprimer, puis la restaure", async () => {
    const { company } = await createCompany("Commerce A", "owner@test.com");
    const shop = await createShop(company.id, "BTQ2");
    const owner = await login("owner@test.com");

    await api()
      .patch(`/api/shops/${shop.id}`)
      .set("Authorization", bearer(owner))
      .send({ archived: true })
      .expect(200);

    const active = await api().get("/api/shops").set("Authorization", bearer(owner));
    expect(active.body.shops.map((item: { code: string }) => item.code)).toEqual(["BTQ1"]);
    const all = await api().get("/api/shops?includeArchived=true").set("Authorization", bearer(owner));
    expect(all.body.shops).toHaveLength(2);

    await api()
      .patch(`/api/shops/${shop.id}`)
      .set("Authorization", bearer(owner))
      .send({ archived: false })
      .expect(200);
    expect(await AuditLog.count({ where: { action: ["shop.archive", "shop.restore"] } })).toBe(2);
  });
});
