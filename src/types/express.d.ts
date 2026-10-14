import type { AccessTokenPayload } from "../utils/jwt.js";

declare global {
  namespace Express {
    interface Request {
      // Rempli par le middleware authenticate
      user?: AccessTokenPayload;
    }
  }
}

export {};
