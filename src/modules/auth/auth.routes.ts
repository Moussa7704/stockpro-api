import { Router } from "express";
import { authenticate } from "../../middlewares/auth.middleware.js";
import {
  loginEmailLimiter,
  loginIpLimiter,
  refreshLimiter,
  registerLimiter,
  twoFactorLoginLimiter,
  twoFactorManageLimiter,
} from "../../middlewares/rate-limit.middleware.js";
import { validateBody } from "../../middlewares/validate.middleware.js";
import * as authController from "./auth.controller.js";
import {
  loginSchema,
  loginTwoFactorSchema,
  registerSchema,
  twoFactorCodeSchema,
  twoFactorConfirmSchema,
} from "./auth.schemas.js";
import * as twoFactorController from "./two-factor.controller.js";

export const authRoutes = Router();

// Les limiteurs passent avant la validation : une requête invalide compte aussi comme un essai

authRoutes.post(
  "/register",
  registerLimiter,
  validateBody(registerSchema),
  authController.register,
);
authRoutes.post(
  "/login",
  loginIpLimiter,
  loginEmailLimiter,
  validateBody(loginSchema),
  authController.login,
);
authRoutes.post(
  "/login/2fa",
  twoFactorLoginLimiter,
  validateBody(loginTwoFactorSchema),
  authController.loginWithTwoFactor,
);
authRoutes.post("/refresh", refreshLimiter, authController.refresh);
authRoutes.post("/logout", authController.logout);
authRoutes.get("/me", authenticate, authController.me);

// Double authentification (TOTP) : réservé à un utilisateur connecté
authRoutes.post("/2fa/setup", authenticate, twoFactorController.setup);
authRoutes.post(
  "/2fa/enable",
  authenticate,
  twoFactorManageLimiter,
  validateBody(twoFactorCodeSchema),
  twoFactorController.enable,
);
authRoutes.post(
  "/2fa/disable",
  authenticate,
  twoFactorManageLimiter,
  validateBody(twoFactorConfirmSchema),
  twoFactorController.disable,
);
authRoutes.post(
  "/2fa/backup-codes",
  authenticate,
  twoFactorManageLimiter,
  validateBody(twoFactorConfirmSchema),
  twoFactorController.regenerateBackupCodes,
);
