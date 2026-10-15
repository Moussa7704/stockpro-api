import type { Request, Response } from "express";
import { auditActor } from "../audit/audit.service.js";
import * as platformService from "./platform.service.js";

// Routes réservées à l'administrateur SaaS (authenticate + requirePlatformAdmin)

export async function listCompanies(_req: Request, res: Response): Promise<void> {
  res.json({ companies: await platformService.listCompanies() });
}

export async function getCompany(req: Request<{ id: string }>, res: Response): Promise<void> {
  res.json({ company: await platformService.getCompany(req.params.id) });
}

export async function createCompany(req: Request, res: Response): Promise<void> {
  const { company, shop, owner } = await platformService.createCompany(req.body, auditActor(req));
  res.status(201).json({ company, shop, owner });
}

export async function updateCompany(req: Request<{ id: string }>, res: Response): Promise<void> {
  const company = await platformService.updateCompany(req.params.id, req.body, auditActor(req));
  res.json({ company });
}
