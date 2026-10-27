// scripts/backup-restore.test.ts — feature 11B: end-to-end tests for
// scripts/backup.sh + scripts/restore.sh (Check When Done of
// context/feature-specs/11b-backup-restore.md):
//
//   1. backup.sh produces pg_dump (compressed custom format) + storage
//      archive + sha256 manifest + ISO-8601 timestamp directory.
//   2. Retention deletes backups older than BACKUP_RETENTION_DAYS and keeps
//      recent ones (seeded with different timestamps).
//   3. restore.sh --dry-run verifies checksums; a real restore asks for
//      explicit confirmation (type the database name), proves the dump
//      restores into an ISOLATED check database first, then rewinds the real
//      target — never the shared test database.
//   4. Corrupt/tampered backup is detected (exit 2) BEFORE any change, and a
//      dump that fails inside the isolated check DB leaves the target
//      untouched.
//   5. Empty database + empty storage still backs up successfully.
//
// These are integration tests of the real shell scripts: they spawn bash and
// talk to the test PostgreSQL (same DATABASE_URL the vitest harness owns),
// but every restore target is a purpose-built scratch database
// (invoice_me_bk_test_*) that is dropped afterwards — the shared test
// database (invoice_me_test) is NEVER dropped or restored.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

// Scratch databases — isolated per feature, dropped in afterAll.
const SRC_DB = "invoice_me_bk_test_src";
const TARGET_DB = "invoice_me_bk_test_target";
const EMPTY_DB = "invoice_me_bk_test_empty";
const SCRATCH_CHECK_DB = "invoice_me_restore_check"; // restore.sh default

function urlFor(dbName: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${dbName}`;
  url.search = "";
  return url.toString();
}
const ADMIN_URL = urlFor("postgres");

// Scratch directory for storage fixtures + backup output (gitignored
// .data-test volume — the same scratch area other tests use).
let scratchRoot = "";
let storageRoot = "";
let backupDest = "";
let targetBackupDest = "";

interface ScriptResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScript(
  script: "backup.sh" | "restore.sh",
  args: string[],
  env: Record<string, string>,
  input?: string,
): ScriptResult {
  const res = spawnSync("bash", [join(SCRIPTS_DIR, script), ...args], {
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** Every line on stderr must be one structured JSON event (spec: "Log
 * terstruktur ke stderr") — and no event may leak a URL or password. */
function parseEvents(stderr: string): Array<Record<string, unknown>> {
  const lines = stderr.split("\n").filter((line) => line.trim().length > 0);
  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(stderr).not.toContain("invoice:invoice@");
  return events;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function backupDirsIn(dest: string): string[] {
  return readdirSync(dest).filter((name) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z/.test(name));
}

function latestBackupDirIn(dest: string): string {
  const dirs = backupDirsIn(dest).sort();
  const last = dirs.at(-1);
  expect(last, `expected a backup directory in ${dest}`).toBeTruthy();
  return join(dest, last as string);
}

function latestBackupDir(): string {
  return latestBackupDirIn(backupDest);
}

/** Recompute manifest.sha256 inside a backup dir (used when a test crafts a
 * corrupt-but-internally-consistent backup). */
function recomputeManifestSha(backupDir: string): void {
  execFileSync(
    "bash",
    [
      "-c",
      'cd "$1" && sha256sum db.dump storage.tar.gz storage-files.sha256 manifest.json > manifest.sha256',
      "_",
      backupDir,
    ],
    { encoding: "utf8" },
  );
}

/** Seed the fixture storage tree (uploads + a generated invoice PDF). */
function seedStorage(root: string): void {
  mkdirSync(join(root, "uploads", "organizations", "org1", "logos"), { recursive: true });
  mkdirSync(join(root, "invoices", "organizations", "org1", "2026"), { recursive: true });
  writeFileSync(join(root, "uploads", "organizations", "org1", "logos", "logo.png"), "logo-bytes");
  writeFileSync(
    join(root, "invoices", "organizations", "org1", "2026", "INV-001.pdf"),
    "pdf-bytes",
  );
}

// Change 6: Prisma is gone — a plain `pg` Pool is the direct replacement for
// the raw-SQL-only use this suite ever made of PrismaClient.
let admin: Pool;

async function createDb(name: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
}

async function seedNotes(dbName: string, rows: Array<[number, string]>): Promise<void> {
  const client = new Pool({ connectionString: urlFor(dbName) });
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS "BkNote" (id integer PRIMARY KEY, v text NOT NULL)',
    );
    for (const [id, v] of rows) {
      await client.query(
        `INSERT INTO "BkNote" (id, v) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v`,
        [id, v],
      );
    }
  } finally {
    await client.end();
  }
}

async function readNotes(dbName: string): Promise<Array<{ id: number; v: string }>> {
  const client = new Pool({ connectionString: urlFor(dbName) });
  try {
    const result = await client.query<{ id: number; v: string }>(
      'SELECT id, v FROM "BkNote" ORDER BY id',
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  mkdirSync(join(REPO_ROOT, ".data-test"), { recursive: true });
  scratchRoot = mkdtempSync(join(REPO_ROOT, ".data-test", "backup-restore-"));
  storageRoot = join(scratchRoot, "storage");
  backupDest = join(scratchRoot, "backups");
  targetBackupDest = join(scratchRoot, "backups-target");
  seedStorage(storageRoot);

  admin = new Pool({ connectionString: ADMIN_URL });
  await createDb(SRC_DB);
  await createDb(TARGET_DB);
  await createDb(EMPTY_DB);
  await seedNotes(SRC_DB, [
    [1, "alpha"],
    [2, "beta"],
  ]);
  await seedNotes(TARGET_DB, [[1, "original"]]);
});

afterAll(async () => {
  await admin?.query(`DROP DATABASE IF EXISTS "${SRC_DB}" WITH (FORCE)`);
  await admin?.query(`DROP DATABASE IF EXISTS "${TARGET_DB}" WITH (FORCE)`);
  await admin?.query(`DROP DATABASE IF EXISTS "${EMPTY_DB}" WITH (FORCE)`);
  await admin?.end();
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
});

describe("backup.sh — full backup", () => {
  it("dumps the database (compressed custom format), archives storage, checksums everything, and logs structured events", () => {
    const res = runScript("backup.sh", [], {
      DATABASE_URL: urlFor(SRC_DB),
      STORAGE_ROOT: storageRoot,
      BACKUP_DEST: backupDest,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(""); // logs are structured and go to stderr only

    const events = parseEvents(res.stderr);
    expect(events.at(-1)?.msg).toBe("backup selesai");
    expect(events.every((event) => event.module === "backup")).toBe(true);

    const runDir = latestBackupDir();
    // ISO-8601 timestamped directory name.
    expect(runDir.split("/").at(-1)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);

    // pg_dump custom format (magic "PGDMP") — compressed, portable.
    expect(readFileSync(join(runDir, "db.dump")).subarray(0, 5).toString()).toBe("PGDMP");

    // Storage archive contains exactly the seeded files.
    const tarList = spawnSync("tar", ["-tzf", join(runDir, "storage.tar.gz")], {
      encoding: "utf8",
    });
    expect(tarList.status).toBe(0);
    expect(tarList.stdout).toContain("uploads/organizations/org1/logos/logo.png");
    expect(tarList.stdout).toContain("invoices/organizations/org1/2026/INV-001.pdf");

    // manifest.sha256 covers every artifact + the manifest itself.
    const manifestSha = spawnSync("sha256sum", ["-c", "--quiet", "manifest.sha256"], {
      cwd: runDir,
      encoding: "utf8",
    });
    expect(manifestSha.status).toBe(0);

    // manifest.json: metadata + per-artifact sha256 that matches reality.
    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as {
      schema: number;
      createdAt: string;
      database: string;
      storage: { ok: boolean; fileCount: number };
      files: Array<{ name: string; sha256: string }>;
    };
    expect(manifest.schema).toBe(1);
    expect(manifest.database).toBe(SRC_DB);
    expect(manifest.storage.ok).toBe(true);
    expect(manifest.storage.fileCount).toBe(2);
    for (const file of manifest.files) {
      expect(sha256File(join(runDir, file.name))).toBe(file.sha256);
    }

    // storage-files.sha256 verifies the exact per-file checksums.
    const extractDir = join(scratchRoot, "verify-extract");
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    spawnSync("tar", ["-xzf", join(runDir, "storage.tar.gz"), "-C", extractDir]);
    const fileCheck = spawnSync(
      "sha256sum",
      ["-c", "--quiet", join(runDir, "storage-files.sha256")],
      { cwd: extractDir, encoding: "utf8" },
    );
    expect(fileCheck.status).toBe(0);
    rmSync(extractDir, { recursive: true, force: true });
  });

  it("keeps the source database untouched (backup is read-only)", async () => {
    expect(await readNotes(SRC_DB)).toEqual([
      { id: 1, v: "alpha" },
      { id: 2, v: "beta" },
    ]);
  });
});

describe("backup.sh — retention rotation", () => {
  it("deletes backups older than BACKUP_RETENTION_DAYS, keeps recent and foreign directories", () => {
    // Seed three backup dirs with different timestamps (40d, 35d, 5d old) and
    // one foreign directory that must never be touched.
    const now = Math.floor(Date.now() / 1000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const seeded = [40, 35, 5].map((ageDays) => {
      const d = new Date((now - ageDays * 86400) * 1000);
      const stamp =
        `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
        `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}Z`;
      const dir = join(backupDest, stamp);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "marker.txt"), `old backup ${ageDays}d`);
      return { ageDays, dir, name: stamp };
    });
    const foreign = join(backupDest, "not-a-backup");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "keep.txt"), "user data");

    const res = runScript("backup.sh", [], {
      DATABASE_URL: urlFor(SRC_DB),
      STORAGE_ROOT: storageRoot,
      BACKUP_DEST: backupDest,
      BACKUP_RETENTION_DAYS: "30",
    });
    expect(res.status).toBe(0);

    // 40d and 35d are gone, 5d survives, foreign dir survives.
    expect(existsSync(seeded[0]?.dir as string)).toBe(false);
    expect(existsSync(seeded[1]?.dir as string)).toBe(false);
    expect(existsSync(seeded[2]?.dir as string)).toBe(true);
    expect(existsSync(join(foreign, "keep.txt"))).toBe(true);

    // Deletion is logged (structured), naming the removed directories.
    const events = parseEvents(res.stderr);
    const deleted = events
      .filter((event) => event.msg === "backup lama dihapus (retention)")
      .map((event) => event.dir);
    expect(deleted.sort()).toEqual([seeded[0]?.name, seeded[1]?.name].sort());

    rmSync(foreign, { recursive: true, force: true });
    rmSync(seeded[2]?.dir as string, { recursive: true, force: true });
  });

  it("rejects an invalid BACKUP_RETENTION_DAYS with exit 2", () => {
    const res = runScript("backup.sh", [], {
      DATABASE_URL: urlFor(SRC_DB),
      STORAGE_ROOT: storageRoot,
      BACKUP_DEST: backupDest,
      BACKUP_RETENTION_DAYS: "0",
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("BACKUP_RETENTION_DAYS");
  });
});

describe("backup.sh — empty database + empty storage", () => {
  it("succeeds and records an empty (but valid) storage archive", () => {
    const emptyStorage = join(scratchRoot, "empty-storage");
    mkdirSync(emptyStorage, { recursive: true });
    const emptyDest = join(scratchRoot, "backups-empty");

    const res = runScript("backup.sh", [], {
      DATABASE_URL: urlFor(EMPTY_DB),
      STORAGE_ROOT: emptyStorage,
      BACKUP_DEST: emptyDest,
    });
    expect(res.status).toBe(0);

    const runDir = latestBackupDirIn(emptyDest);
    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as {
      storage: { ok: boolean; fileCount: number; totalBytes: number };
    };
    expect(manifest.storage).toMatchObject({ ok: true, fileCount: 0, totalBytes: 0 });
    // The archive exists and is a valid (empty) tar.gz.
    const tarList = spawnSync("tar", ["-tzf", join(runDir, "storage.tar.gz")], {
      encoding: "utf8",
    });
    expect(tarList.status).toBe(0);
    expect(tarList.stdout.trim()).toBe("");

    // A dry-run against the empty backup passes too.
    const dry = runScript(
      "restore.sh",
      ["--dry-run", runDir],
      { DATABASE_URL: urlFor(EMPTY_DB), STORAGE_ROOT: emptyStorage, BACKUP_DEST: emptyDest },
      "",
    );
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("kosong");

    rmSync(emptyDest, { recursive: true, force: true });
    rmSync(emptyStorage, { recursive: true, force: true });
  });
});

describe("restore.sh — dry-run verifies checksums without touching anything", () => {
  it("passes on a valid backup", () => {
    const backup = runScript("backup.sh", [], {
      DATABASE_URL: urlFor(SRC_DB),
      STORAGE_ROOT: storageRoot,
      BACKUP_DEST: backupDest,
    });
    expect(backup.status).toBe(0);

    const res = runScript(
      "restore.sh",
      ["--dry-run", latestBackupDir()],
      { DATABASE_URL: urlFor(TARGET_DB), STORAGE_ROOT: storageRoot, BACKUP_DEST: backupDest },
      "",
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("TIDAK ADA perubahan");
  });

  it("exits 2 on a tampered manifest.json (Check When Done: manifest di-tamper)", () => {
    const tampered = join(scratchRoot, "tampered-manifest");
    rmSync(tampered, { recursive: true, force: true });
    spawnSync("cp", ["-a", latestBackupDir(), tampered]);
    const manifestPath = join(tampered, "manifest.json");
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, "utf8").replace(`"${SRC_DB}"`, '"tampered"'),
    );

    const dry = runScript(
      "restore.sh",
      ["--dry-run", tampered],
      { DATABASE_URL: urlFor(TARGET_DB), STORAGE_ROOT: storageRoot, BACKUP_DEST: backupDest },
    );
    expect(dry.status).toBe(2);
    expect(dry.stderr).toContain("checksum manifest GAGAL");

    // A real restore refuses the same tampered backup BEFORE the confirmation
    // prompt — no change can happen.
    const real = runScript(
      "restore.sh",
      [tampered],
      { DATABASE_URL: urlFor(TARGET_DB), STORAGE_ROOT: storageRoot, BACKUP_DEST: backupDest },
      `${TARGET_DB}\n`,
    );
    expect(real.status).toBe(2);
    expect(real.stdout).not.toContain("Ketik nama database");
    rmSync(tampered, { recursive: true, force: true });
  });

  it("exits 2 when a file INSIDE storage.tar.gz is corrupt (manifest.sha256 recomputed)", () => {
    const tampered = join(scratchRoot, "tampered-archive");
    rmSync(tampered, { recursive: true, force: true });
    spawnSync("cp", ["-a", latestBackupDir(), tampered]);

    // Rebuild the archive with a corrupted member, then make manifest.sha256
    // consistent again so ONLY the per-file storage checksum can catch it.
    const extractDir = join(scratchRoot, "tamper-extract");
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    spawnSync("tar", ["-xzf", join(tampered, "storage.tar.gz"), "-C", extractDir]);
    writeFileSync(
      join(extractDir, "uploads", "organizations", "org1", "logos", "logo.png"),
      "CORRUPTED",
    );
    spawnSync("tar", ["-czf", join(tampered, "storage.tar.gz"), "-C", extractDir, "uploads", "invoices"]);
    recomputeManifestSha(tampered);

    const dry = runScript(
      "restore.sh",
      ["--dry-run", tampered],
      { DATABASE_URL: urlFor(TARGET_DB), STORAGE_ROOT: storageRoot, BACKUP_DEST: backupDest },
    );
    expect(dry.status).toBe(2);
    expect(dry.stderr).toContain("checksum isi archive storage GAGAL");
    rmSync(tampered, { recursive: true, force: true });
    rmSync(extractDir, { recursive: true, force: true });
  });
});

describe("restore.sh — explicit confirmation + isolated check DB + full restore", () => {
  it("refuses a wrong or empty confirmation (piped input) and changes nothing", async () => {
    // Back up the TARGET before mutating, so "rewind" is observable later.
    const backup = runScript("backup.sh", [], {
      DATABASE_URL: urlFor(TARGET_DB),
      STORAGE_ROOT: storageRoot,
      BACKUP_DEST: targetBackupDest,
    });
    expect(backup.status).toBe(0);
    const backupDir = latestBackupDirIn(targetBackupDest);

    // Mutate the target AFTER the backup.
    await seedNotes(TARGET_DB, [[2, "post-backup"]]);

    for (const answer of ["wrong-name\n", "\n"]) {
      const res = runScript(
        "restore.sh",
        [backupDir],
        { DATABASE_URL: urlFor(TARGET_DB), STORAGE_ROOT: storageRoot, BACKUP_DEST: targetBackupDest },
        answer,
      );
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("Ketik nama database");
    }
    expect(await readNotes(TARGET_DB)).toEqual([
      { id: 1, v: "original" },
      { id: 2, v: "post-backup" },
    ]);
  }, 60_000);

  it("--test-db restores ONLY into the isolated check DB — production untouched", async () => {
    const backupDir = latestBackupDirIn(targetBackupDest);
    const res = runScript(
      "restore.sh",
      ["--test-db", backupDir],
      { DATABASE_URL: urlFor(TARGET_DB), STORAGE_ROOT: storageRoot, BACKUP_DEST: targetBackupDest },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("HANYA ke database terisolasi");
    expect(res.stdout).toContain(SCRATCH_CHECK_DB);

    const events = parseEvents(res.stderr);
    const done = events.find(
      (event) => event.msg === "restore --test-db selesai dan terverifikasi",
    );
    expect(done?.testDatabase).toBe(SCRATCH_CHECK_DB);

    // The check DB holds the BACKUP state (id=1 only) and is kept for
    // inspection; the production target still has the post-backup row.
    expect(await readNotes(SCRATCH_CHECK_DB)).toEqual([{ id: 1, v: "original" }]);
    expect(await readNotes(TARGET_DB)).toEqual([
      { id: 1, v: "original" },
      { id: 2, v: "post-backup" },
    ]);

    // Extracted storage landed in a temp dir (path printed) with the exact
    // backed-up bytes — nothing was written to STORAGE_ROOT.
    const storageDirMatch = res.stdout.match(/Storage diekstrak ke: ([^\s(]+)/);
    expect(storageDirMatch).toBeTruthy();
    expect(
      readFileSync(
        join(storageDirMatch?.[1] as string, "uploads", "organizations", "org1", "logos", "logo.png"),
        "utf8",
      ),
    ).toBe("logo-bytes");
    rmSync(storageDirMatch?.[1] as string, { recursive: true, force: true });

    // Clean up the kept check DB so later assertions about it stay meaningful.
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_CHECK_DB}" WITH (FORCE)`);
  }, 60_000);

  it("restores into the isolated check DB first, then rewinds database + storage, and keeps a pre-restore snapshot", async () => {
    const backupDir = latestBackupDirIn(targetBackupDest);
    // Add a file that must disappear after the restore.
    const strayFile = join(storageRoot, "uploads", "organizations", "org1", "logos", "stray.png");
    writeFileSync(strayFile, "added-after-backup");

    const res = runScript(
      "restore.sh",
      [backupDir],
      { DATABASE_URL: urlFor(TARGET_DB), STORAGE_ROOT: storageRoot, BACKUP_DEST: targetBackupDest },
      `${TARGET_DB}\n`,
    );
    expect(res.status).toBe(0);

    const events = parseEvents(res.stderr);
    // The dump was proven restorable in an ISOLATED database before the real
    // target was touched...
    const scratchCheck = events.find(
      (event) => event.msg === "dump terbukti restorable di database test terisolasi",
    );
    expect(scratchCheck?.testDatabase).toBe(SCRATCH_CHECK_DB);
    expect(events.some((event) => event.msg === "restore selesai dan terverifikasi")).toBe(true);

    // Database rewound to the backup state (the post-backup row is gone).
    expect(await readNotes(TARGET_DB)).toEqual([{ id: 1, v: "original" }]);
    // Stray storage file removed; both original files byte-identical.
    expect(existsSync(strayFile)).toBe(false);
    expect(
      readFileSync(join(storageRoot, "uploads", "organizations", "org1", "logos", "logo.png"), "utf8"),
    ).toBe("logo-bytes");
    expect(
      readFileSync(join(storageRoot, "invoices", "organizations", "org1", "2026", "INV-001.pdf"), "utf8"),
    ).toBe("pdf-bytes");

    // Pre-restore snapshot of the OLD state exists (database + storage).
    const preRestore = join(targetBackupDest, "pre-restore");
    const storageSnapshots = readdirSync(preRestore).filter((n) => n.endsWith("-storage"));
    const dbSnapshots = readdirSync(preRestore).filter((n) => n.startsWith("2"));
    expect(storageSnapshots.length).toBeGreaterThan(0);
    expect(dbSnapshots.length).toBeGreaterThan(0);
    expect(existsSync(join(preRestore, dbSnapshots[0] as string, "db.dump"))).toBe(true);

    // The isolated check database does not linger.
    const adminClient = new Pool({ connectionString: ADMIN_URL });
    try {
      const found = await adminClient.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
        [SCRATCH_CHECK_DB],
      );
      expect(found.rows[0]!.exists).toBe(false);
    } finally {
      await adminClient.end();
    }
  }, 60_000);

  it("a dump that fails inside the isolated check DB aborts with exit 2 and the target stays untouched", async () => {
    const corrupt = join(scratchRoot, "corrupt-dump");
    rmSync(corrupt, { recursive: true, force: true });
    spawnSync("cp", ["-a", latestBackupDirIn(targetBackupDest), corrupt]);
    writeFileSync(join(corrupt, "db.dump"), "NOT-A-REAL-DUMP");
    recomputeManifestSha(corrupt);

    await seedNotes(TARGET_DB, [[3, "must-survive"]]);
    const res = runScript(
      "restore.sh",
      [corrupt],
      { DATABASE_URL: urlFor(TARGET_DB), STORAGE_ROOT: storageRoot, BACKUP_DEST: targetBackupDest },
      `${TARGET_DB}\n`,
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("produksi TIDAK disentuh");
    // The target database was never dropped or restored.
    expect(await readNotes(TARGET_DB)).toEqual([
      { id: 1, v: "original" },
      { id: 3, v: "must-survive" },
    ]);
    rmSync(corrupt, { recursive: true, force: true });
  }, 60_000);
});
