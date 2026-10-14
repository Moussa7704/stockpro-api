import { Router } from "express";
import { authenticate } from "../../middlewares/auth.middleware.js";
import { validateBody } from "../../middlewares/validate.middleware.js";
import * as authController from "./auth.controller.js";
import {
  loginSchema,
  loginTwoFactorSchema,
  registerSchema,
  twoFactorCodeSchema,
} from "./auth.schemas.js";
import * as twoFactorController from "./two-factor.controller.js";

export const authRoutes = Router();

authRoutes.post("/register", validateBody(registerSchema), authController.register);
authRoutes.post("/login", validateBody(loginSchema), authController.login);
authRoutes.post(
  "/login/2fa",
  validateBody(loginTwoFactorSchema),
  authController.loginWithTwoFactor,
);
authRoutes.post("/refresh", authController.refresh);
authRoutes.post("/logout", authController.logout);
authRoutes.get("/me", authenticate, authController.me);

// Double authentification (TOTP) : réservé à un utilisateur connecté
authRoutes.post("/2fa/setup", authenticate, twoFactorController.setup);
authRoutes.post(
  "/2fa/enable",
  authenticate,
  validateBody(twoFactorCodeSchema),
  twoFactorController.enable,
);
