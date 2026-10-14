import { Router } from "express";
import { authenticate } from "../../middlewares/auth.middleware.js";
import {
  loginEmailLimiter,
  loginIpLimiter,
  otpResendLimiter,
  otpVerifyLimiter,
  refreshLimiter,
  registerLimiter,
} from "../../middlewares/rate-limit.middleware.js";
import { validateBody } from "../../middlewares/validate.middleware.js";
import * as authController from "./auth.controller.js";
import { loginOtpSchema, loginSchema, registerSchema, resendOtpSchema } from "./auth.schemas.js";

export const authRoutes = Router();

// Les limiteurs passent avant la validation : une requête invalide compte aussi comme un essai

authRoutes.post(
  "/register",
  registerLimiter,
  validateBody(registerSchema),
  authController.register,
);

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
