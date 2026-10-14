/**
 * Erreur "attendue" (métier ou HTTP) : elle porte son code HTTP
 * et son message est renvoyé tel quel au client.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(message = "Requête invalide", details?: unknown) {
    return new AppError(400, message, details);
  }

  static unauthorized(message = "Non authentifié") {
    return new AppError(401, message);
  }

  static forbidden(message = "Accès refusé") {
    return new AppError(403, message);
  }

  static notFound(message = "Ressource introuvable") {
    return new AppError(404, message);
  }

  static conflict(message = "Conflit") {
    return new AppError(409, message);
  }

  static tooManyRequests(message = "Trop de requêtes, réessayez plus tard") {
    return new AppError(429, message);
  }

  static serviceUnavailable(message = "Service momentanément indisponible") {
    return new AppError(503, message);
  }
}
