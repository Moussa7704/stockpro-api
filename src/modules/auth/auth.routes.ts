import { Router } from "express";
import { authenticate } from "../../middlewares/auth.middleware.js";
import {
  changePasswordLimiter,
  forgotPasswordLimiter,
  loginEmailLimiter,
  loginIpLimiter,
  otpResendLimiter,
  otpVerifyLimiter,
  passwordTokenLimiter,
  refreshLimiter,
} from "../../middlewares/rate-limit.middleware.js";
import { validateBody } from "../../middlewares/validate.middleware.js";
import * as authController from "./auth.controller.js";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginOtpSchema,
  loginSchema,
  passwordTokenSchema,
  resendOtpSchema,
  resetPasswordSchema,
  switchCompanySchema,
} from "./auth.schemas.js";

export const authRoutes = Router();

// Pas d'inscription publique : les commerçants sont créés par l'administrateur SaaS
// (POST /api/platform/companies), puis le propriétaire invite son équipe (POST /api/members)
// Les limiteurs passent avant la validation : une requête invalide compte aussi comme un essai

// Connexion en deux temps : mot de passe → code reçu par email → session
authRoutes.post(
  "/login",
  loginIpLimiter,
  loginEmailLimiter,
  validateBody(loginSchema),
  authController.login,
);
authRoutes.post(
  "/login/otp",
  otpVerifyLimiter,
  validateBody(loginOtpSchema),
  authController.loginWithOtp,
);
authRoutes.post(
  "/login/otp/resend",
  otpResendLimiter,
  validateBody(resendOtpSchema),
  authController.resendOtp,
);

authRoutes.post("/refresh", refreshLimiter, authController.refresh);
authRoutes.post("/logout", authController.logout);
authRoutes.get("/me", authenticate, authController.me);

// Choix de l'entreprise active (utilisateur membre de plusieurs entreprises)
authRoutes.post(
  "/company",
  authenticate,
  validateBody(switchCompanySchema),
  authController.switchCompany,
);

// Mot de passe : lien reçu par email (mot de passe oublié ou invitation d'un admin)
authRoutes.post(
  "/password/forgot",
  forgotPasswordLimiter,
  validateBody(forgotPasswordSchema),
  authController.forgotPassword,
);
authRoutes.post(
  "/password/check",
  passwordTokenLimiter,
  validateBody(passwordTokenSchema),
  authController.checkPasswordToken,
);
authRoutes.post(
  "/password/reset",
  passwordTokenLimiter,
  validateBody(resetPasswordSchema),
  authController.resetPassword,
);

// Changement de mot de passe par l'utilisateur connecté (ancien mot de passe requis)
authRoutes.post(
  "/password/change",
  authenticate,
  changePasswordLimiter,
  validateBody(changePasswordSchema),
  authController.changePassword,
);
