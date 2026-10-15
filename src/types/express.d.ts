import type { CompanyAccess } from "../modules/access/access.service.js";
import type { AccessTokenPayload } from "../utils/jwt.js";

declare global {
  namespace Express {
    interface Request {
      // Rempli par le middleware authenticate : utilisateur + entreprise active du token
      user?: AccessTokenPayload;
      // Rempli par requireCompany / requirePermission : droits relus en base pour l'entreprise active
      company?: CompanyAccess;
    }
  }
}

export {};
