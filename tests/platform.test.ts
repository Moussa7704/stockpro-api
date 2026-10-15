import { describe, expect, it } from "vitest";
import { AuditLog, Membership, Role, RolePermission, Shop } from "../src/models/index.js";
import { SYSTEM_ROLE_CODES } from "../src/modules/access/permissions.js";
import { api, bearer, createCompany, createUser, login, type Session } from "./helpers/auth.js";
import { emailsTo, lastLinkToken, mailbox } from "./helpers/mailbox.js";

const NEW_COMPANY = {
  name: "Boutique Chez Awa",
  owner: { name: "Awa Diallo", email: "awa@test.com" },
};

async function loginAsPlatformAdmin(): Promise<Session> {
  await createUser({ email: "platform@test.com", name: "Admin Plateforme", isPlatformAdmin: true });
  return login("platform@test.com");
}

const createCompanyRequest = (admin: Session, body: object = NEW_COMPANY) =>
  api().post("/api/platform/companies").set("Authorization", bearer(admin)).send(body);

describe("Accès au back-office plateforme", () => {
  it("refuse sans token", async () => {
    await api().get("/api/platform/companies").expect(401);
  });

  it("refuse un propriétaire de commerce (ce n'est pas l'administrateur SaaS)", async () => {
    await createCompany("Commerce A", "owner-a@test.com");
    const owner = await login("owner-a@test.com");

    await api().get("/api/platform/companies").set("Authorization", bearer(owner)).expect(403);
  });
});

describe("Création d'un commerçant", () => {
  it("crée l'entreprise, ses 5 rôles, une boutique et le propriétaire invité", async () => {
    const admin = await loginAsPlatformAdmin();

    const response = await createCompanyRequest(admin).expect(201);
    const { company, shop, owner } = response.body;

    expect(company).toMatchObject({ name: "Boutique Chez Awa", slug: "boutique-chez-awa", currency: "XOF", status: "active" });
    expect(shop).toMatchObject({ code: "BTQ1", name: "Boutique principale", companyId: company.id });
    expect(owner).toMatchObject({ email: "awa@test.com", invitationPending: true });
    expect(owner.password).toBeUndefined();

    const roles = await Role.findAll({ where: { companyId: company.id } });
    expect(roles.map((role) => role.code).sort()).toEqual([...SYSTEM_ROLE_CODES].sort());
    const ownerRole = roles.find((role) => role.code === "owner")!;
    expect(await RolePermission.count({ where: { roleId: ownerRole.id } })).toBeGreaterThan(15);

    const membership = await Membership.findOne({ where: { companyId: company.id, userId: owner.id } });
    expect(membership).toMatchObject({ roleId: ownerRole.id, allShops: true, status: "active" });
    expect(emailsTo("awa@test.com").map((email) => email.type)).toEqual(["invitation"]);
    expect(await AuditLog.count({ where: { companyId: company.id, action: "company.create" } })).toBe(1);
  });

  it("le propriétaire invité active son compte et arrive directement dans son entreprise", async () => {
    const admin = await loginAsPlatformAdmin();
    const { company } = (await createCompanyRequest(admin)).body;

    await api()
      .post("/api/auth/password/reset")
      .send({ token: lastLinkToken("invitation", "awa@test.com"), password: "awapass123" })
      .expect(200);
    const owner = await login("awa@test.com", "awapass123");

    expect(owner.activeCompanyId).toBe(company.id);
    const me = await api().get("/api/auth/me").set("Authorization", bearer(owner)).expect(200);
    expect(me.body.activeCompany).toMatchObject({ name: "Boutique Chez Awa", role: { code: "owner" }, allShops: true });
    expect(me.body.activeCompany.permissions).toContain("users.manage");
  });

  it("génère un slug libre quand le nom est déjà pris", async () => {
    const admin = await loginAsPlatformAdmin();
    await createCompanyRequest(admin).expect(201);

    const second = await createCompanyRequest(admin, {
      ...NEW_COMPANY,
      owner: { name: "Autre", email: "autre@test.com" },
    }).expect(201);

    expect(second.body.company.slug).toBe("boutique-chez-awa-2");
  });

  it("refuse un slug explicite déjà utilisé", async () => {
    const admin = await loginAsPlatformAdmin();
    await createCompanyRequest(admin, { ...NEW_COMPANY, slug: "awa" }).expect(201);

    await createCompanyRequest(admin, {
      ...NEW_COMPANY,
      slug: "awa",
      owner: { name: "Autre", email: "autre@test.com" },
    }).expect(409);
  });

  it("réutilise un compte existant : simple email d'accès, pas de nouveau mot de passe", async () => {
    await createCompany("Premier commerce", "multi@test.com");
    const admin = await loginAsPlatformAdmin();
    mailbox.length = 0;

    await createCompanyRequest(admin, { name: "Second commerce", owner: { name: "Multi", email: "multi@test.com" } }).expect(201);

    expect(emailsTo("multi@test.com")).toEqual([
      { type: "company-access", to: "multi@test.com", companyName: "Second commerce" },
    ]);
    const session = await login("multi@test.com");
    // Deux entreprises : aucune n'est choisie automatiquement
    expect(session.activeCompanyId).toBeNull();
  });

  it("valide les données (devise unique XOF, fuseau horaire)", async () => {
    const admin = await loginAsPlatformAdmin();

    await createCompanyRequest(admin, { ...NEW_COMPANY, currency: "EUR" }).expect(400);
    await createCompanyRequest(admin, { ...NEW_COMPANY, timezone: "Mars/Olympus" }).expect(400);
  });
});

describe("Suspension d'un commerçant", () => {
  it("coupe immédiatement l'accès de ses membres, puis le rend à la réactivation", async () => {
    const admin = await loginAsPlatformAdmin();
    const { company } = await createCompany("Commerce A", "owner-a@test.com");
    const owner = await login("owner-a@test.com");
    await api().get("/api/company").set("Authorization", bearer(owner)).expect(200);

    await api()
      .patch(`/api/platform/companies/${company.id}`)
      .set("Authorization", bearer(admin))
      .send({ status: "suspended" })
      .expect(200);

    // Même token : l'appartenance est revérifiée à chaque requête
    await api().get("/api/company").set("Authorization", bearer(owner)).expect(403);
    expect(await AuditLog.count({ where: { action: "company.suspend" } })).toBe(1);

    await api()
      .patch(`/api/platform/companies/${company.id}`)
      .set("Authorization", bearer(admin))
      .send({ status: "active" })
      .expect(200);
    await api().get("/api/company").set("Authorization", bearer(owner)).expect(200);
  });

  it("liste les commerçants avec leur nombre de membres actifs", async () => {
    const admin = await loginAsPlatformAdmin();
    await createCompany("Commerce A", "owner-a@test.com");

    const response = await api().get("/api/platform/companies").set("Authorization", bearer(admin)).expect(200);

    expect(response.body.companies).toHaveLength(1);
    expect(response.body.companies[0]).toMatchObject({ name: "Commerce A", activeMembers: 1 });
    expect(await Shop.count()).toBe(1);
  });
});
