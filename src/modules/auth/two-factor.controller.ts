import type { Request, Response } from "express";
import * as twoFactorService from "./two-factor.service.js";

// req.user est garanti par le middleware authenticate sur toutes ces routes

export async function setup(req: Request, res: Response): Promise<void> {
  const result = await twoFactorService.setup(req.user!.sub);
  res.json(result);
}

export async function enable(req: Request, res: Response): Promise<void> {
  const backupCodes = await twoFactorService.enable(req.user!.sub, req.body.code);
  // Les codes de secours ne sont affichés qu'ici : le client doit demander de les conserver
  res.json({ twoFactorEnabled: true, backupCodes });
}

export async function disable(req: Request, res: Response): Promise<void> {
  await twoFactorService.disable(req.user!.sub, req.body.password, req.body.code);
  res.json({ twoFactorEnabled: false });
}

export async function regenerateBackupCodes(req: Request, res: Response): Promise<void> {
  const backupCodes = await twoFactorService.regenerateBackupCodes(
    req.user!.sub,
    req.body.password,
    req.body.code,
  );
  res.json({ backupCodes });
}
