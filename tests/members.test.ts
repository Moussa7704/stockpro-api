import { describe, expect, it } from "vitest";
import { AuditLog, Membership, Role, RolePermission } from "../src/models/index.js";
import {
  addMember,
  api,
  bearer,
  createCompany,
  createShop,
  login,
  type Session,
} from "./helpers/auth.js";
import { emailsTo, lastLinkToken, mailbox } from "./helpers/mailbox.js";

async function ownerSession() {
  const created = await createCompany("Commerce A", "owner@test.com");
  return { ...created, session: await login("owner@test.com") };
}

const invite = (session: Session, body: object) =>
  api().post("/api/members").set("Authorization", bearer(session)).send(body);

const patchMember = (session: Session, membershipId: string, body: object) =>
  api().patch(`/api/members/${membershipId}`).set("Authorization", bearer(session)).send(body);

describe("Invitation d'un membre", () => {
  it("crée le compte, l'appartenance et envoie l'invitation au nom de l'entreprise", async () => {
    const { session, shop } = await ownerSession();

    const response = await invite(session, {
      name: "Camille Caisse",
      email: "camille@test.com",
      roleCode: "cashier",
      shopIds: [shop.id],
    }).expect(201);

    expect(response.body.member).toMatchObject({
      user: { email: "camille@test.com", invitationPending: true },
      role: { code: "cashier" },
      allShops: false,
      shops: [{ id: shop.id, code: "BTQ1" }],
      status: "active",
    });
    expect(emailsTo("camille@test.com").map((email) => email.type)).toEqual(["invitation"]);
    expect(await AuditLog.count({ where: { action: "member.invite" } })).toBe(1);
  });

  it("l'invité active son compte et arrive dans l'entreprise avec son rôle", async () => {
    const { session, shop, company } = await ownerSession();
    await invite(session, { name: "Camille", email: "camille@test.com", roleCode: "cashier", shopIds: [shop.id] });

    await api()
      .post("/api/auth/password/reset")
      .send({ token: lastLinkToken("invitation", "camille@test.com"), password: "camillepass1" })
      .expect(200);
    const cashier = await login("camille@test.com", "camillepass1");

    expect(cashier.activeCompanyId).toBe(company.id);
  });

  it("ajoute un compte existant d'une autre entreprise sans toucher à son mot de passe", async () => {
    await createCompany("Commerce B", "existing@test.com");
    const { session } = await ownerSession();
    mailbox.length = 0;

    await invite(session, { name: "Existant", email: "existing@test.com", roleCode: "accountant" }).expect(201);

    expect(emailsTo("existing@test.com")).toEqual([
      { type: "company-access", to: "existing@test.com", companyName: "Commerce A" },
    ]);
  });

  it("applique le périmètre par défaut du rôle (le comptable voit toutes les boutiques)", async () => {
    const { session } = await ownerSession();

    const response = await invite(session, { name: "Compta", email: "compta@test.com", roleCode: "accountant" }).expect(201);

    expect(response.body.member.allShops).toBe(true);
  });

  it("refuse un doublon, un rôle inconnu et une boutique d'une autre entreprise", async () => {
    const { session } = await ownerSession();
    const other = await createCompany("Commerce B", "owner-b@test.com");
    await invite(session, { name: "Camille", email: "camille@test.com", roleCode: "cashier" }).expect(201);

    await invite(session, { name: "Camille", email: "CAMILLE@test.com", roleCode: "cashier" }).expect(409);
    await invite(session, { name: "X Y", email: "x@test.com", roleCode: "superadmin" }).expect(400);
    await invite(session, { name: "X Y", email: "x@test.com", roleCode: "cashier", shopIds: [other.shop.id] }).expect(400);
  });

  it("est réservée à la permission users.manage", async () => {
    const { company } = await ownerSession();
    await addMember(company.id, "manager@test.com", "manager", { allShops: true });
    const manager = await login("manager@test.com");

    await api().get("/api/members").set("Authorization", bearer(manager)).expect(403);
    await invite(manager, { name: "X Y", email: "x@test.com", roleCode: "cashier" }).expect(403);
  });
});

describe("Modification d'un membre", () => {
  it("change le rôle et les boutiques, et l'enregistre dans le journal", async () => {
    const { session, company, shop } = await ownerSession();
    const second = await createShop(company.id, "BTQ2");
    const { membership } = await addMember(company.id, "cashier@test.com", "cashier", { shopIds: [shop.id] });

    const response = await patchMember(session, membership.id, { roleCode: "manager", shopIds: [second.id] }).expect(200);

    expect(response.body.member).toMatchObject({ role: { code: "manager" }, shops: [{ id: second.id }] });
    const log = await AuditLog.findOne({ where: { action: "member.update", entityId: membership.id } });
    expect(log?.before).toMatchObject({ role: "cashier", shopIds: [shop.id] });
    expect(log?.after).toMatchObject({ role: "manager", shopIds: [second.id] });
  });

  it("un changement de rôle s'applique tout de suite, sans nouvelle connexion", async () => {
    const { session, company } = await ownerSession();
    const { membership } = await addMember(company.id, "cashier@test.com", "cashier", { allShops: true });
    const cashier = await login("cashier@test.com");
    await api().get("/api/members").set("Authorization", bearer(cashier)).expect(403);

    // On donne users.manage au rôle gérant pour ce test, puis on promeut le caissier
    const managerRole = await Role.findOne({ where: { companyId: company.id, code: "manager" } });
    await RolePermission.create({ roleId: managerRole!.id, permission: "users.manage" });
    await patchMember(session, membership.id, { roleCode: "manager" }).expect(200);

    await api().get("/api/members").set("Authorization", bearer(cashier)).expect(200);
  });

  it("interdit de modifier ses propres droits", async () => {
    const { session } = await ownerSession();
    const own = await Membership.findOne({ where: { userId: session.userId } });

    await patchMember(session, own!.id, { status: "disabled" }).expect(400);
  });

  it("garde toujours au moins un propriétaire actif", async () => {
    const { company } = await ownerSession();
    const ownerMembership = await Membership.findOne({ where: { companyId: company.id } });
    // Un gérant à qui on a donné users.manage tente de rétrograder l'unique propriétaire
    const managerRole = await Role.findOne({ where: { companyId: company.id, code: "manager" } });
    await RolePermission.create({ roleId: managerRole!.id, permission: "users.manage" });
    await addMember(company.id, "manager@test.com", "manager", { allShops: true });
    const manager = await login("manager@test.com");

    const response = await patchMember(manager, ownerMembership!.id, { roleCode: "cashier" });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("L'entreprise doit garder au moins un propriétaire actif");
  });

  it("renvoie l'invitation d'un membre pas encore activé, pas celle d'un compte actif", async () => {
    const { session, company } = await ownerSession();
    const invited = (await invite(session, { name: "Camille", email: "camille@test.com", roleCode: "cashier" })).body.member;
    const { membership: active } = await addMember(company.id, "active@test.com", "cashier");

    await api().post(`/api/members/${invited.id}/invite`).set("Authorization", bearer(session)).expect(200);
    await api().post(`/api/members/${active.id}/invite`).set("Authorization", bearer(session)).expect(409);
    expect(emailsTo("camille@test.com").filter((email) => email.type === "invitation")).toHaveLength(2);
  });
});
