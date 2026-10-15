import { Router } from "express";
import { authenticate } from "../../middlewares/auth.middleware.js";
import {
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
  forgotPasswordSchema,
  loginOtpSchema,
  loginSchema,
  passwordTokenSchema,
  resendOtpSchema,
  resetPasswordSchema,
} from "./auth.schemas.js";

export const authRoutes = Router();

// Pas d'inscription publique : les comptes sont créés par un admin (POST /api/users)
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
