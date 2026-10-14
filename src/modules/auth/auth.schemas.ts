import { z } from "zod";

// On nettoie d'abord (espaces, majuscules), puis on vérifie le format
const email = z.string().trim().toLowerCase().pipe(z.email());

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email,
  password: z
    .string()
    .min(8)
    // bcrypt ignore silencieusement tout ce qui dépasse 72 octets
    .refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
      message: "Le mot de passe ne doit pas dépasser 72 octets",
    }),
});

export const loginSchema = z.object({
  email,
  // Au login, on ne revérifie pas les règles : on compare juste avec le hash
  password: z.string().min(1),
});

// Les applis affichent souvent "123 456" : on retire les espaces avant de vérifier
const totpCode = z
  .string()
  .transform((value) => value.replace(/\s/g, ""))
  .pipe(z.string().regex(/^\d{6}$/, "Le code doit contenir 6 chiffres"));

// Code de l'appli (6 chiffres) OU code de secours (8 caractères, tiret facultatif)
const secondFactorCode = z
  .string()
  .transform((value) => value.replace(/[\s-]/g, "").toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^(\d{6}|[A-Z0-9]{8})$/, "Code à 6 chiffres ou code de secours (XXXX-XXXX) attendu"),
  );

// Activation : seul un code de l'appli prouve que le QR a bien été scanné
export const twoFactorCodeSchema = z.object({
  code: totpCode,
});

export const loginTwoFactorSchema = z.object({
  challengeToken: z.string().min(1),
  code: secondFactorCode,
});

// Désactiver la 2FA ou régénérer les codes de secours : mot de passe + second facteur
export const twoFactorConfirmSchema = z.object({
  password: z.string().min(1),
  code: secondFactorCode,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type LoginTwoFactorInput = z.infer<typeof loginTwoFactorSchema>;
