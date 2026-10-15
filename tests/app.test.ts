import { describe, expect, it } from "vitest";
import { api } from "./helpers/auth.js";

describe("Socle de l'API", () => {
  it("répond à /health", async () => {
    const response = await api().get("/health").expect(200);

    expect(response.body).toEqual({ status: "ok" });
  });

  it("pose les en-têtes de sécurité (helmet) et masque Express", async () => {
    const response = await api().get("/health");

    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["strict-transport-security"]).toBeDefined();
    expect(response.headers["content-security-policy"]).toBeDefined();
  });

  it("renvoie une 404 au format JSON de l'API", async () => {
    const response = await api().get("/api/nexiste-pas").expect(404);

    expect(response.body).toEqual({ error: { message: "Route introuvable : GET /api/nexiste-pas" } });
  });

  it("renvoie une 400 lisible pour un JSON mal formé", async () => {
    const response = await api()
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": ');

    expect(response.status).toBe(400);
    expect(response.body.error.message).toEqual(expect.any(String));
  });

  it("détaille les erreurs de validation", async () => {
    const response = await api().post("/api/auth/login").send({ email: "pas-un-email" }).expect(400);

    expect(response.body.error.message).toBe("Données invalides");
    expect(response.body.error.details.map((detail: { field: string }) => detail.field)).toEqual(
      expect.arrayContaining(["email", "password"]),
    );
  });
});
