import request from "supertest";
import { app } from "../../src/app.js";
import { User } from "../../src/models/index.js";
import type { UserRole } from "../../src/models/user.model.js";
import { lastOtpCode } from "./mailbox.js";

export const api = () => request(app);

export const PASSWORD = "motdepasse123";

interface NewUser {
  email?: string;
  name?: string;
  role?: UserRole;
  // null : compte invité qui n'a pas encore choisi son mot de passe
  password?: string | null;
}

/** Crée directement un utilisateur en base (le hook du modèle hash le mot de passe). */
export async function createUser({
  email = "user@test.com",
  name = "Utilisateur Test",
  role = "employee",
  password = PASSWORD,
}: NewUser = {}): Promise<User> {
  return User.create({ email, name, role, password });
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
  return { accessToken: response.body.accessToken, refreshToken, userId: response.body.user.id };
}

export const bearer = (session: Session) => `Bearer ${session.accessToken}`;
