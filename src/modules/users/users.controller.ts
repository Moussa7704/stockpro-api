import type { Request, Response } from "express";
import * as usersService from "./users.service.js";

// Toutes ces routes passent par authenticate + requireRole("admin") : req.user est défini

export async function list(_req: Request, res: Response): Promise<void> {
  const users = await usersService.listUsers();
  res.json({ users });
}

export async function create(req: Request, res: Response): Promise<void> {
  const user = await usersService.createUser(req.body, req.user!.sub);
  res.status(201).json({ user });
}

export async function update(req: Request<{ id: string }>, res: Response): Promise<void> {
  const user = await usersService.updateUser(req.params.id, req.body, req.user!.sub);
  res.json({ user });
}

export async function resendInvitation(req: Request<{ id: string }>, res: Response): Promise<void> {
  await usersService.resendInvitation(req.params.id, req.user!.sub);
  res.json({ message: "Invitation renvoyée" });
}
