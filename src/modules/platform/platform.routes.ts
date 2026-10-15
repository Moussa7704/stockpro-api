import { Router } from "express";
import { authenticate, requirePlatformAdmin } from "../../middlewares/auth.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { uuidParamsSchema } from "../../utils/query.js";
import * as platformController from "./platform.controller.js";
import { createCompanySchema, updateCompanySchema } from "./platform.schemas.js";

export const platformRoutes = Router();

// Back-office de la plateforme : réservé à l'administrateur SaaS (décision D-04)
platformRoutes.use(authenticate, requirePlatformAdmin);

platformRoutes.get("/companies", platformController.listCompanies);
platformRoutes.post("/companies", validateBody(createCompanySchema), platformController.createCompany);
platformRoutes.get("/companies/:id", validateParams(uuidParamsSchema), platformController.getCompany);
platformRoutes.patch(
  "/companies/:id",
  validateParams(uuidParamsSchema),
  validateBody(updateCompanySchema),
  platformController.updateCompany,
);
