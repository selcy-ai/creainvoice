// src/app/(dashboard)/customers/new/page.tsx
// Create customer. VIEWER never reaches a writable form (redirected back to
// the list) — the server action still re-checks with assertCan, so a crafted
// request gets 403, not a silent success.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CustomerForm } from "@/components/customers/customer-form";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/clerk";

export const metadata: Metadata = {
  title: "Tambah Customer — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function NewCustomerPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope || !Boolean(scope)) redirect("/customers");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Tambah customer</h1>
        <p className="text-sm text-muted-foreground">
          Identitas perusahaan, alamat, dan kontak umum. NPWP bersifat pribadi dan tidak pernah
          dicatat di log.
        </p>
      </div>

      <CustomerForm
        mode="create"
        canEdit
        taxIdValue=""
        taxIdMasked={false}
        defaultValues={{
          companyName: "",
          legalName: "",
          businessType: "",
          taxId: "",
          address: "",
          city: "",
          province: "",
          postalCode: "",
          country: "",
          phone: "",
          whatsapp: "",
          email: "",
          notes: "",
          isActive: true,
        }}
      />
    </div>
  );
}
