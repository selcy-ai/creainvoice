// src/server/db.ts — re-export of the Drizzle client (Change 6).
//
// kept as a stable import path: 50+ modules import `db` from "@/server/db"
// (the Prisma client lived here before the migration). The real client is
// src/db/client.ts (Neon serverless driver).

export { db, type Database } from "@/db/client";
