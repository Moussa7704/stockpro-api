import { Router } from "express";
import { validateBody } from "../../middlewares/validate.middleware.js";
import * as authController from "./auth.controller.js";
import { loginSchema,registerSchema } from "./auth.schemas.js";

export const authRoutes = Router();

authRoutes.post("/register", validateBody(registerSchema), authController.register)
authRoutes.post("/login", validateBody(loginSchema), authController.login);
