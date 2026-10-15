import type { CookieOptions, Request, Response } from "express";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/app-error.js";
import * as authService from "./auth.service.js";
import * as passwordService from "./password.service.js";

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

export async function login(req: Request, res: Response): Promise<void> {
  // Mot de passe correct : un code est envoyé par email, la session n'existe pas encore
  const result = await authService.login(req.body);
  res.json({ otpRequired: true, ...result });
}

export async function loginWithOtp(req: Request, res: Response): Promise<void> {
  const { user, accessToken, refreshToken } = await authService.loginWithOtp(req.body);
  setRefreshCookie(res, refreshToken);
  res.json({ user, accessToken });
}

export async function resendOtp(req: Request, res: Response): Promise<void> {
  const result = await authService.resendOtp(req.body.challengeToken);
  res.json({ resent: true, ...result });
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

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  await passwordService.requestPasswordReset(req.body.email);
  // Toujours la même réponse : on ne révèle pas si un compte existe avec cet email
  res.json({ message: "Si un compte existe avec cet email, un lien de réinitialisation a été envoyé" });
}

export async function checkPasswordToken(req: Request, res: Response): Promise<void> {
  const result = await passwordService.inspectToken(req.body.token);
  res.json(result);
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  await passwordService.setPasswordWithToken(req.body.token, req.body.password);
  res.json({ message: "Mot de passe enregistré, vous pouvez vous connecter" });
}
