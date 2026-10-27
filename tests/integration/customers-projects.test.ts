// tests/integration/customers-projects.test.ts
// Feature 03 "Check When Done" at the service layer:
//   - customer CRUD + soft delete (row survives, reads hide it, PICs stay put)
//   - PIC CRUD with exactly one primary per customer
//   - ProjectReference CRUD across all six reference types + PO attachment
//     (PDF accepted, >2 MB rejected, fake MIME rejected by content sniffing)
//   - server-side pagination (pageSize capped at 100) and search ("Dharma")
//   - VIEWER forbidden on every write, STAFF allowed
//   - cross-org ids answer 404 (IDOR guard), org isolation on both lists
//   - NPWP never appears in audit metadata
//   - prefillFromProject hands feature 04 an EMPTY items list (honest, not a 0)
//   - `scripts/seed.mjs` seeds a demo workspace searchable by "Cipta"

import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { isAppError, type AppError } from "@/lib/errors";
import { getStorageService } from "@/modules/storage";
import {
  addContact,
  createCustomer,
  deleteContact,
  getCustomerForScope,
  listCustomers,
  maskTaxId,
  softDeleteCustomer,
  toCustomerDetail,
  updateContact,
  updateCustomer,
} from "@/modules/customers/service";
import type { CustomerFormInput } from "@/modules/customers/service";
import {
  createProject,
  deleteProject,
  getProjectForScope,
  listProjects,
  prefillFromProject,
  removeProjectAttachment,
  updateProject,
  uploadProjectAttachment,
} from "@/modules/projects/service";
import type { ProjectFormInput } from "@/modules/projects/service";
import { REFERENCE_TYPES } from "@/modules/projects/schema";
import { db } from "@/tests/helpers/test-db";
import {
  addMembership,
  createOrganization,
  createUser,
  resetDatabase,
  type TestUser,
} from "../factories";
import { ctxFor } from "@/tests/helpers/context";

const NPWP = "01.2345.6789.000001";
const NPWP_DIGITS = "0123456789000001";

// 1×1 PNG (real bytes) as a plain ArrayBuffer-backed view (File parts dislike Buffer).
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n");
// ZIP magic ("PK\x03\x04") + padding: real bytes that sniff as application/zip,
// i.e. a hostile upload lying about its name/type.
const ZIP_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.alloc(128, 0x42),
]);

let owner: TestUser;
let staffId: string;
let viewerId: string;
let org: { id: string };
let otherOrg: { id: string };


function ownerCtx(organizationId?: string) {
  return ctxFor(organizationId ?? org.id, owner.id);
}

function staffCtx() {
  return ctxFor(org.id, staffId);
}

function viewerCtx() {
  return ctxFor(org.id, viewerId);
}

async function expectAppFailure(
  promise: Promise<unknown>,
  code: AppError["code"],
): Promise<AppError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isAppError(caught)).toBe(true);
  const appError = caught as AppError;
  expect(appError.code).toBe(code);
  return appError;
}

function customerInput(overrides: Partial<CustomerFormInput> = {}): CustomerFormInput {
  return {
    companyName: "PT Uji Coba Sentosa",
    legalName: "PT Uji Coba Sentosa",
    businessType: "Dagang",
    taxId: NPWP,
    address: "Jl. Jend. Sudirman No. 1",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10110",
    country: "Indonesia",
    phone: "0215550123",
    whatsapp: "",
    email: "halo@ujicoba.co.id",
    isActive: true,
    ...overrides,
  };
}

function projectInput(customerId: string, overrides: Partial<ProjectFormInput> = {}) {
  return {
    customerId,
    referenceType: "PURCHASE_ORDER" as const,
    referenceNumber: "PO-2026-0001",
    title: "Pengadaan Bracket Frame",
    workValue: "450000000",
    currency: "IDR" as const,
    ...overrides,
  } satisfies ProjectFormInput;
}

async function auditMetadataDump(where: Record<string, unknown> = {}): Promise<string> {
  const rows = await db.auditLog.findMany({ where });
  return rows.map((row) => JSON.stringify(row.metadata ?? {})).join("\n");
}

beforeAll(async () => {
  await resetDatabase();
  owner = await createUser({ username: "cust.owner" });
  const staff = await createUser({ username: "cust.staff" });
  const viewer = await createUser({ username: "cust.viewer" });
  org = await createOrganization("Sinar Jaya");
  otherOrg = await createOrganization("Organisasi Lain");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(staff.id, org.id, "STAFF");
  await addMembership(viewer.id, org.id, "VIEWER");
  await addMembership(owner.id, otherOrg.id, "OWNER");
  staffId = staff.id;
  viewerId = viewer.id;
});

describe("customer CRUD + soft delete", () => {
  it("creates a customer and audits CUSTOMER_CREATED", async () => {
    const customer = await createCustomer(customerInput(), ownerCtx());
    expect(customer.id).toBeTruthy();
    expect(customer.organizationId).toBe(org.id);
    expect(customer.deletedAt).toBeNull();
    expect(customer.taxId).toBe(NPWP);

    const audit = await db.auditLog.findFirst({
      where: { action: "CUSTOMER_CREATED", entityId: customer.id },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.metadata ?? {})).toContain("created");

    // Duplicate company names are legal in feature 03 (no duplicate detection).
    const second = await createCustomer(customerInput({ companyName: "PT Uji Coba Sentosa" }), ownerCtx());
    expect(second.id).not.toBe(customer.id);
    await softDeleteCustomer(second.id, ownerCtx());
  });

  it("updates changed fields and audits the field NAMES (values stay out)", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Edit Satu" }), ownerCtx());
    const updated = await updateCustomer(
      customer.id,
      customerInput({ companyName: "PT Edit Dua", city: "Bandung", taxId: NPWP }),
      ownerCtx(),
    );
    expect(updated.companyName).toBe("PT Edit Dua");
    expect(updated.city).toBe("Bandung");

    const audit = await db.auditLog.findFirst({
      where: { action: "CUSTOMER_UPDATED", entityId: customer.id },
    });
    const metadata = JSON.stringify(audit?.metadata ?? {});
    expect(metadata).toContain("updated");
    expect(metadata).toContain("companyName");
    expect(metadata).not.toContain("PT Edit Dua");

    await softDeleteCustomer(customer.id, ownerCtx());
  });

  it("soft-deletes: row survives, reads answer 404, PIC rows are preserved", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Hapus Ini" }), ownerCtx());
    const pic = await addContact(
      customer.id,
      { name: "Andi Wijaya", title: "Finance", isPrimary: true },
      ownerCtx(),
    );

    const deleted = await softDeleteCustomer(customer.id, ownerCtx());
    expect(deleted.deletedAt).not.toBeNull();

    // Row kept for the audit trail — never a hard delete.
    const raw = await db.customer.findUnique({ where: { id: customer.id } });
    expect(raw).not.toBeNull();
    expect(raw?.deletedAt).not.toBeNull();

    // Hidden from every read path.
    await expectAppFailure(getCustomerForScope(customer.id, ownerCtx()), "NOT_FOUND");
    const list = await listCustomers(ownerCtx(), { q: "PT Hapus Ini" });
    expect(list.rows.some((row) => row.id === customer.id)).toBe(false);

    // PIC rows are preserved but unreachable through the deleted customer.
    const picRow = await db.customerContact.findUnique({ where: { id: pic.id } });
    expect(picRow).not.toBeNull();
    expect(picRow?.customerId).toBe(customer.id);
    await expectAppFailure(
      addContact(customer.id, { name: "X Y", isPrimary: false }, ownerCtx()),
      "NOT_FOUND",
    );
    await expectAppFailure(deleteContact(pic.id, ownerCtx()), "NOT_FOUND");

    // Audit trail: CUSTOMER_CREATED + CUSTOMER_DELETED both exist.
    const audit = await db.auditLog.findFirst({
      where: { action: "CUSTOMER_DELETED", entityId: customer.id },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.metadata ?? {})).toContain("deleted");
  });

  it("masks the NPWP in the detail view (first 4 chars only)", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Sensor Tbk" }), ownerCtx());
    const full = await getCustomerForScope(customer.id, ownerCtx());
    const view = toCustomerDetail(full);
    expect(view.taxIdMasked).toContain("01.2");
    expect(view.taxIdMasked).toContain("•");
    expect(view.taxIdMasked).not.toContain("2345");
    expect(JSON.stringify(view)).not.toContain(NPWP_DIGITS);

    // The exported mask helper behaves the same for callers (and null input).
    expect(maskTaxId(NPWP)?.startsWith("01.2")).toBe(true);
    expect(maskTaxId(null)).toBeNull();

    await softDeleteCustomer(customer.id, ownerCtx());
  });
});

describe("PIC (CustomerContact) management", () => {
  it("keeps exactly one primary PIC: promoting demotes the previous primary", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT PIC Utama" }), ownerCtx());

    const first = await addContact(
      customer.id,
      { name: "Agus Salim", title: "Manager", email: "agus@pic.test", isPrimary: true },
      ownerCtx(),
    );
    expect(first.isPrimary).toBe(true);

    const second = await addContact(
      customer.id,
      { name: "Rina Wati", title: "Admin", email: "rina@pic.test", isPrimary: true },
      ownerCtx(),
    );
    expect(second.isPrimary).toBe(true);

    const primaries = await db.customerContact.findMany({
      where: { customerId: customer.id, isPrimary: true },
    });
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.id).toBe(second.id);

    // Promoting the first one back demotes the second in the same transaction.
    const repromoted = await updateContact(
      first.id,
      { name: "Agus Salim", title: "Manager", email: "agus@pic.test", isPrimary: true },
      ownerCtx(),
    );
    expect(repromoted.isPrimary).toBe(true);
    const after = await db.customerContact.findMany({
      where: { customerId: customer.id, isPrimary: true },
    });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first.id);

    // Deleting a PIC is a hard delete of the contact row; the customer stays.
    await deleteContact(second.id, ownerCtx());
    expect(await db.customerContact.findUnique({ where: { id: second.id } })).toBeNull();
    const kept = await getCustomerForScope(customer.id, ownerCtx());
    expect(kept.deletedAt).toBeNull();
    expect(kept.contacts).toHaveLength(1);

    await softDeleteCustomer(customer.id, ownerCtx());
  });

  it("answers 404 for a PIC that belongs to another organization", async () => {
    const foreign = await createCustomer(customerInput({ companyName: "PT Luar Negeri" }), ownerCtx());
    const pic = await addContact(foreign.id, { name: "Warga Luar", isPrimary: true }, ownerCtx());
    await softDeleteCustomer(foreign.id, ownerCtx());

    // Re-create a live customer in the other org and try to reach the foreign PIC.
    const foreignOrgCustomer = await createCustomer(
      customerInput({ companyName: "PT Dari Org Lain" }),
      ownerCtx(otherOrg.id),
    );
    await expectAppFailure(
      updateContact(pic.id, { name: "Dicuri", isPrimary: true }, ownerCtx(otherOrg.id)),
      "NOT_FOUND",
    );
    await expectAppFailure(
      addContact(foreignOrgCustomer.id, { name: "X Y", isPrimary: false }, ownerCtx()),
      "NOT_FOUND",
    );
    await softDeleteCustomer(foreignOrgCustomer.id, ownerCtx(otherOrg.id));
  });
});

describe("server-side pagination and search", () => {
  it("caps pageSize at 100 (pageSize=999999 cannot pull the table)", async () => {
    const result = await listCustomers(ownerCtx(), { pageSize: 999999, page: 1 });
    expect(result.pageSize).toBe(100);
    expect(result.rows.length).toBeLessThanOrEqual(100);
    expect(result.page).toBe(1);
    expect(result.total).toBeGreaterThan(0);
    expect(result.totalPages).toBe(Math.max(1, Math.ceil(result.total / 100)));
  });

  it("pages deterministically with a stable sort", async () => {
    // Guaranteed volume: 5 live customers so page 1 (size 3) is full.
    for (const name of ["PT Halaman A", "PT Halaman B", "PT Halaman C", "PT Halaman D", "PT Halaman E"]) {
      await createCustomer(customerInput({ companyName: name }), ownerCtx());
    }
    const firstPage = await listCustomers(ownerCtx(), { page: 1, pageSize: 3 });
    const secondPage = await listCustomers(ownerCtx(), { page: 2, pageSize: 3 });
    expect(firstPage.rows).toHaveLength(3);
    expect(secondPage.rows.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(firstPage.rows.map((row) => row.id));
    for (const row of secondPage.rows) {
      expect(ids.has(row.id)).toBe(false);
    }
    expect(firstPage.rows[0]!.companyName <= firstPage.rows[1]!.companyName).toBe(true);
  });

  it('search is case-insensitive and finds "Cipta"', async () => {
    await createCustomer(customerInput({ companyName: "PT Cipta Karya Nusantara" }), ownerCtx());

    const upper = await listCustomers(ownerCtx(), { q: "Cipta" });
    const lower = await listCustomers(ownerCtx(), { q: "cipTa karYa" });
    expect(upper.rows.some((row) => row.companyName === "PT Cipta Karya Nusantara")).toBe(true);
    expect(lower.rows.some((row) => row.companyName === "PT Cipta Karya Nusantara")).toBe(true);

    const miss = await listCustomers(ownerCtx(), { q: "Tidak Ada Perusahaan Ini" });
    expect(miss.rows).toHaveLength(0);
    expect(miss.total).toBe(0);
  });

  it("search never crosses the organization boundary", async () => {
    const result = await listCustomers(ownerCtx(), { page: Number.NaN, pageSize: 10 });
    expect(result.page).toBe(1);
    expect(result.rows.length).toBeGreaterThan(0);

    const otherResult = await listCustomers(ownerCtx(otherOrg.id), { q: "Cipta" });
    expect(otherResult.rows).toHaveLength(0);
    expect(otherResult.total).toBe(0);

    const mine = await listCustomers(ownerCtx(), {});
    for (const row of mine.rows) {
      const full = await db.customer.findUnique({ where: { id: row.id } });
      expect(full?.organizationId).toBe(org.id);
      expect(full?.deletedAt).toBeNull();
    }
  });

  it("searches projects by reference number, title and customer name", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Cari Project" }), ownerCtx());
    await createProject(
      projectInput(customer.id, { referenceNumber: "SPK-99123", title: "Servis Line 3" }),
      ownerCtx(),
    );

    const result = await listProjects(ownerCtx(), { page: Number.NaN, pageSize: 10 });
    expect(result.page).toBe(1);
    expect(result.rows.length).toBeGreaterThan(0);

    const byNumber = await listProjects(ownerCtx(), { q: "99123" });
    expect(byNumber.rows).toHaveLength(1);
    expect(byNumber.rows[0]!.referenceNumber).toBe("SPK-99123");

    const byCustomer = await listProjects(ownerCtx(), { q: "Cari Project" });
    expect(byCustomer.rows).toHaveLength(1);
    expect(byCustomer.rows[0]!.customerName).toBe("PT Cari Project");

    const capped = await listProjects(ownerCtx(), { pageSize: 999999 });
    expect(capped.pageSize).toBe(100);
    expect(capped.rows.length).toBeLessThanOrEqual(100);
  });
});

describe("project / PO reference CRUD", () => {
  it("creates, reads and updates a project for every reference type", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Semua Jenis" }), ownerCtx());

    for (const referenceType of REFERENCE_TYPES) {
      const project = await createProject(
        projectInput(customer.id, {
          referenceType,
          referenceNumber: `REF-${referenceType}`,
          title: `Dokumen ${referenceType}`,
        }),
        ownerCtx(),
      );
      expect(project.referenceType).toBe(referenceType);
      expect(project.workValue.toString()).toBe("450000000");
      expect(project.currency).toBe("IDR");

      const read = await getProjectForScope(project.id, ownerCtx());
      expect(read.customer.companyName).toBe("PT Semua Jenis");

      const updated = await updateProject(
        project.id,
        projectInput(customer.id, {
          referenceType,
          referenceNumber: `REF-${referenceType}`,
          title: `Dokumen ${referenceType} (Revisi)`,
          workValue: "500000000.75",
          status: "COMPLETED",
        }),
        ownerCtx(),
      );
      expect(updated.title).toBe(`Dokumen ${referenceType} (Revisi)`);
      expect(updated.workValue.toString()).toBe("500000000.75");
      expect(updated.status).toBe("COMPLETED");
    }

    const createdAudits = await db.auditLog.count({
      where: { action: "PROJECT_CREATED", organizationId: org.id },
    });
    expect(createdAudits).toBeGreaterThanOrEqual(REFERENCE_TYPES.length);
    const updatedAudits = await db.auditLog.findFirst({
      where: { action: "PROJECT_UPDATED", organizationId: org.id },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(updatedAudits?.metadata ?? {})).toContain("fields");
  });

  it("rejects a forged customer id from another organization (404, IDOR guard)", async () => {
    const foreignCustomer = await createCustomer(
      customerInput({ companyName: "PT Korban IDOR" }),
      ownerCtx(otherOrg.id),
    );
    const failure = await expectAppFailure(
      createProject(projectInput(foreignCustomer.id), ownerCtx()),
      "NOT_FOUND",
    );
    expect(failure.message).toMatch(/tidak ditemukan/i);
  });

  it("deletes a project (hard delete) and audits the removal", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Proyek Hapus" }), ownerCtx());
    const project = await createProject(projectInput(customer.id), ownerCtx());

    await deleteProject(project.id, ownerCtx());
    await expectAppFailure(getProjectForScope(project.id, ownerCtx()), "NOT_FOUND");

    // The AuditAction enum has no PROJECT_DELETED yet (finalized in feature
    // 11): the removal is recorded as PROJECT_UPDATED change=deleted.
    const audit = await db.auditLog.findFirst({
      where: { action: "PROJECT_UPDATED", entityId: project.id },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.metadata ?? {})).toContain("deleted");
    // The customer row is untouched.
    const kept = await getCustomerForScope(customer.id, ownerCtx());
    expect(kept.deletedAt).toBeNull();
  });

  it("scopes project reads to the organization (cross-org id → 404)", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Proyek Org" }), ownerCtx());
    const project = await createProject(projectInput(customer.id), ownerCtx());

    await expectAppFailure(getProjectForScope(project.id, ownerCtx(otherOrg.id)), "NOT_FOUND");
    const list = await listProjects(ownerCtx(otherOrg.id), { q: project.referenceNumber });
    expect(list.rows).toHaveLength(0);
  });
});

describe("PO attachment upload (MIME decided by content)", () => {
  it("accepts a PDF, replaces it, and removes it (file cleanup verified)", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Lampiran PDF" }), ownerCtx());
    const project = await createProject(projectInput(customer.id), ownerCtx());

    const pdf = new File([PDF_BYTES], "purchase-order.pdf", { type: "application/pdf" });
    const uploaded = await uploadProjectAttachment(project.id, pdf, ownerCtx());
    expect(uploaded.attachmentPath).toMatch(
      new RegExp(`^uploads/organizations/${org.id}/references/[0-9a-f-]{36}\\.pdf$`),
    );

    const stored = await getStorageService().read(uploaded.attachmentPath!);
    expect(stored.mimeType).toBe("application/pdf");

    const audit = await db.auditLog.findFirst({
      where: { action: "PROJECT_UPDATED", entityId: project.id },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(audit?.metadata ?? {})).toContain("attachment");

    // A second upload replaces the path and cleans up the previous bytes.
    const png = new File([PNG], "purchase-order-scan.png", { type: "image/png" });
    const replaced = await uploadProjectAttachment(project.id, png, ownerCtx());
    expect(replaced.attachmentPath).not.toBe(uploaded.attachmentPath);
    expect(replaced.attachmentPath).toMatch(/\.png$/);
    await expectAppFailure(getStorageService().read(uploaded.attachmentPath!), "NOT_FOUND");

    // Removing the attachment clears the column and deletes the file.
    const removed = await removeProjectAttachment(project.id, ownerCtx());
    expect(removed.attachmentPath).toBeNull();
    await expectAppFailure(getStorageService().read(replaced.attachmentPath!), "NOT_FOUND");
  });

  it("rejects a file over the 2 MB limit with a clear message", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT File Besar" }), ownerCtx());
    const project = await createProject(projectInput(customer.id), ownerCtx());

    const oversize = new Uint8Array(2 * 1024 * 1024 + 1024);
    oversize.set(PNG, 0);
    const failure = await expectAppFailure(
      uploadProjectAttachment(project.id, new File([oversize], "besar.png", { type: "image/png" }), ownerCtx()),
      "VALIDATION_ERROR",
    );
    expect(failure.message).toMatch(/melebihi batas 2 MB/);

    const after = await getProjectForScope(project.id, ownerCtx());
    expect(after.attachmentPath).toBeNull();
  });

  it("rejects a fake MIME: ZIP bytes named .png are judged by content", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Palsu Format" }), ownerCtx());
    const project = await createProject(projectInput(customer.id), ownerCtx());

    const failure = await expectAppFailure(
      uploadProjectAttachment(
        project.id,
        new File([ZIP_BYTES], "purchase-order.png", { type: "image/png" }),
        ownerCtx(),
      ),
      "VALIDATION_ERROR",
    );
    expect(failure.message).toMatch(/Format yang diizinkan/);
    expect(failure.message).toContain("PNG"); // the allow-list, spelled out

    const after = await getProjectForScope(project.id, ownerCtx());
    expect(after.attachmentPath).toBeNull();
  });
});

describe("authorization — flat workspace (Change 6: no role tiers)", () => {
  // Every member of an organization is a full admin: writes that used to be
  // refused to VIEWER now succeed for them, because the only gate left is a
  // verified membership in an ACTIVE organization.
  it("allows every customer/PIC write to any member (VIEWER included)", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Uji Viewer" }), ownerCtx());
    const pic = await addContact(customer.id, { name: "Wati Rahayu", isPrimary: true }, ownerCtx());

    const byViewer = await createCustomer(customerInput({ companyName: "PT Buatan Viewer" }), viewerCtx());
    expect(byViewer.organizationId).toBe(org.id);
    const updated = await updateCustomer(
      customer.id,
      customerInput({ companyName: "Direview Viewer" }),
      viewerCtx(),
    );
    expect(updated.companyName).toBe("Direview Viewer");
    const contact = await addContact(
      customer.id,
      { name: "Dicuri Juga", isPrimary: false },
      viewerCtx(),
    );
    await updateContact(pic.id, { name: "Diupdate Viewer", isPrimary: true }, viewerCtx());
    await deleteContact(contact.id, viewerCtx());
    await softDeleteCustomer(customer.id, viewerCtx());

    // The write landed and is readable by every member.
    // The write landed: the soft delete is visible to every member.
    await expectAppFailure(getCustomerForScope(customer.id, ownerCtx()), "NOT_FOUND");
    const readable = await listCustomers(viewerCtx(), { q: "Direview Viewer" });
    expect(readable.rows).toHaveLength(0);
  });

  it("allows every project write to any member (VIEWER included)", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Uji Staff" }), ownerCtx());
    const project = await createProject(projectInput(customer.id), ownerCtx());

    // Flat workspace: the same writes succeed for any member.
    const viewerProject = await createProject(projectInput(customer.id), viewerCtx());
    expect(viewerProject.organizationId).toBe(org.id);
    const viewerUpdated = await updateProject(
      project.id,
      projectInput(customer.id, { title: "Diedit Viewer" }),
      viewerCtx(),
    );
    expect(viewerUpdated.title).toBe("Diedit Viewer");
    const viewerUpload = await uploadProjectAttachment(
      project.id,
      new File([PDF_BYTES], "po.pdf", { type: "application/pdf" }),
      viewerCtx(),
    );
    expect(viewerUpload.attachmentPath).toMatch(/\.pdf$/);
    await removeProjectAttachment(project.id, viewerCtx());

    // STAFF is a writer for feature 03 (permission matrix: customer.* project.*).
    const staffCustomer = await createCustomer(
      customerInput({ companyName: "PT Dibuat Staff" }),
      staffCtx(),
    );
    expect(staffCustomer.organizationId).toBe(org.id);
    const staffProject = await createProject(projectInput(staffCustomer.id), staffCtx());
    expect(staffProject.organizationId).toBe(org.id);
    const staffUpload = await uploadProjectAttachment(
      staffProject.id,
      new File([PDF_BYTES], "po.pdf", { type: "application/pdf" }),
      staffCtx(),
    );
    expect(staffUpload.attachmentPath).toMatch(/\.pdf$/);

    await deleteProject(project.id, viewerCtx());
    await expectAppFailure(getProjectForScope(project.id, ownerCtx()), "NOT_FOUND");
  });
});

describe("organization isolation (IDOR guard)", () => {
  it("answers 404 for another organization's customer id and hides mutations", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Terlindung" }), ownerCtx());

    const read = await expectAppFailure(
      getCustomerForScope(customer.id, ownerCtx(otherOrg.id)),
      "NOT_FOUND",
    );
    expect(read.message).toMatch(/tidak ditemukan/i);

    await expectAppFailure(
      updateCustomer(customer.id, customerInput({ companyName: "Diambil Alih" }), ownerCtx(otherOrg.id)),
      "NOT_FOUND",
    );
    await expectAppFailure(softDeleteCustomer(customer.id, ownerCtx(otherOrg.id)), "NOT_FOUND");
    await expectAppFailure(
      addContact(customer.id, { name: "Penyusup", isPrimary: true }, ownerCtx(otherOrg.id)),
      "NOT_FOUND",
    );
    await expectAppFailure(getCustomerForScope("cust_tidak_pernah_ada", ownerCtx()), "NOT_FOUND");

    const alive = await getCustomerForScope(customer.id, ownerCtx());
    expect(alive.companyName).toBe("PT Terlindung");
    await softDeleteCustomer(customer.id, ownerCtx());
  });
});

describe("NPWP never reaches the audit table", () => {
  it("audit metadata for every customer/project action carries no tax id", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT NPWP Rapat" }), ownerCtx());
    await addContact(customer.id, { name: "Bendahara", isPrimary: true }, ownerCtx());
    await updateCustomer(customer.id, customerInput({ companyName: "PT NPWP Rapat", city: "Surabaya" }), ownerCtx());
    const project = await createProject(projectInput(customer.id), ownerCtx());
    await updateProject(project.id, projectInput(customer.id, { title: "Judul Baru" }), ownerCtx());
    await softDeleteCustomer(customer.id, ownerCtx());

    const dump = await auditMetadataDump({ organizationId: org.id });
    expect(dump.length).toBeGreaterThan(0);
    expect(dump).not.toContain(NPWP);
    expect(dump).not.toContain(NPWP_DIGITS);
    // Field names are allowed; values are not.
    expect(await auditMetadataDump({ organizationId: org.id, entityId: customer.id })).toContain(
      "created",
    );

    // The raw NPWP lives only in the Customer row (and nowhere else).
    const raw = await db.customer.findUnique({ where: { id: customer.id } });
    expect(raw?.taxId).toBe(NPWP);
    const allAudits = await db.auditLog.findMany({ where: { organizationId: org.id } });
    for (const row of allAudits) {
      expect(String(row.userAgent ?? "")).not.toContain(NPWP);
      expect(String(row.ipAddress ?? "")).not.toContain(NPWP_DIGITS);
    }
    expect(project.organizationId).toBe(org.id);
  });
});

describe("invoice prefill hook (feature 04 preparation)", () => {
  it("returns decimal strings and an EMPTY items list — never a fabricated 0", async () => {
    const customer = await createCustomer(customerInput({ companyName: "PT Prefill Nanti" }), ownerCtx());
    const project = await createProject(
      projectInput(customer.id, { referenceNumber: "PO-777", referenceDate: "2026-09-14", workValue: "725000000" }),
      ownerCtx(),
    );

    const prefill = await prefillFromProject(project.id, ownerCtx());
    expect(prefill.customerId).toBe(customer.id);
    expect(prefill.referenceNumber).toBe("PO-777");
    expect(prefill.workValue).toBe("725000000");
    expect(prefill.items).toEqual([]);
    expect(prefill.referenceDate?.toISOString()).toBe("2026-09-14T00:00:00.000Z");

    // Organization isolation applies to the prefill hook too.
    await expectAppFailure(prefillFromProject(project.id, ownerCtx(otherOrg.id)), "NOT_FOUND");
  });
});

describe("seed (scripts/seed.mjs, Change 6: Drizzle + neutral demo data)", () => {
  it(
    "seeds a demo workspace whose customer is found by search \"Cipta\"",
    async () => {
      execFileSync(process.execPath, ["scripts/seed.mjs"], {
        cwd: process.cwd(),
        env: {
          // Hermetic: the child writes to the TEST database (DATABASE_URL is
          // already the test URL in this process and seed only fills gaps).
          ...process.env,
        },
        stdio: "pipe",
      });

      const demoOrg = await db.organization.findUnique({ where: { slug: "crea-invoice-studio" } });
      expect(demoOrg).not.toBeNull();

      const seedAdmin = await db.user.findUnique({ where: { username: "admin" } });
      expect(seedAdmin).not.toBeNull();

      // The demo admin belongs to the demo org (the seed's own contract).
      const membership = await db.membership.findFirst({
        where: { userId: seedAdmin!.id, organizationId: demoOrg!.id },
      });
      expect(membership).not.toBeNull();

      const ctx = ctxFor(demoOrg!.id, seedAdmin!.id);
      const found = await listCustomers(ctx, { q: "Cipta" });
      expect(found.rows.length).toBeGreaterThanOrEqual(1);
      expect(found.rows.some((row) => row.companyName === "PT Cipta Karya Nusantara")).toBe(true);

      const project = await db.projectReference.findFirst({
        where: { organizationId: demoOrg!.id, referenceNumber: "5198021181" },
      });
      expect(project).not.toBeNull();
      expect(project!.referenceType).toBe("PURCHASE_ORDER");

      // Idempotent: a second run must not duplicate the customer.
      execFileSync(process.execPath, ["scripts/seed.mjs"], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: "pipe",
      });
      const customers = await db.customer.count({
        where: { organizationId: demoOrg!.id, companyName: "PT Cipta Karya Nusantara" },
      });
      expect(customers).toBe(1);
    },
    60_000,
  );
});
