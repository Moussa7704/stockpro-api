import { describe, expect, it } from "vitest";
import { Membership } from "../src/models/index.js";
import {
  addMember,
  api,
  bearer,
  cookieHeader,
  createCompany,
  createUser,
  login,
  switchCompany,
} from "./helpers/auth.js";

describe("Entreprise active", () => {
  it("est choisie automatiquement quand l'utilisateur n'a qu'une entreprise", async () => {
    const { company } = await createCompany("Commerce A", "owner@test.com");

    const session = await login("owner@test.com");

    expect(session.activeCompanyId).toBe(company.id);
    await api().get("/api/company").set("Authorization", bearer(session)).expect(200);
  });

  it("doit être choisie quand l'utilisateur appartient à plusieurs entreprises", async () => {
    const a = await createCompany("Commerce A", "owner-a@test.com");
    const b = await createCompany("Commerce B", "owner-b@test.com");
    await addMember(b.company.id, "owner-a@test.com", "accountant");

    let session = await login("owner-a@test.com");
    expect(session.activeCompanyId).toBeNull();

    const blocked = await api().get("/api/company").set("Authorization", bearer(session));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toBe("Choisissez une entreprise");

    const me = await api().get("/api/auth/me").set("Authorization", bearer(session)).expect(200);
    expect(me.body.companies.map((company: { name: string }) => company.name)).toEqual(["Commerce A", "Commerce B"]);
    expect(me.body.activeCompany).toBeNull();

    session = await switchCompany(session, b.company.id);
    const current = await api().get("/api/company").set("Authorization", bearer(session)).expect(200);
    expect(current.body.company.id).toBe(b.company.id);
    expect(a.company.id).not.toBe(b.company.id);
  });

  it("refuse de basculer vers une entreprise dont on n'est pas membre (404)", async () => {
    await createCompany("Commerce A", "owner-a@test.com");
    const b = await createCompany("Commerce B", "owner-b@test.com");
    const session = await login("owner-a@test.com");

    const response = await api()
      .post("/api/auth/company")
      .set("Authorization", bearer(session))
      .send({ companyId: b.company.id });

    expect(response.status).toBe(404);
  });

  it("est conservée par le renouvellement de session", async () => {
    await createCompany("Commerce A", "owner-a@test.com");
    const b = await createCompany("Commerce B", "owner-b@test.com");
    await addMember(b.company.id, "owner-a@test.com", "manager");
    const session = await switchCompany(await login("owner-a@test.com"), b.company.id);

    const refreshed = await api()
      .post("/api/auth/refresh")
      .set("Cookie", cookieHeader(session.refreshToken))
      .expect(200);

    const current = await api()
      .get("/api/company")
      .set("Authorization", `Bearer ${refreshed.body.accessToken}`)
      .expect(200);
    expect(current.body.company.id).toBe(b.company.id);
  });

  it("un membre désactivé perd l'accès immédiatement, même avec un token encore valide", async () => {
    const { company } = await createCompany("Commerce A", "owner@test.com");
    const { membership } = await addMember(company.id, "cashier@test.com", "cashier", { allShops: true });
    const cashier = await login("cashier@test.com");
    await api().get("/api/shops").set("Authorization", bearer(cashier)).expect(200);

    await Membership.update({ status: "disabled" }, { where: { id: membership.id } });

    await api().get("/api/shops").set("Authorization", bearer(cashier)).expect(403);
    // Au renouvellement, la session n'a plus d'entreprise active
    const refreshed = await api()
      .post("/api/auth/refresh")
      .set("Cookie", cookieHeader(cashier.refreshToken))
      .expect(200);
    await api().get("/api/shops").set("Authorization", `Bearer ${refreshed.body.accessToken}`).expect(403);
  });

  it("/me renvoie le rôle, les permissions et les boutiques de l'entreprise active", async () => {
    const { company, shop } = await createCompany("Commerce A", "owner@test.com");
    await addMember(company.id, "cashier@test.com", "cashier", { shopIds: [shop.id] });
    const cashier = await login("cashier@test.com");

    const me = await api().get("/api/auth/me").set("Authorization", bearer(cashier)).expect(200);

    expect(me.body.activeCompany).toMatchObject({
      id: company.id,
      role: { code: "cashier", name: "Caissier" },
      allShops: false,
      shopIds: [shop.id],
    });
    expect(me.body.activeCompany.permissions).toContain("sales.create");
    expect(me.body.activeCompany.permissions).not.toContain("users.manage");
  });

  it("un utilisateur sans entreprise peut se connecter mais n'accède à aucune donnée", async () => {
    await createUser({ email: "lonely@test.com" });
    const session = await login("lonely@test.com");

    expect(session.activeCompanyId).toBeNull();
    await api().get("/api/shops").set("Authorization", bearer(session)).expect(403);
  });
});
