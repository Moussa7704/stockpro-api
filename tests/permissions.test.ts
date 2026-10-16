import { describe, expect, it } from "vitest";
import { AuditLog, MembershipPermission } from "../src/models/index.js";
import { addMember, api, bearer, createCompany, createShop, login, type Session } from "./helpers/auth.js";

const get = (session: Session, path: string) => api().get(path).set("Authorization", bearer(session));
const send = (method: "post" | "put" | "patch" | "delete", session: Session, path: string, body: object = {}) =>
  api()[method](path).set("Authorization", bearer(session)).send(body);
const setPermissions = (session: Session, memberId: string, body: object) =>
  send("put", session, `/api/members/${memberId}/permissions`, body);
const me = async (session: Session) => (await get(session, "/api/auth/me").expect(200)).body;

/**
 * Entreprise avec deux boutiques : un gérant limité à BTQ1, un gestionnaire de stock sur BTQ1,
 * un caissier sur BTQ1 et un comptable (toutes boutiques).
 */
async function setup(name = "Commerce A", email = "owner@test.com") {
  const { company, shop } = await createCompany(name, email);
  const annex = await createShop(company.id, "BTQ2");
  const owner = await login(email);
  const prefix = email.split("@")[0];
  const add = async (role: Parameters<typeof addMember>[2], options: Parameters<typeof addMember>[3]) => {
    const memberEmail = `${prefix}-${role}@test.com`;
    const { membership } = await addMember(company.id, memberEmail, role, options);
    return { id: membership.id, session: await login(memberEmail) };
  };
  const manager = await add("manager", { shopIds: [shop.id] });
  const keeper = await add("stock_keeper", { shopIds: [shop.id] });
  const cashier = await add("cashier", { shopIds: [shop.id] });
  const accountant = await add("accountant", { allShops: true });
  return { company, shop, annex, owner, manager, keeper, cashier, accountant };
}

describe("Droits ajustés par membre", () => {
  it("un gérant donne la caisse à un gestionnaire de stock : effet immédiat, audité", async () => {
    const ctx = await setup();
    await send("post", ctx.keeper.session, "/api/pos/sessions", { shopId: ctx.shop.id, openingFloat: 0 }).expect(403);

    const result = (await setPermissions(ctx.manager.session, ctx.keeper.id, { grants: ["sales.create", "cash_sessions.manage"] }).expect(200))
      .body.permissions;

    expect(result).toMatchObject({ grants: ["cash_sessions.manage", "sales.create"], revokes: [], role: { code: "stock_keeper" } });
    expect(result.permissions).toEqual(expect.arrayContaining(["sales.create", "cash_sessions.manage", "stock.adjust"]));
    // Sans se reconnecter : les droits sont relus à chaque requête
    expect((await me(ctx.keeper.session)).activeCompany.permissions).toContain("sales.create");
    await send("post", ctx.keeper.session, "/api/pos/sessions", { shopId: ctx.shop.id, openingFloat: 0 }).expect(201);
    await get(ctx.keeper.session, "/api/pos/sales").expect(200);

    const audit = await AuditLog.findOne({ where: { action: "member.permissions_update", entityId: ctx.keeper.id } });
    expect(audit).toMatchObject({ before: { grants: [], revokes: [] }, after: { grants: ["cash_sessions.manage", "sales.create"], revokes: [] } });
  });

  it("retire une permission du rôle à un membre précis, puis la lui rend", async () => {
    const ctx = await setup();
    await get(ctx.cashier.session, "/api/customers").expect(200);

    await setPermissions(ctx.manager.session, ctx.cashier.id, { revokes: ["customers.manage"] }).expect(200);
    await get(ctx.cashier.session, "/api/customers").expect(403);

    // Listes vides : retour aux droits du rôle
    await setPermissions(ctx.manager.session, ctx.cashier.id, {}).expect(200);
    await get(ctx.cashier.session, "/api/customers").expect(200);
    expect(await MembershipPermission.count({ where: { membershipId: ctx.cashier.id } })).toBe(0);
  });

  it("ignore les ajustements sans effet et refuse les incohérences", async () => {
    const ctx = await setup();

    // sales.create est déjà dans le rôle caissier ; stock.adjust n'y est pas : rien à retirer
    const result = (await setPermissions(ctx.owner, ctx.cashier.id, { grants: ["sales.create"], revokes: ["stock.adjust"] }).expect(200)).body
      .permissions;
    expect(result).toMatchObject({ grants: [], revokes: [] });

    await setPermissions(ctx.owner, ctx.cashier.id, { grants: ["sales.discount"], revokes: ["sales.discount"] }).expect(400);
    await setPermissions(ctx.owner, ctx.cashier.id, { grants: ["everything.manage"] }).expect(400);
  });

  it("le propriétaire garde toujours tout", async () => {
    const ctx = await setup();
    const { membership: second } = await addMember(ctx.company.id, "owner2@test.com", "owner", { allShops: true });

    const response = await setPermissions(ctx.owner, second.id, { revokes: ["audit.view"] });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Le propriétaire a toujours toutes les permissions");
  });

  it("indique ce que l'utilisateur connecté peut accorder et modifier", async () => {
    const ctx = await setup();

    const view = (await get(ctx.manager.session, `/api/members/${ctx.keeper.id}/permissions`).expect(200)).body.permissions;
    expect(view.editable).toBe(true);
    expect(view.grantable).toContain("sales.create");
    expect(view.grantable).not.toContain("audit.view");

    const members = (await get(ctx.manager.session, "/api/members").expect(200)).body.members as { id: string; role: { code: string }; editable: boolean }[];
    const editable = Object.fromEntries(members.map((member) => [member.role.code, member.editable]));
    expect(editable).toEqual({ owner: false, manager: false, stock_keeper: true, cashier: true, accountant: false });
  });
});

describe("Délégation : jamais plus que ses propres droits", () => {
  it("on n'accorde que des permissions qu'on possède", async () => {
    const ctx = await setup();

    const response = await setPermissions(ctx.manager.session, ctx.keeper.id, { grants: ["audit.view"] });
    expect(response.status).toBe(403);
    expect(response.body.error.message).toMatch(/audit\.view/);
  });

  it("on ne touche ni à plus puissant que soi, ni à soi-même", async () => {
    const ctx = await setup();

    // Le comptable a audit.view et supplier_payments.manage, que le gérant n'a pas
    await setPermissions(ctx.manager.session, ctx.accountant.id, { revokes: ["audit.view"] }).expect(403);
    await send("patch", ctx.manager.session, `/api/members/${ctx.accountant.id}`, { status: "disabled" }).expect(403);
    await setPermissions(ctx.manager.session, ctx.manager.id, { grants: ["audit.view"] }).expect(400);

    // Un membre qui a reçu un droit que le gérant n'a pas devient hors de sa portée
    await setPermissions(ctx.owner, ctx.keeper.id, { grants: ["audit.view"] }).expect(200);
    await setPermissions(ctx.manager.session, ctx.keeper.id, { grants: ["sales.create"] }).expect(403);
  });

  it("on ne donne accès qu'à ses propres boutiques", async () => {
    const ctx = await setup();

    await send("patch", ctx.manager.session, `/api/members/${ctx.keeper.id}`, { shopIds: [ctx.shop.id, ctx.annex.id] }).expect(403);
    await send("patch", ctx.manager.session, `/api/members/${ctx.keeper.id}`, { allShops: true }).expect(403);
    // Un membre d'une boutique que le gérant ne gère pas est hors de sa portée
    const { membership: annexCashier } = await addMember(ctx.company.id, "annex@test.com", "cashier", { shopIds: [ctx.annex.id] });
    await setPermissions(ctx.manager.session, annexCashier.id, { grants: ["sales.discount"] }).expect(403);
  });

  it("à l'invitation : ni rôle plus puissant, ni propriétaire, ni boutique hors périmètre", async () => {
    const ctx = await setup();
    const invite = (body: object) => send("post", ctx.manager.session, "/api/members", { name: "Nouveau Venu", ...body });

    await invite({ email: "a@test.com", roleCode: "accountant" }).expect(403);
    await invite({ email: "b@test.com", roleCode: "owner" }).expect(403);
    await invite({ email: "c@test.com", roleCode: "cashier", shopIds: [ctx.annex.id] }).expect(403);
    await invite({ email: "d@test.com", roleCode: "cashier", allShops: true }).expect(403);

    const member = (await invite({ email: "e@test.com", roleCode: "cashier", shopIds: [ctx.shop.id] }).expect(201)).body.member;
    expect(member).toMatchObject({ role: { code: "cashier" }, allShops: false, shops: [expect.objectContaining({ id: ctx.shop.id })] });
  });

  it("changer le rôle d'un membre : seulement vers un rôle inclus dans ses droits", async () => {
    const ctx = await setup();

    await send("patch", ctx.manager.session, `/api/members/${ctx.keeper.id}`, { roleCode: "accountant" }).expect(403);
    await send("patch", ctx.manager.session, `/api/members/${ctx.keeper.id}`, { roleCode: "owner" }).expect(403);
    await send("patch", ctx.manager.session, `/api/members/${ctx.keeper.id}`, { roleCode: "cashier" }).expect(200);
  });
});

describe("Rôles personnalisés", () => {
  it("le propriétaire crée un rôle, l'attribue, le modifie : effet immédiat pour ses membres", async () => {
    const ctx = await setup();

    const role = (await send("post", ctx.owner, "/api/roles", {
      name: "Vendeur senior",
      description: "Caisse et remises",
      permissions: ["products.view", "sales.create", "sales.discount", "cash_sessions.manage"],
    }).expect(201)).body.role;
    expect(role).toMatchObject({ code: "vendeur_senior", isSystem: false, memberCount: 0, editable: true });

    const member = (await send("post", ctx.owner, "/api/members", {
      name: "Awa Diop",
      email: "awa@test.com",
      roleCode: "vendeur_senior",
      shopIds: [ctx.shop.id],
    }).expect(201)).body.member;
    expect(member.permissions).toEqual(["cash_sessions.manage", "products.view", "sales.create", "sales.discount"]);

    await send("patch", ctx.owner, `/api/roles/${role.id}`, { permissions: ["products.view", "sales.create"] }).expect(200);
    const updated = (await get(ctx.owner, `/api/members/${member.id}/permissions`).expect(200)).body.permissions;
    expect(updated.permissions).toEqual(["products.view", "sales.create"]);

    const roles = (await get(ctx.owner, "/api/roles").expect(200)).body.roles as { code: string; memberCount: number; editable: boolean }[];
    expect(roles.find((item) => item.code === "vendeur_senior")).toMatchObject({ memberCount: 1 });
    expect(roles.find((item) => item.code === "owner")).toMatchObject({ editable: false });
    expect(await AuditLog.count({ where: { entityType: "role", entityId: role.id } })).toBe(2);
  });

  it("noms uniques, rôles de base protégés, suppression seulement si inutilisé", async () => {
    const ctx = await setup();
    const role = (await send("post", ctx.owner, "/api/roles", { name: "Livreur", permissions: ["products.view"] }).expect(201)).body.role;
    const roles = (await get(ctx.owner, "/api/roles").expect(200)).body.roles as { id: string; code: string }[];
    const ownerRole = roles.find((item) => item.code === "owner")!;
    const cashierRole = roles.find((item) => item.code === "cashier")!;

    await send("post", ctx.owner, "/api/roles", { name: "livreur", permissions: ["products.view"] }).expect(409);
    await send("post", ctx.owner, "/api/roles", { name: "Vide", permissions: [] }).expect(400);
    await send("patch", ctx.owner, `/api/roles/${ownerRole.id}`, { permissions: ["products.view"] }).expect(400);
    await send("delete", ctx.owner, `/api/roles/${cashierRole.id}`).expect(400);
    // Les rôles de base restent modifiables (sauf propriétaire)
    await send("patch", ctx.owner, `/api/roles/${cashierRole.id}`, { name: "Caissière / Caissier" }).expect(200);

    await send("post", ctx.owner, "/api/members", { name: "Moussa", email: "livreur@test.com", roleCode: role.code, shopIds: [ctx.shop.id] }).expect(201);
    await send("delete", ctx.owner, `/api/roles/${role.id}`).expect(409);
  });

  it("gérer les rôles exige roles.manage, et reste borné aux droits de celui qui le fait", async () => {
    const ctx = await setup();
    await send("post", ctx.manager.session, "/api/roles", { name: "Aide", permissions: ["products.view"] }).expect(403);

    // Le propriétaire délègue la gestion des rôles au gérant
    await setPermissions(ctx.owner, ctx.manager.id, { grants: ["roles.manage"] }).expect(200);
    await send("post", ctx.manager.session, "/api/roles", { name: "Aide", permissions: ["products.view"] }).expect(201);
    await send("post", ctx.manager.session, "/api/roles", { name: "Auditeur", permissions: ["audit.view"] }).expect(403);

    const roles = (await get(ctx.manager.session, "/api/roles").expect(200)).body.roles as { id: string; code: string; editable: boolean }[];
    const accountantRole = roles.find((item) => item.code === "accountant")!;
    expect(accountantRole.editable).toBe(false);
    await send("patch", ctx.manager.session, `/api/roles/${accountantRole.id}`, { name: "Compta" }).expect(403);
  });

  it("catalogue des permissions groupées et libellées", async () => {
    const ctx = await setup();
    const groups = (await get(ctx.cashier.session, "/api/permissions").expect(200)).body.groups as { permissions: { code: string; label: string }[] }[];
    const codes = groups.flatMap((group) => group.permissions.map((permission) => permission.code));
    expect(codes).toContain("roles.manage");
    expect(new Set(codes).size).toBe(21);
  });
});

describe("Isolation entre entreprises (droits)", () => {
  it("une entreprise ne touche ni aux membres, ni aux rôles d'une autre", async () => {
    const a = await setup();
    const b = await setup("Commerce B", "owner-b@test.com");
    const roleA = (await send("post", a.owner, "/api/roles", { name: "Spécial A", permissions: ["products.view"] }).expect(201)).body.role;

    await setPermissions(b.owner, a.keeper.id, { grants: ["sales.create"] }).expect(404);
    await get(b.owner, `/api/members/${a.keeper.id}/permissions`).expect(404);
    await send("patch", b.owner, `/api/roles/${roleA.id}`, { name: "Piraté" }).expect(404);
    await send("delete", b.owner, `/api/roles/${roleA.id}`).expect(404);
    // Le code d'un rôle de A n'existe pas dans B
    await send("post", b.owner, "/api/members", { name: "X Y", email: "x@test.com", roleCode: roleA.code }).expect(400);
    const rolesB = (await get(b.owner, "/api/roles").expect(200)).body.roles as { code: string }[];
    expect(rolesB.map((role) => role.code)).not.toContain(roleA.code);
  });
});
