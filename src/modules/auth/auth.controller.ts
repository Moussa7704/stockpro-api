import type { Request, Response } from "express";
import * as authService from "./auth.service.js";

export async function register(req: Request, res: Response): Promise<void> {
  // req.body a déjà été validé et nettoyé par validateBody(registerSchema)
  const user = await authService.register(req.body);
  res.status(201).json({ user });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { user, accessToken } = await authService.login(req.body);
  res.json({ user, accessToken });
}
