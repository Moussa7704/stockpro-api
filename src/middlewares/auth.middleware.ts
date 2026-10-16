import type { Request, RequestHandler } from "express";
import { withMeta } from "../docs/route-meta.js";
import { User } from "../models/index.js";
import { loadCompanyAccess, type CompanyAccess } from "../modules/access/access.service.js";
import type { Permission } from "../modules/access/permissions.js";
import { AppError } from "../utils/app-error.js";
import { verifyAccessToken, type AccessTokenPayload } from "../utils/jwt.js";

export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return next(AppError.unauthorized("Token manquant"));
  }

  const token = header.slice("Bearer ".length);

  // Le try/catch n'entoure que la vérification : une erreur levée plus loin
  // dans la chaîne ne doit pas être transformée en "token invalide"
  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(AppError.unauthorized("Token invalide ou expiré"));
  }

  req.user = payload;
  next();
};
withMeta(authenticate, { kind: "authenticated" });

/** Charge (une fois par requête) les droits de l'utilisateur dans son entreprise active. */
async function resolveCompanyAccess(req: Request): Promise<CompanyAccess> {
  if (req.company) {
    return req.company;
  }
  if (!req.user) {
    throw AppError.unauthorized("Token manquant");
  }
  if (!req.user.companyId) {
    throw AppError.forbidden("Choisissez une entreprise");
  }

  // L'entreprise vient du token signé, jamais du corps ou de l'URL (RB-01) ;
  // et l'appartenance est revérifiée : retirée ou désactivée → refus immédiat
  const access = await loadCompanyAccess(req.user.sub, req.user.companyId);
  if (!access) {
    throw AppError.forbidden("Vous n'avez plus accès à cette entreprise");
  }

  req.company = access;
  return access;
}

/** Route d'entreprise : exige une entreprise active accessible. À placer APRÈS authenticate. */
export const requireCompany: RequestHandler = async (req, _res, next) => {
  await resolveCompanyAccess(req);
  next();
};
withMeta(requireCompany, { kind: "company" });

/** Exige TOUTES les permissions listées dans l'entreprise active. À placer APRÈS authenticate. */
export function requirePermission(...permissions: Permission[]): RequestHandler {
  const handler: RequestHandler = async (req, _res, next) => {
    const access = await resolveCompanyAccess(req);
    if (!permissions.every((permission) => access.permissions.has(permission))) {
      throw AppError.forbidden("Vous n'avez pas les droits pour cette action");
    }
    next();
  };
  return withMeta(handler, { kind: "permission", permissions });
}

/** Back-office de la plateforme : réservé à l'administrateur SaaS (relu en base). */
export const requirePlatformAdmin: RequestHandler = async (req, _res, next) => {
  if (!req.user) {
    throw AppError.unauthorized("Token manquant");
  }

  const user = await User.findByPk(req.user.sub, { attributes: ["id", "isPlatformAdmin"] });
  if (!user?.isPlatformAdmin) {
    throw AppError.forbidden("Réservé à l'administrateur de la plateforme");
  }
  next();
};
withMeta(requirePlatformAdmin, { kind: "platformAdmin" });
