import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { env } from "./env.js";

/**
 * Journal du serveur (pino) : une ligne JSON par événement en production (facile à filtrer et
 * à envoyer vers un service de logs), lisible et en couleurs en développement, muet en test.
 * Niveau réglable par LOG_LEVEL (debug affiche aussi les requêtes SQL).
 *
 * Jamais de secret dans le journal : les champs sensibles sont masqués où qu'ils apparaissent.
 */

// Le corps des requêtes n'est jamais journalisé (les codes OTP n'y passent donc pas). On ne masque
// pas « code » : ce serait aussi cacher le code des erreurs système et PostgreSQL (ECONNREFUSED, 23505…)
const SECRET_FIELDS = [
  "password",
  "currentPassword",
  "newPassword",
  "otp",
  "token",
  "refreshToken",
  "accessToken",
  "challengeToken",
  "authorization",
  "cookie",
  "secret",
];

export const REDACTED = "[masqué]";

export function loggerOptions(): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    base: { service: "stockpro-api" },
    // Masquage à la racine et un niveau en dessous (ex. body.password, headers.cookie, err.config…)
    redact: {
      paths: [...SECRET_FIELDS, ...SECRET_FIELDS.map((field) => `*.${field}`), "req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
      censor: REDACTED,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

/** Logger créé à part (tests) : même configuration, vers la sortie de son choix. */
export function createLogger(destination?: DestinationStream): Logger {
  return destination ? pino(loggerOptions(), destination) : pino(loggerOptions());
}

// En dev, une ligne courte par requête (le message dit déjà méthode, adresse, statut et durée) ;
// les erreurs gardent tout leur détail. En production, tout reste dans la ligne JSON.
const DEV_HIDDEN_FIELDS = "pid,hostname,service,req,res,responseTime";

export const logger: Logger =
  env.NODE_ENV === "development"
    ? pino({ ...loggerOptions(), transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: DEV_HIDDEN_FIELDS } } })
    : createLogger();
