import { z } from "zod";

const dateSchema = z.iso.date("Date invalide (AAAA-MM-JJ)");

export const EXPORT_FORMATS = ["json", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// Période en jours du fuseau de l'entreprise, bornes incluses, au plus deux ans
const periodFields = {
  from: dateSchema,
  to: dateSchema,
  shopId: z.uuid().optional(),
  format: z.enum(EXPORT_FORMATS).default("json"),
};

function checkedPeriod<T extends z.ZodType<{ from: string; to: string }>>(schema: T): T {
  return schema
    .refine((value) => value.from <= value.to, { message: "La date de début doit précéder la date de fin", path: ["to"] })
    .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 731, {
      message: "Période limitée à deux ans",
      path: ["from"],
    });
}

// Tableau de bord : période facultative (une date : from = to ; un mois : du 1er au dernier jour).
// Sans période : le mois en cours jusqu'à aujourd'hui. La date de fin dans le futur est refusée par le service.
export const dashboardQuerySchema = z
  .object({ shopId: z.uuid().optional(), from: dateSchema.optional(), to: dateSchema.optional() })
  .refine((value) => (value.from === undefined) === (value.to === undefined), {
    message: "Indiquer la date de début et la date de fin",
    path: ["from"],
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, { message: "La date de début doit précéder la date de fin", path: ["to"] })
  .refine((value) => !value.from || !value.to || (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 731, {
    message: "Période limitée à deux ans",
    path: ["from"],
  });

export const periodQuerySchema = checkedPeriod(z.object(periodFields));

export const salesReportQuerySchema = checkedPeriod(
  z.object({ ...periodFields, groupBy: z.enum(["day", "week", "month"]).default("day") }),
);

export const topProductsQuerySchema = checkedPeriod(
  z.object({
    ...periodFields,
    sortBy: z.enum(["revenue", "quantity", "margin"]).default("revenue"),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
);

export const stockValueQuerySchema = z.object({
  shopId: z.uuid().optional(),
  format: z.enum(EXPORT_FORMATS).default("json"),
});

export type PeriodQuery = z.infer<typeof periodQuerySchema>;
export type SalesReportQuery = z.infer<typeof salesReportQuerySchema>;
export type TopProductsQuery = z.infer<typeof topProductsQuerySchema>;
export type StockValueQuery = z.infer<typeof stockValueQuerySchema>;
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
