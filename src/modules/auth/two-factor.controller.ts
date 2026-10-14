import type { Request, Response } from "express";
import * as twoFactorService from "./two-factor.service.js";

// req.user est garanti par le middleware authenticate sur toutes ces routes

export async function setup(req: Request, res: Response): Promise<void> {
  const result = await twoFactorService.setup(req.user!.sub);
  res.json(result);
}

export async function enable(req: Request, res: Response): Promise<void> {
  await twoFactorService.enable(req.user!.sub, req.body.code);
  res.json({ twoFactorEnabled: true });
}
