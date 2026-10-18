import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupDate, backupFileName, nextRunAt, pruneBackups, RETENTION, selectBackupsToKeep } from "../src/database/backup.js";

const DAY = 86_400_000;
const at = (iso: string) => backupFileName(new Date(iso));

/** Une sauvegarde par nuit à 2 h (UTC), sur `days` jours jusqu'au 2026-10-18. */
function nightly(days: number): string[] {
  const last = Date.parse("2026-10-18T02:00:00Z");
  return Array.from({ length: days }, (_, index) => backupFileName(new Date(last - index * DAY)));
}

describe("Noms des sauvegardes", () => {
  it("datés, triables, sans « : » (Windows), relus à l'identique", () => {
    const name = backupFileName(new Date("2026-10-18T02:00:05.123Z"));
    expect(name).toBe("stockpro_2026-10-18T02-00-05Z.dump");
    expect(backupDate(name)?.toISOString()).toBe("2026-10-18T02:00:05.000Z");
    expect(backupDate("notes.txt")).toBeNull();
    expect(backupDate(`${name}.partial`)).toBeNull();
  });
});

describe("Conservation : 7 quotidiennes, 4 hebdomadaires, 12 mensuelles", () => {
  it("sur plus d'un an de sauvegardes nocturnes", () => {
    const files = nightly(420);
    const keep = selectBackupsToKeep(files);

    // Les 7 dernières nuits
    for (const name of files.slice(0, 7)) expect(keep.has(name)).toBe(true);
    // La plus récente de chacun des 12 derniers mois (octobre 2026 → novembre 2025)
    for (let offset = 0; offset < 12; offset++) {
      const month = new Date(Date.UTC(2026, 9 - offset, 1)).toISOString().slice(0, 7);
      const newest = files.find((name) => backupDate(name)!.toISOString().startsWith(month))!;
      expect(keep.has(newest)).toBe(true);
    }
    // Rien de plus vieux que 12 mois, et pas plus que 7 + 4 + 12 fichiers
    const oldest = Math.min(...[...keep].map((name) => backupDate(name)!.getTime()));
    expect(new Date(oldest).toISOString().slice(0, 7)).toBe("2025-11");
    expect(keep.size).toBeLessThanOrEqual(RETENTION.daily + RETENTION.weekly + RETENTION.monthly);
    // Dimanche de chacune des 4 dernières semaines (la plus récente de la semaine ISO)
    for (const sunday of ["2026-10-11", "2026-10-04", "2026-09-27"]) expect(keep.has(at(`${sunday}T02:00:00Z`))).toBe(true);
  });

  it("plusieurs sauvegardes le même jour : seule la plus récente compte pour ce jour", () => {
    const files = [at("2026-10-18T14:00:00Z"), at("2026-10-18T02:00:00Z"), at("2026-10-17T02:00:00Z")];

    const keep = selectBackupsToKeep(files);

    expect(keep.has(at("2026-10-18T14:00:00Z"))).toBe(true);
    expect(keep.has(at("2026-10-18T02:00:00Z"))).toBe(false);
    expect(keep.has(at("2026-10-17T02:00:00Z"))).toBe(true);
  });

  it("peu de sauvegardes : tout est gardé", () => {
    expect(selectBackupsToKeep(nightly(5)).size).toBe(5);
  });

  it("le ménage ne supprime que des sauvegardes, jamais les autres fichiers du dossier", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stockpro-backups-"));
    try {
      const files = nightly(60);
      for (const name of [...files, "notes.txt", `${files[0]}.partial`]) await writeFile(path.join(dir, name), "x");

      const removed = await pruneBackups(dir);

      const left = await readdir(dir);
      expect(left).toContain("notes.txt");
      expect(left).toContain(`${files[0]}.partial`);
      expect(removed.length + left.length - 2).toBe(files.length);
      expect(left.filter((name) => backupDate(name)).sort()).toEqual([...selectBackupsToKeep(files)].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Planification nocturne", () => {
  it("prochaine exécution à l'heure dite, aujourd'hui si elle n'est pas passée, sinon demain", () => {
    const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

    expect(nextRunAt(local(18, 1, 30), 2)).toEqual(local(18, 2));
    expect(nextRunAt(local(18, 2), 2)).toEqual(local(19, 2));
    expect(nextRunAt(local(18, 15), 2)).toEqual(local(19, 2));
    expect(nextRunAt(local(31, 23), 2)).toEqual(new Date(2026, 10, 1, 2));
  });
});
