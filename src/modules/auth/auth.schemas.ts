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

export const twoFactorCodeSchema = z.object({
  code: totpCode,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
