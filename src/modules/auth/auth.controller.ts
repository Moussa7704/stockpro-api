import type { CookieOptions, Request, Response } from "express";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/app-error.js";
import * as authService from "./auth.service.js";

const REFRESH_COOKIE = "refreshToken";

// httpOnly : illisible par le JavaScript du navigateur (protège contre le vol par XSS)
// sameSite strict : jamais envoyé depuis un autre site (protège contre le CSRF)
// path : le cookie n'est envoyé qu'aux routes /api/auth
const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/api/auth",
};

function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...refreshCookieOptions,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

function getRefreshCookie(req: Request): string | undefined {
  const token: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof token === "string" ? token : undefined;
}

export async function register(req: Request, res: Response): Promise<void> {
  // req.body a déjà été validé et nettoyé par validateBody(registerSchema)
  const user = await authService.register(req.body);
  res.status(201).json({ user });
}

export async function login(req: Request, res: Response): Promise<void> {
  const result = await authService.login(req.body);

  // 2FA activée : le client doit appeler POST /login/2fa avec ce challenge et le code
  if (result.twoFactorRequired) {
    res.json({ twoFactorRequired: true, challengeToken: result.challengeToken });
    return;
  }

  setRefreshCookie(res, result.refreshToken);
  res.json({ twoFactorRequired: false, user: result.user, accessToken: result.accessToken });
}

export async function loginWithTwoFactor(req: Request, res: Response): Promise<void> {
  const { user, accessToken, refreshToken } = await authService.loginWithTwoFactor(req.body);
  setRefreshCookie(res, refreshToken);
  res.json({ user, accessToken });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const currentToken = getRefreshCookie(req);
  if (!currentToken) {
    throw AppError.unauthorized("Session absente");
  }

  const { accessToken, refreshToken } = await authService.refresh(currentToken);
  setRefreshCookie(res, refreshToken);
  res.json({ accessToken });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const currentToken = getRefreshCookie(req);
  if (currentToken) {
    await authService.logout(currentToken);
  }

  // Les options (path…) doivent être les mêmes qu'à la création, sinon le navigateur garde le cookie
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  // req.user est garanti par le middleware authenticate placé avant
  const user = await authService.getMe(req.user!.sub);
  res.json({ user });
}
