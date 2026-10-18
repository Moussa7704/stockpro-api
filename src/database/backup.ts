import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";

/**
 * Sauvegardes de la base (pg_dump au format « custom » : compressé, restaurable table par table).
 *
 * Conservation (« grand-père, père, fils ») : la plus récente de chacun des 7 derniers jours,
 * de chacune des 4 dernières semaines et de chacun des 12 derniers mois. Une sauvegarde qui
 * remplit plusieurs rôles n'est gardée qu'une fois.
 *
 * Outils PostgreSQL : pris dans PG_BIN_DIR s'il est défini (ex. Windows), sinon dans le PATH.
 * Leur version doit être celle du serveur, ou plus récente.
 */

export const RETENTION = { daily: 7, weekly: 4, monthly: 12 } as const;

const FILE_PATTERN = /^stockpro_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.dump$/;

/** stockpro_2026-10-18T02-00-00Z.dump : triable, sans « : » (interdit sous Windows). */
export function backupFileName(date: Date): string {
  return `stockpro_${date.toISOString().slice(0, 19).replaceAll(":", "-")}Z.dump`;
}

export function backupDate(fileName: string): Date | null {
  const match = FILE_PATTERN.exec(fileName);
  return match ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) : null;
}

/** Semaine ISO (lundi → dimanche) : « 2026-W42 ». */
function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Sauvegardes à garder parmi `fileNames` ; les fichiers d'un autre nom ne sont jamais touchés. */
export function selectBackupsToKeep(fileNames: string[], retention = RETENTION): Set<string> {
  const dated = fileNames
    .map((name) => ({ name, date: backupDate(name) }))
    .filter((item): item is { name: string; date: Date } => item.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const keep = new Set<string>();
  const newestPer = (period: (date: Date) => string, count: number) => {
    const seen = new Set<string>();
    for (const { name, date } of dated) {
      const key = period(date);
      if (seen.has(key)) continue;
      if (seen.size === count) break;
      seen.add(key);
      keep.add(name);
    }
  };
  newestPer((date) => date.toISOString().slice(0, 10), retention.daily);
  newestPer(isoWeek, retention.weekly);
  newestPer((date) => date.toISOString().slice(0, 7), retention.monthly);
  return keep;
}

/** Prochaine exécution à `hour` h (heure locale du processus : variable TZ dans Docker). */
export function nextRunAt(now: Date, hour: number): Date {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

// --- Outils PostgreSQL

interface Connection {
  user?: string;
  password?: string;
  database?: string;
}

function tool(name: string): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return env.PG_BIN_DIR ? path.join(env.PG_BIN_DIR, exe) : exe;
}

/** Lance un outil PostgreSQL ; le mot de passe passe par l'environnement, jamais en argument. */
function runTool(name: string, args: string[], connection: Connection = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool(name), args, {
      env: {
        ...process.env,
        PGHOST: env.DB_HOST,
        PGPORT: String(env.DB_PORT),
        PGUSER: connection.user ?? env.DB_USER,
        PGPASSWORD: connection.password ?? env.DB_PASSWORD,
        PGDATABASE: connection.database ?? env.DB_NAME,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) =>
      reject(new Error(`${name} introuvable (${error.message}) : installez les outils PostgreSQL ou indiquez PG_BIN_DIR`)),
    );
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${name} a échoué (code ${code}) : ${stderr.trim()}`))));
  });
}

export const backupDir = () => path.resolve(env.BACKUP_DIR);

/** Liste des sauvegardes, de la plus récente à la plus ancienne. */
export async function listBackups(dir = backupDir()): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  return (await readdir(dir)).filter((name) => backupDate(name) !== null).sort().reverse();
}

/** Sauvegarde complète ; écrite sous un nom provisoire puis renommée : jamais de fichier à moitié écrit. */
export async function createBackup(dir = backupDir(), now = new Date()): Promise<{ file: string; sizeBytes: number }> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, backupFileName(now));
  const partial = `${file}.partial`;
  try {
    await runTool("pg_dump", ["--format=custom", "--compress=6", "--no-owner", "--no-privileges", `--file=${partial}`]);
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return { file, sizeBytes: (await stat(file)).size };
}

/** Supprime les sauvegardes hors de la règle de conservation ; renvoie les fichiers supprimés. */
export async function pruneBackups(dir = backupDir()): Promise<string[]> {
  const files = await listBackups(dir);
  const keep = selectBackupsToKeep(files);
  const removed = files.filter((name) => !keep.has(name));
  for (const name of removed) await rm(path.join(dir, name));
  return removed;
}

/**
 * Restaure une sauvegarde dans `database` (par défaut la base de l'application), en une seule
 * transaction : en cas d'erreur, la base reste telle qu'avant. Les tables existantes sont remplacées.
 */
export async function restoreBackup(file: string, database = env.DB_NAME, connection: Connection = {}): Promise<void> {
  await runTool(
    "pg_restore",
    ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error", `--dbname=${database}`, file],
    { ...connection, database },
  );
}

export interface VerifyReport {
  file: string;
  migrations: number;
  lastMigration: string | null;
  tables: Record<string, number>;
}

const CHECKED_TABLES = ["companies", "shops", "users", "products", "sales", "stock_movements"];

/**
 * Vérifie qu'une sauvegarde se restaure vraiment : restauration dans une base temporaire, lecture
 * de quelques tables, puis suppression de la base temporaire. Le compte doit pouvoir créer une base
 * (BACKUP_VERIFY_DB_USER / BACKUP_VERIFY_DB_PASSWORD, sinon celui de l'application).
 */
export async function verifyBackup(file: string): Promise<VerifyReport> {
  const connection = { user: env.BACKUP_VERIFY_DB_USER ?? env.DB_USER, password: env.BACKUP_VERIFY_DB_PASSWORD ?? env.DB_PASSWORD };
  const database = `${env.DB_NAME}_verify_${randomBytes(4).toString("hex")}`;
  // Base de maintenance pour créer / supprimer la base temporaire
  const admin = { ...connection, database: "postgres" };

  await runTool("createdb", [database], admin).catch((error: Error) => {
    throw new Error(`Impossible de créer la base de vérification (${error.message}) : ce compte a-t-il le droit CREATEDB ?`);
  });
  try {
    await restoreBackup(file, database, connection);
    const query = (sql: string) => runTool("psql", ["--no-psqlrc", "--tuples-only", "--no-align", "--command", sql], { ...connection, database });
    const [migrations, lastMigration] = (await query("SELECT count(*) || '|' || coalesce(max(name), '') FROM sequelize_meta")).trim().split("|");
    const tables: Record<string, number> = {};
    for (const table of CHECKED_TABLES) {
      tables[table] = Number((await query(`SELECT count(*) FROM ${table}`)).trim());
    }
    if (!Number(migrations)) throw new Error("Sauvegarde sans table de migrations : fichier incomplet ou d'une autre base");
    return { file, migrations: Number(migrations), lastMigration: lastMigration || null, tables };
  } finally {
    await runTool("dropdb", ["--if-exists", database], admin);
  }
}
