import { describe, expect, it } from "vitest";
import { User } from "../src/models/index.js";
import { api, bearer, createUser, login, type Session } from "./helpers/auth.js";
import { emailsTo, lastLinkToken } from "./helpers/mailbox.js";

const ADMIN_EMAIL = "admin@test.com";
const NEW_USER = { name: "Emma Employee", email: "emma@test.com", role: "employee" };

async function loginAsAdmin(): Promise<Session> {
  await createUser({ email: ADMIN_EMAIL, name: "Admin Test", role: "admin" });
  return login(ADMIN_EMAIL);
}

const invite = (admin: Session, body: object = NEW_USER) =>
  api().post("/api/users").set("Authorization", bearer(admin)).send(body);

describe("Inscription publique", () => {
  it("n'existe plus", async () => {
    const response = await api()
      .post("/api/auth/register")
      .send({ name: "Pirate", email: "pirate@test.com", password: "motdepasse123" });

    expect(response.status).toBe(404);
  });
});

describe("Accès à /api/users", () => {
  it("refuse sans token", async () => {
    await api().get("/api/users").expect(401);
  });

  it.each(["employee", "manager"] as const)("refuse le rôle %s", async (role) => {
    await createUser({ email: "someone@test.com", role });
    const session = await login("someone@test.com");

    const response = await api().get("/api/users").set("Authorization", bearer(session));

    expect(response.status).toBe(403);
  });

  it("retire l'accès dès qu'un admin est rétrogradé, sans attendre l'expiration de son token", async () => {
    const admin = await loginAsAdmin();
    await createUser({ email: "second@test.com", role: "admin" });
    const second = await login("second@test.com");
    await api().get("/api/users").set("Authorization", bearer(second)).expect(200);

    await api()
      .patch(`/api/users/${second.userId}`)
      .set("Authorization", bearer(admin))
      .send({ role: "employee" })
      .expect(200);

    // Son token contient encore role: "admin", mais le rôle est relu en base
    await api().get("/api/users").set("Authorization", bearer(second)).expect(403);
  });
});

describe("Création de comptes par un admin", () => {
  it("crée un compte sans mot de passe et envoie une invitation", async () => {
    const admin = await loginAsAdmin();

    const response = await invite(admin).expect(201);

    expect(response.body.user).toMatchObject({
      email: "emma@test.com",
      role: "employee",
      invitationPending: true,
    });
    expect(emailsTo("emma@test.com").map((email) => email.type)).toEqual(["invitation"]);
  });

  it("ignore un mot de passe envoyé par l'admin", async () => {
    const admin = await loginAsAdmin();

    await invite(admin, { ...NEW_USER, password: "jechoisis123" }).expect(201);

    const created = await User.findOne({ where: { email: "emma@test.com" } });
    expect(created?.password).toBeNull();
  });

  it("l'invité choisit son mot de passe puis peut se connecter", async () => {
    const admin = await loginAsAdmin();
    await invite(admin);
    const token = lastLinkToken("invitation", "emma@test.com");

    const check = await api().post("/api/auth/password/check").send({ token }).expect(200);
    expect(check.body.purpose).toBe("invite");

    await api()
      .post("/api/auth/password/reset")
      .send({ token, password: "emmapass123" })
      .expect(200);

    const session = await login("emma@test.com", "emmapass123");
    expect(session.accessToken).toEqual(expect.any(String));
    // Premier mot de passe : pas d'alerte "mot de passe modifié"
    expect(emailsTo("emma@test.com").map((email) => email.type)).not.toContain("password-changed");
  });

  it("refuse un email déjà utilisé", async () => {
    const admin = await loginAsAdmin();
    await invite(admin).expect(201);

    const response = await invite(admin, { ...NEW_USER, email: "EMMA@test.com" });

    expect(response.status).toBe(409);
  });

  it("refuse un rôle inconnu", async () => {
    const admin = await loginAsAdmin();

    await invite(admin, { ...NEW_USER, role: "superadmin" }).expect(400);
  });

  it("liste les comptes sans jamais exposer les mots de passe", async () => {
    const admin = await loginAsAdmin();
    await invite(admin);

    const response = await api().get("/api/users").set("Authorization", bearer(admin)).expect(200);

    expect(response.body.users).toHaveLength(2);
    for (const user of response.body.users) {
      expect(user.password).toBeUndefined();
    }
  });
});

describe("Modification du rôle", () => {
  it("change le rôle d'un autre utilisateur", async () => {
    const admin = await loginAsAdmin();
    const created = (await invite(admin)).body.user;

    const response = await api()
      .patch(`/api/users/${created.id}`)
      .set("Authorization", bearer(admin))
      .send({ role: "manager" })
      .expect(200);

    expect(response.body.user.role).toBe("manager");
  });

  it("interdit à un admin de changer son propre rôle", async () => {
    const admin = await loginAsAdmin();

    const response = await api()
      .patch(`/api/users/${admin.userId}`)
      .set("Authorization", bearer(admin))
      .send({ role: "employee" });

    expect(response.status).toBe(400);
  });

  it("répond 400 pour un identifiant invalide et 404 pour un compte inconnu", async () => {
    const admin = await loginAsAdmin();

    await api()
      .patch("/api/users/123")
      .set("Authorization", bearer(admin))
      .send({ role: "manager" })
      .expect(400);
    await api()
      .patch("/api/users/00000000-0000-4000-8000-000000000000")
      .set("Authorization", bearer(admin))
      .send({ role: "manager" })
      .expect(404);
  });
});

describe("Renvoi de l'invitation", () => {
  it("envoie un nouveau lien et invalide l'ancien", async () => {
    const admin = await loginAsAdmin();
    const created = (await invite(admin)).body.user;
    const firstToken = lastLinkToken("invitation", "emma@test.com");

    await api()
      .post(`/api/users/${created.id}/invite`)
      .set("Authorization", bearer(admin))
      .expect(200);

    await api().post("/api/auth/password/check").send({ token: firstToken }).expect(400);
    await api()
      .post("/api/auth/password/check")
      .send({ token: lastLinkToken("invitation", "emma@test.com") })
      .expect(200);
  });

  it("refuse pour un compte déjà activé", async () => {
    const admin = await loginAsAdmin();
    const active = await createUser({ email: "active@test.com" });

    const response = await api()
      .post(`/api/users/${active.id}/invite`)
      .set("Authorization", bearer(admin));

    expect(response.status).toBe(409);
  });
});
