import { describe, expect, it } from "vitest";
import { sequelize } from "../src/config/database.js";
import { Membership, MembershipShop, Role } from "../src/models/index.js";
import { addMember, api, bearer, createCompany, login } from "./helpers/auth.js";

/**
 * RB-01 — Isolation des entreprises.
 * Modèle à reproduire dans CHAQUE module : un membre de l'entreprise B ne peut ni voir,
 * ni modifier, ni référencer une ressource de l'entreprise A. On répond 404 (et non 403)
 * pour ne même pas révéler que la ressource existe.
 */
async function twoCompanies() {
  const a = await createCompany("Commerce A", "owner-a@test.com");
  const b = await createCompany("Commerce B", "owner-b@test.com");
  const { membership: memberA } = await addMember(a.company.id, "cashier-a@test.com", "cashier", {
    shopIds: [a.shop.id],
  });
  return { a, b, memberA, ownerB: await login("owner-b@test.com") };
}

describe("Isolation entre entreprises (RB-01)", () => {
  it("les listes ne contiennent que les données de l'entreprise active", async () => {
    const { b, ownerB } = await twoCompanies();

    const shops = await api().get("/api/shops").set("Authorization", bearer(ownerB)).expect(200);
    expect(shops.body.shops.map((shop: { id: string }) => shop.id)).toEqual([b.shop.id]);

    const members = await api().get("/api/members").set("Authorization", bearer(ownerB)).expect(200);
    expect(members.body.members.map((member: { user: { email: string } }) => member.user.email)).toEqual([
      "owner-b@test.com",
    ]);

    const roles = await api().get("/api/roles").set("Authorization", bearer(ownerB)).expect(200);
    const roleIds = roles.body.roles.map((role: { id: string }) => role.id);
    expect(await Role.count({ where: { id: roleIds, companyId: b.company.id } })).toBe(roleIds.length);

    const audit = await api().get("/api/audit-logs").set("Authorization", bearer(ownerB)).expect(200);
    expect(audit.body.items.every((item: { companyId: string }) => item.companyId === b.company.id)).toBe(true);
  });

  it("une boutique de l'entreprise A est introuvable (404) depuis l'entreprise B", async () => {
    const { a, ownerB } = await twoCompanies();

    await api().get(`/api/shops/${a.shop.id}`).set("Authorization", bearer(ownerB)).expect(404);
    await api()
      .patch(`/api/shops/${a.shop.id}`)
      .set("Authorization", bearer(ownerB))
      .send({ name: "Piratée" })
      .expect(404);
  });

  it("un membre de l'entreprise A est introuvable (404) depuis l'entreprise B", async () => {
    const { memberA, ownerB } = await twoCompanies();

    await api()
      .patch(`/api/members/${memberA.id}`)
      .set("Authorization", bearer(ownerB))
      .send({ status: "disabled" })
      .expect(404);
    await api().post(`/api/members/${memberA.id}/invite`).set("Authorization", bearer(ownerB)).expect(404);

    const untouched = await Membership.findByPk(memberA.id);
    expect(untouched?.status).toBe("active");
  });

  it("on ne peut pas attribuer une boutique de l'entreprise A à un membre de B", async () => {
    const { a, ownerB } = await twoCompanies();

    await api()
      .post("/api/members")
      .set("Authorization", bearer(ownerB))
      .send({ name: "Intrus", email: "intrus@test.com", roleCode: "cashier", shopIds: [a.shop.id] })
      .expect(400);
  });

  it("on ne peut pas basculer vers l'entreprise A sans en être membre", async () => {
    const { a, ownerB } = await twoCompanies();

    await api()
      .post("/api/auth/company")
      .set("Authorization", bearer(ownerB))
      .send({ companyId: a.company.id })
      .expect(404);
  });

  // On vérifie le nom de la contrainte : le message d'erreur dépend de la langue du serveur PostgreSQL
  it("la base refuse elle-même de relier deux entreprises (clés étrangères composites)", async () => {
    const { a, b } = await twoCompanies();
    const membershipB = await Membership.findOne({ where: { companyId: b.company.id } });

    // Même en contournant l'API : une boutique de A ne peut pas être rattachée à un membre de B
    await expect(
      MembershipShop.create({ membershipId: membershipB!.id, shopId: a.shop.id, companyId: b.company.id }),
    ).rejects.toThrow(/membership_shops_shop_id_same_company_fkey/);

    // Ni un rôle de A donné à une appartenance de B
    const roleA = await Role.findOne({ where: { companyId: a.company.id, code: "manager" } });
    await expect(
      sequelize.query("UPDATE memberships SET role_id = :roleId WHERE id = :id", {
        replacements: { roleId: roleA!.id, id: membershipB!.id },
      }),
    ).rejects.toThrow(/memberships_role_id_same_company_fkey/);
  });
});
