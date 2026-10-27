import type { RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { withMeta } from "../docs/route-meta.js";
import { AppError } from "../utils/app-error.js";
import { extensionOf } from "../utils/spreadsheet.js";

interface UploadOptions {
  /** Extensions acceptées, ex. [".xlsx", ".csv"] */
  extensions: readonly string[];
  maxBytes: number;
  /**
   * Schéma du champ texte "options" (JSON) envoyé avec le fichier ; une fois validé, il remplace
   * req.body. Sans schéma, aucun autre champ n'est attendu.
   */
  options?: z.ZodType;
}

const MULTER_MESSAGES: Partial<Record<multer.ErrorCode, string>> = {
  LIMIT_FILE_SIZE: "Fichier trop volumineux",
  LIMIT_FILE_COUNT: "Un seul fichier à la fois",
  LIMIT_UNEXPECTED_FILE: 'Le fichier doit être envoyé dans le champ "file"',
};

/**
 * Réception d'un fichier (multipart/form-data, champ "file"), gardé en mémoire le temps de la
 * requête : rien n'est écrit sur le disque. req.file contient le fichier, req.body les options.
 */
export function uploadFile({ extensions, maxBytes, options }: UploadOptions): RequestHandler {
  const receive = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5, fieldSize: 64 * 1024 },
  }).single("file");

  const handler: RequestHandler = (req, res, next) => {
    receive(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        const message = MULTER_MESSAGES[error.code] ?? "Envoi du fichier invalide";
        return next(AppError.badRequest(error.code === "LIMIT_FILE_SIZE" ? `${message} (${maxBytes / 1024 / 1024} Mo max)` : message));
      }
      if (error) {
        return next(error);
      }
      if (!req.file) {
        return next(AppError.badRequest('Fichier manquant (champ "file" en multipart/form-data)'));
      }
      if (!extensions.includes(extensionOf(req.file.originalname))) {
        return next(AppError.badRequest(`Format non pris en charge : ${extensions.join(" ou ")} attendu`));
      }

      if (!options) {
        req.body = {};
        return next();
      }
      let raw: unknown;
      try {
        raw = JSON.parse((req.body as { options?: string } | undefined)?.options ?? "{}");
      } catch {
        return next(AppError.badRequest('Champ "options" : JSON invalide'));
      }
      const result = options.safeParse(raw);
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          field: ["options", ...issue.path.map(String)].join("."),
          message: issue.message,
        }));
        return next(AppError.badRequest("Options invalides", details));
      }
      req.body = result.data;
      next();
    });
  };
  return withMeta(handler, { kind: "upload", extensions, ...(options && { options }) });
}
