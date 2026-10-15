import request from "supertest";
import { app } from "../../src/app.js";
import { Membership, MembershipShop, Role, Shop, User, type Company } from "../../src/models/index.js";
import type { SystemRoleCode } from "../../src/modules/access/permissions.js";
import * as platformService from "../../src/modules/platform/platform.service.js";
import { lastOtpCode } from "./mailbox.js";

export const api = () => request(app);

export const PASSWORD = "motdepasse123";

interface NewUser {
  email?: string;
  name?: string;
  isPlatformAdmin?: boolean;
  // null : compte invité qui n'a pas encore choisi son mot de passe
  password?: string | null;
}

/** Crée directement un utilisateur en base (le hook du modèle hash le mot de passe). */
export async function createUser({
  email = "user@test.com",
  name = "Utilisateur Test",
  isPlatformAdmin = false,
  password = PASSWORD,
}: NewUser = {}): Promise<User> {
  return User.create({ email, name, isPlatformAdmin, password });
}

export interface TestCompany {
  company: Company;
  shop: Shop; // boutique créée avec l'entreprise (BTQ1)
  owner: User;
}

/**
 * Crée un commerçant comme le ferait l'administrateur SaaS (rôles système, boutique BTQ1,
 * propriétaire), puis donne directement un mot de passe au propriétaire.
 */
export async function createCompany(name: string, ownerEmail: string): Promise<TestCompany> {
  const { company, shop, owner } = await platformService.createCompany(
    {
      name,
      currency: "XOF",
      timezone: "Africa/Abidjan",
      shopName: "Boutique principale",
      owner: { name: `Propriétaire ${name}`, email: ownerEmail },
    },
    { actorUserId: null, ip: null },
  );
  if (owner.password === null) {
    owner.password = PASSWORD;
    await owner.save();
  }
  return { company, shop, owner };
}

/** Ajoute directement un membre actif (avec mot de passe) à une entreprise. */
export async function addMember(
  companyId: string,
  email: string,
  roleCode: SystemRoleCode,
  { allShops = false, shopIds = [] as string[] } = {},
): Promise<{ user: User; membership: Membership }> {
  const user = (await User.findOne({ where: { email } })) ?? (await createUser({ email, name: email }));
  const role = await Role.findOne({ where: { companyId, code: roleCode } });
  const membership = await Membership.create({ companyId, userId: user.id, roleId: role!.id, allShops });
  await MembershipShop.bulkCreate(shopIds.map((shopId) => ({ membershipId: membership.id, shopId, companyId })));
  return { user, membership };
}

export async function createShop(companyId: string, code: string): Promise<Shop> {
  return Shop.create({ companyId, code, name: `Boutique ${code}` });
}

/** Extrait la valeur du cookie refreshToken d'une réponse (undefined s'il n'est pas posé). */
export function refreshCookieOf(response: request.Response): string | undefined {
  const raw = response.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = raw?.find((value) => value.startsWith("refreshToken="));
  const token = cookie?.split(";")[0]?.slice("refreshToken=".length);
  return token ? token : undefined;
}

export const cookieHeader = (refreshToken: string) => `refreshToken=${refreshToken}`;

/** Étape 1 du login : renvoie le challengeToken (le code est dans la boîte simulée). */
export async function startLogin(email: string, password = PASSWORD): Promise<string> {
  const response = await api().post("/api/auth/login").send({ email, password }).expect(200);
  return response.body.challengeToken as string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  activeCompanyId: string | null;
}

/** Connexion complète : mot de passe puis code OTP lu dans la boîte simulée. */
export async function login(email: string, password = PASSWORD): Promise<Session> {
  const challengeToken = await startLogin(email, password);
  const response = await api()
    .post("/api/auth/login/otp")
    .send({ challengeToken, code: lastOtpCode(email) })
    .expect(200);

  const refreshToken = refreshCookieOf(response);
  if (!refreshToken) {
    throw new Error("Cookie refreshToken absent après le login");
  }
  return {
    accessToken: response.body.accessToken,
    refreshToken,
    userId: response.body.user.id,
    activeCompanyId: response.body.activeCompanyId,
  };
}

/** Choisit l'entreprise active ; renvoie la session avec le nouvel access token. */
export async function switchCompany(session: Session, companyId: string): Promise<Session> {
  const response = await api()
    .post("/api/auth/company")
    .set("Authorization", bearer(session))
    .set("Cookie", cookieHeader(session.refreshToken))
    .send({ companyId })
    .expect(200);
  return { ...session, accessToken: response.body.accessToken, activeCompanyId: companyId };
}

export const bearer = (session: Session) => `Bearer ${session.accessToken}`;
