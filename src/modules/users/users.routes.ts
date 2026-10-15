import { Router } from "express";
import { authenticate, requireRole } from "../../middlewares/auth.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import * as usersController from "./users.controller.js";
import { createUserSchema, updateUserSchema, userIdParamsSchema } from "./users.schemas.js";

export const usersRoutes = Router();

// Gestion des comptes : réservée aux admins pour toutes les routes de ce module
usersRoutes.use(authenticate, requireRole("admin"));

usersRoutes.get("/", usersController.list);
usersRoutes.post("/", validateBody(createUserSchema), usersController.create);
usersRoutes.patch(
  "/:id",
  validateParams(userIdParamsSchema),
  validateBody(updateUserSchema),
  usersController.update,
);
usersRoutes.post(
  "/:id/invite",
  validateParams(userIdParamsSchema),
  usersController.resendInvitation,
);
