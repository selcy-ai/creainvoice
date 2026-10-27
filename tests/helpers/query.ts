// tests/helpers/query.ts — the Prisma-shaped `db` the test suite asserts
// against, backed by Drizzle (Change 6).
//
// Why this exists: the integration and E2E suites were written against
// Prisma's client API — `db.invoice.findUnique({ where: { id } })`,
// `db.auditLog.count({ where })`, `db.invoice.update({ where, data })`. That
// is several hundred assertion sites across ~20 files. Migrating each one to
// Drizzle builders would rewrite thousands of lines of tests that currently
// say exactly what they mean; instead this module exposes the same table
// objects with the same method names and maps them onto Drizzle selects.
//
// What is supported (everything the suite uses):
//   findUnique / findUniqueOrThrow / findFirst / findMany / count /
//   create / update / updateMany / delete / deleteMany / upsert
// with a flat equality `where` object plus the Prisma filter shorthands the
// tests actually use (`in`, `not`, `startsWith`), and `orderBy` / `take` /
// `skip` / `select` / `include` where the tests use them.
//
// Tables are keyed by the OLD Prisma model names (`invoice`, `auditLog`,
// `user`, …) because that is what the test files type. The mapping to the
// Drizzle tables lives in TABLES below.

import { db as client } from "@/server/db";
import {
  auditLogs,
  bankAccounts,
  customerContacts,
  customers,
  invoiceItems,
  invoicePdfs,
  invoiceProfiles,
  invoiceSequences,
  invoices,
  memberships,
  organizations,
  payments,
  pdfJobs,
  projectReferences,
  signers,
  uploadRecords,
  users,
} from "@/db/schema";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Table } from "drizzle-orm/table";

// Any of the pgTable definitions in src/db/schema.ts. Kept structural so
// every concrete table (with its own column types) satisfies it.
import type { PgTable } from "drizzle-orm/pg-core";
type TableLike = PgTable;

// The row shape a full select on each table returns. Exported so test files
// keep typed assertions (decimal columns are Decimal, JSON columns records).
export type UserRow = typeof users.$inferSelect;
export type OrganizationRow = typeof organizations.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type InvoiceProfileRow = typeof invoiceProfiles.$inferSelect;
export type BankAccountRow = typeof bankAccounts.$inferSelect;
export type SignerRow = typeof signers.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type CustomerContactRow = typeof customerContacts.$inferSelect;
export type ProjectReferenceRow = typeof projectReferences.$inferSelect;
export type InvoiceSequenceRow = typeof invoiceSequences.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceItemRow = typeof invoiceItems.$inferSelect;
export type PdfJobRow = typeof pdfJobs.$inferSelect;
export type InvoicePdfRow = typeof invoicePdfs.$inferSelect;
export type UploadRecordRow = typeof uploadRecords.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;

const TABLES = {
  user: users,
  organization: organizations,
  membership: memberships,
  auditLog: auditLogs,
  invoiceProfile: invoiceProfiles,
  bankAccount: bankAccounts,
  signer: signers,
  customer: customers,
  customerContact: customerContacts,
  projectReference: projectReferences,
  invoiceSequence: invoiceSequences,
  invoice: invoices,
  invoiceItem: invoiceItems,
  pdfJob: pdfJobs,
  invoicePdf: invoicePdfs,
  uploadRecord: uploadRecords,
  payment: payments,
} as Record<string, TableLike>;

export type TableName = keyof typeof TABLES;

type WhereInput = Record<string, unknown>;
type FilterValue = { in?: unknown[]; not?: unknown; startsWith?: string };

function columnOf(table: TableLike, key: string) {
  const columns = (table as unknown as Record<string, unknown>)[key];
  if (!columns) throw new Error(`tests/helpers/query: unknown column ${key}`);
  return columns as never;
}

function isFilter(value: unknown): value is FilterValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !("tp" in value) && // not a Drizzle SQL wrapper
    Object.keys(value).some((k) => k === "in" || k === "not" || k === "startsWith")
  );
}

function whereToSql(table: TableLike, where: WhereInput | undefined): SQL | undefined {
  if (!where || Object.keys(where).length === 0) return undefined;
  const parts: SQL[] = [];
  for (const [key, value] of Object.entries(where)) {
    const column = columnOf(table, key);
    if (isFilter(value)) {
      if (value.in !== undefined) parts.push(inArray(column, value.in as never[]));
      if (value.not !== undefined) parts.push(ne(column, value.not as never));
      if (value.startsWith !== undefined) {
        parts.push(sql`${column}::text like ${`${value.startsWith}%`}`);
      }
    } else if (Array.isArray(value)) {
      parts.push(inArray(column, value as never[]));
    } else if (value === null) {
      parts.push(eq(column, null as never));
    } else {
      parts.push(eq(column, value as never));
    }
  }
  return parts.length === 1 ? parts[0]! : and(...parts);
}

export interface FindOptions {
  where?: WhereInput;
  orderBy?: Record<string, "asc" | "desc"> | Array<Record<string, "asc" | "desc">>;
  take?: number;
  skip?: number;
  select?: Record<string, boolean>;
  /** Accept-and-ignore: the suite's assertions never need joins. */
  include?: Record<string, boolean>;
}

function applyOrder(table: TableLike, orderBy: FindOptions["orderBy"]) {
  const entries: Array<Record<string, "asc" | "desc">> = Array.isArray(orderBy)
    ? (orderBy ?? [])
    : orderBy
      ? [orderBy]
      : [];
  return entries.flatMap((entry) =>
    Object.entries(entry).map(([key, direction]) =>
      direction === "asc" ? asc(columnOf(table, key)) : desc(columnOf(table, key)),
    ),
  );
}

function pickSelect(table: TableLike, select: FindOptions["select"] | undefined): Record<string, unknown> | undefined {
  if (!select) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, enabled] of Object.entries(select)) {
    if (enabled) out[key] = columnOf(table, key);
  }
  return out;
}

export function table(name: TableName): TableLike {
  return TABLES[name];
}

async function findUniqueInner<T>(
  name: TableName,
  where: WhereInput,
  orThrow: boolean,
): Promise<T | null> {
  const table = TABLES[name];
  const rows = await client
    .select()
    .from(table)
    .where(whereToSql(table, where))
    .limit(1);
  const row = (rows[0] ?? null) as T | null;
  if (row === null && orThrow) {
    throw new Error(`tests/helpers/query: no ${String(name)} row for ${JSON.stringify(where)}`);
  }
  return row;
}

// ─── Table handles: the `db.<model>` surface the tests call ────────────────

interface FindArgs<T> {
  where?: WhereInput;
  orderBy?: FindOptions["orderBy"];
  take?: number;
  skip?: number;
  select?: Record<string, boolean>;
  include?: Record<string, boolean>;
}
interface WriteArgs<T> {
  where: WhereInput;
  data: Partial<T>;
}
interface CreateArgs<T> {
  data: Partial<T>;
}
interface UpsertArgs<T> {
  where: WhereInput;
  create: Partial<T>;
  update: Partial<T>;
}

export interface TableHandle<T = Record<string, unknown>> {
  findUnique(args: {
    where: WhereInput;
    select?: Record<string, boolean>;
  }): Promise<T | null>;
  findUniqueOrThrow(args: { where: WhereInput }): Promise<T>;
  findFirst(args?: FindArgs<T>): Promise<T | null>;
  findMany(args?: FindArgs<T>): Promise<T[]>;
  count(args?: { where?: WhereInput }): Promise<number>;
  create(args: CreateArgs<T> & { select?: Record<string, boolean> }): Promise<T>;
  update(args: WriteArgs<T>): Promise<T>;
  updateMany(args: WriteArgs<T>): Promise<{ count: number }>;
  delete(args: { where: WhereInput }): Promise<T>;
  deleteMany(args?: { where?: WhereInput }): Promise<{ count: number }>;
  upsert(args: UpsertArgs<T>): Promise<T>;
}

function handleFor<T>(name: TableName): TableHandle<T> {
  const tbl = TABLES[name];
  return {
    async findUnique({ where, select }) {
      const rows = await client
        .select((pickSelect(tbl, select) ?? undefined) as never)
        .from(tbl)
        .where(whereToSql(tbl, where))
        .limit(1);
      return (rows[0] ?? null) as T | null;
    },
    async findUniqueOrThrow({ where }) {
      return (await findUniqueInner<T>(name, where, true)) as T;
    },
    async findFirst(args = {}) {
      const rows = await client
        .select((pickSelect(tbl, args.select) ?? undefined) as never)
        .from(tbl)
        .where(whereToSql(tbl, args.where))
        .orderBy(...applyOrder(tbl, args.orderBy))
        .limit(1);
      return (rows[0] ?? null) as T | null;
    },
    async findMany(args = {}) {
      const rows = await client
        .select((pickSelect(tbl, args.select) ?? undefined) as never)
        .from(tbl)
        .where(whereToSql(tbl, args.where))
        .orderBy(...applyOrder(tbl, args.orderBy))
        .limit(args.take ?? 1000)
        .offset(args.skip ?? 0);
      return rows as T[];
    },
    async count(args) {
      const rows = await client
        .select({ value: count() })
        .from(tbl)
        .where(whereToSql(tbl, args?.where));
      return Number(rows[0]?.value ?? 0);
    },
    async create({ data }) {
      const rows = await client.insert(tbl).values(data as never).returning();
      return rows[0] as T;
    },
    async update({ where, data }) {
      const rows = await client
        .update(tbl)
        .set(data as never)
        .where(whereToSql(tbl, where))
        .returning();
      if (rows.length === 0) {
        throw new Error(`tests/helpers/query: update touched no ${String(name)} row`);
      }
      return rows[0] as T;
    },
    async updateMany({ where, data }) {
      const rows = await client
        .update(tbl)
        .set(data as never)
        .where(whereToSql(tbl, where))
        .returning();
      return { count: rows.length };
    },
    async delete({ where }) {
      const rows = await client.delete(tbl).where(whereToSql(tbl, where)).returning();
      if (rows.length === 0) {
        throw new Error(`tests/helpers/query: delete touched no ${String(name)} row`);
      }
      return rows[0] as T;
    },
    async deleteMany(args) {
      const rows = await client
        .delete(tbl)
        .where(whereToSql(tbl, args?.where))
        .returning();
      return { count: rows.length };
    },
    async upsert({ where, create, update }) {
      const existing = await findUniqueInner<T>(name, where, false);
      if (existing) {
        const rows = await client
          .update(tbl)
          .set(update as never)
          .where(whereToSql(tbl, where))
          .returning();
        return rows[0] as T;
      }
      const rows = await client.insert(tbl).values(create as never).returning();
      return rows[0] as T;
    },
  };
}

/**
 * Drop-in replacement for the Prisma `db` object in tests. Every property is
 * a table handle keyed by the old Prisma model name, so `db.invoice.findUnique`
 * keeps working — the file only has to switch its `db` import to this.
 */
export const queryDb = {
  user: handleFor<UserRow>("user"),
  organization: handleFor<OrganizationRow>("organization"),
  membership: handleFor<MembershipRow>("membership"),
  auditLog: handleFor<AuditLogRow>("auditLog"),
  invoiceProfile: handleFor<InvoiceProfileRow>("invoiceProfile"),
  bankAccount: handleFor<BankAccountRow>("bankAccount"),
  signer: handleFor<SignerRow>("signer"),
  customer: handleFor<CustomerRow>("customer"),
  customerContact: handleFor<CustomerContactRow>("customerContact"),
  projectReference: handleFor<ProjectReferenceRow>("projectReference"),
  invoiceSequence: handleFor<InvoiceSequenceRow>("invoiceSequence"),
  invoice: handleFor<InvoiceRow>("invoice"),
  invoiceItem: handleFor<InvoiceItemRow>("invoiceItem"),
  pdfJob: handleFor<PdfJobRow>("pdfJob"),
  invoicePdf: handleFor<InvoicePdfRow>("invoicePdf"),
  uploadRecord: handleFor<UploadRecordRow>("uploadRecord"),
  payment: handleFor<PaymentRow>("payment"),
  /**
   * Prisma's tagged-template raw SQL escape hatch (one cautious call site:
   * reading an encrypted column verbatim to prove at-rest encryption).
   * Drizzle's equivalent is db.execute, so this keeps the call site's shape.
   * Usage mirrors Prisma: `db.$queryRaw<Type>` where Type is the ROW shape.
   */
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<T>> {
    return rawQuery<T>(strings, ...values);
  },
};

/**
 * Raw SQL via drizzle's sql template (used by $queryRaw above). Drizzle's
 * `sql` tagged template binds the interpolated values as parameters, which is
 * the same protection Prisma's $queryRaw gave.
 */
async function rawQuery<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
  // sql.join interleaves the raw chunks with bound parameters, matching
  // Prisma's tagged-template semantics chunk-for-chunk.
  const parts: SQL[] = [];
  strings.forEach((chunk, index) => {
    if (index > 0) parts.push(sql`${values[index - 1] as never}`);
    parts.push(sql.raw(chunk));
  });
  const query = parts.reduce((acc, part) => acc.append(part), sql``);
  const result = await client.execute(query);
  return (result.rows ?? []) as T[];
}

// The generic helpers below are exported for the few tests that need to
// escape the table-name mapping (see tests/factories.ts).

export async function findUnique<T = unknown>(name: TableName, where: WhereInput) {
  return findUniqueInner<T>(name, where, false);
}

export async function countRows(name: TableName, where?: WhereInput) {
  const tbl = TABLES[name];
  const rows = await client.select({ value: count() }).from(tbl).where(whereToSql(tbl, where));
  return Number(rows[0]?.value ?? 0);
}

export async function deleteRows(name: TableName, where?: WhereInput) {
  const tbl = TABLES[name];
  const rows = await client.delete(tbl).where(whereToSql(tbl, where)).returning();
  return { count: rows.length };
}
