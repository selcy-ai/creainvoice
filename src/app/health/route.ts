import { db } from "@/server/db";
import { env } from "@/server/env";
import { promises as fs } from "fs";
import path from "path";

interface HealthCheck {
  status: "ok" | "degraded";
  latencyMs?: number;
  error?: string;
}

interface HealthResponse {
  status: "ok" | "degraded";
  checks: {
    database: HealthCheck;
    storage: HealthCheck;
  };
  timestamp: string;
}

async function checkDatabase(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await db.execute("select 1");
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return { status: "degraded", error: "Database unreachable" };
  }
}

async function checkStorage(): Promise<HealthCheck> {
  const testFile = path.join(env.STORAGE_ROOT, ".health-check");
  try {
    await fs.mkdir(env.STORAGE_ROOT, { recursive: true });
    await fs.writeFile(testFile, "ok");
    await fs.unlink(testFile);
    return { status: "ok" };
  } catch {
    return { status: "degraded", error: "Storage not writable" };
  }
}

export async function GET(): Promise<Response> {
  const [database, storage] = await Promise.all([
    checkDatabase(),
    checkStorage(),
  ]);

  const allOk = database.status === "ok" && storage.status === "ok";

  const body: HealthResponse = {
    status: allOk ? "ok" : "degraded",
    checks: { database, storage },
    timestamp: new Date().toISOString(),
  };

  return Response.json(body, {
    status: allOk ? 200 : 503,
  });
}
