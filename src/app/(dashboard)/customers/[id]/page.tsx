// src/app/(dashboard)/customers/[id]/page.tsx
// Customer detail: edit form + PIC tab (feature 03 spec, halaman
// `/customers/[id]`). Cross-org ids and soft-deleted rows answer the same
// 404 as rows that never existed (IDOR guard in getCustomerForScope).
// NPWP reaches the form full only for STAFF+ editors; viewers see the
// masked value — their HTML never carries the raw tax id.

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { DeleteCustomerButton } from "@/components/customers/delete-customer-button";
import { CustomerForm } from "@/components/customers/customer-form";
import { ContactsPanel } from "@/components/customers/contacts-panel";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isAppError } from "@/lib/errors";
import { maskTaxId, getCustomerForScope, toContactView } from "@/modules/customers/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Detail Customer — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope) redirect("/customers");

  let customer;
  try {
    customer = await getCustomerForScope(id, { scope });
  } catch (error) {
    // Wrong organization, soft-deleted, and unknown id answer identically: 404.
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const mayEdit = Boolean(scope);
  const mayDelete = Boolean(scope);

  // PII rule: the raw NPWP only rides along for an authorized editor.
  const rawTaxId = customer.taxId ?? "";
  const taxIdMasked = Boolean(rawTaxId) && !mayEdit;
  const taxIdValue = mayEdit ? rawTaxId : (maskTaxId(rawTaxId) ?? "");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{customer.companyName}</h1>
            {customer.isActive ? (
              <Badge variant="outline">Aktif</Badge>
            ) : (
              <Badge variant="secondary">Tidak aktif</Badge>
            )}
            {!mayEdit ? <Badge variant="outline">Mode lihat saja</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {[customer.legalName, customer.businessType, customer.city].filter(Boolean).join(" · ") ||
              "Belum ada identitas tambahan."}
          </p>
        </div>
        {mayDelete ? (
          <DeleteCustomerButton customerId={customer.id} companyName={customer.companyName} />
        ) : null}
      </div>

      <Tabs defaultValue="data">
        <TabsList>
          <TabsTrigger value="data">Data customer</TabsTrigger>
          <TabsTrigger value="pic">PIC{customer.contacts.length > 0 ? ` (${customer.contacts.length})` : ""}</TabsTrigger>
        </TabsList>
        <TabsContent value="data">
          <CustomerForm
            mode="edit"
            customerId={customer.id}
            canEdit={mayEdit}
            taxIdValue={taxIdValue}
            taxIdMasked={taxIdMasked}
            defaultValues={{
              companyName: customer.companyName,
              legalName: customer.legalName ?? "",
              businessType: customer.businessType ?? "",
              taxId: taxIdValue,
              address: customer.address ?? "",
              city: customer.city ?? "",
              province: customer.province ?? "",
              postalCode: customer.postalCode ?? "",
              country: customer.country ?? "",
              phone: customer.phone ?? "",
              whatsapp: customer.whatsapp ?? "",
              email: customer.email ?? "",
              notes: customer.notes ?? "",
              isActive: customer.isActive,
            }}
          />
        </TabsContent>
        <TabsContent value="pic">
          <ContactsPanel
            customerId={customer.id}
            contacts={customer.contacts.map(toContactView)}
            canEdit={mayEdit}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
