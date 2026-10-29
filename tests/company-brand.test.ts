import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/models/index.js";
import { contrastRatio } from "../src/utils/color.js";
import { addMember, api, bearer, createCompany, login, type Session } from "./helpers/auth.js";

const patch = (session: Session, body: object) => api().patch("/api/company").set("Authorization", bearer(session)).send(body);
const me = async (session: Session) => (await api().get("/api/auth/me").set("Authorization", bearer(session)).expect(200)).body;

describe("Couleur de l'interface", () => {
  it("contraste WCAG : noir sur blanc = 21, la couleur StockPro est lisible sous du texte blanc", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#4f46e5", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#facc15", "#ffffff")).toBeLessThan(4.5);
  });

  it("le propriétaire la choisit : enregistrée en minuscules, renvoyée par /me, tracée dans l'audit", async () => {
    const { company } = await createCompany("Commerce A", "owner@test.com");
    const owner = await login("owner@test.com");
    expect((await me(owner)).activeCompany.brandColor).toBeNull();

    const response = await patch(owner, { settings: { brandColor: "#0F766E" } }).expect(200);

    expect(response.body.company.settings.brandColor).toBe("#0f766e");
    expect((await me(owner)).activeCompany.brandColor).toBe("#0f766e");
    const audit = await AuditLog.findOne({ where: { companyId: company.id, action: "company.settings_update" } });
    expect(audit?.after).toMatchObject({ settings: { brandColor: "#0f766e" } });
  });

  it("refuse une couleur illisible ou mal écrite, avec un message clair", async () => {
    await createCompany("Commerce A", "owner@test.com");
    const owner = await login("owner@test.com");

    const tooLight = await patch(owner, { settings: { brandColor: "#FACC15" } }).expect(400);
    expect(JSON.stringify(tooLight.body.error.details)).toContain("Couleur trop claire");
    for (const brandColor of ["red", "#12345", "#gggggg", "0f766e"]) {
      await patch(owner, { settings: { brandColor } }).expect(400);
    }
    expect((await me(owner)).activeCompany.brandColor).toBeNull();
  });

  it("null revient à la couleur StockPro sans toucher aux autres réglages", async () => {
    await createCompany("Commerce A", "owner@test.com");
    const owner = await login("owner@test.com");
    await patch(owner, { settings: { maxCashierDiscountPercent: 10, brandColor: "#0f766e" } }).expect(200);

    const response = await patch(owner, { settings: { brandColor: null } }).expect(200);

    expect(response.body.company.settings).toMatchObject({ maxCashierDiscountPercent: 10, brandColor: null });
    expect((await me(owner)).activeCompany.brandColor).toBeNull();
  });

  it("réservée à company.manage ; chaque entreprise a la sienne, visible de tous ses membres", async () => {
    const { company } = await createCompany("Commerce A", "owner@test.com");
    await createCompany("Commerce B", "owner-b@test.com");
    await addMember(company.id, "cashier@test.com", "cashier");
    const owner = await login("owner@test.com");
    const cashier = await login("cashier@test.com");

    await patch(cashier, { settings: { brandColor: "#0f766e" } }).expect(403);
    await patch(owner, { settings: { brandColor: "#b91c1c" } }).expect(200);

    expect((await me(cashier)).activeCompany.brandColor).toBe("#b91c1c");
    expect((await me(await login("owner-b@test.com"))).activeCompany.brandColor).toBeNull();
  });

  it("le gérant paramètre l'entreprise par défaut ; le propriétaire peut le lui retirer", async () => {
    const { company } = await createCompany("Commerce A", "owner@test.com");
    const { membership } = await addMember(company.id, "manager@test.com", "manager");
    const owner = await login("owner@test.com");
    const manager = await login("manager@test.com");

    await patch(manager, { name: "Commerce A & Fils", settings: { maxCashierDiscountPercent: 5 } }).expect(200);
    const audit = await AuditLog.findOne({ where: { companyId: company.id, action: "company.settings_update" } });
    expect(audit?.after).toMatchObject({ name: "Commerce A & Fils", settings: { maxCashierDiscountPercent: 5 } });

    await api()
      .put(`/api/members/${membership.id}/permissions`)
      .set("Authorization", bearer(owner))
      .send({ revokes: ["company.manage"] })
      .expect(200);
    await patch(manager, { settings: { brandColor: "#0f766e" } }).expect(403);
  });
});
