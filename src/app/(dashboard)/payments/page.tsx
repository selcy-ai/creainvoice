// src/app/(dashboard)/payments/page.tsx
// Payment list (feature 07): server-side pagination with invoice / customer /
// date filters (URL-driven, PaymentsTable), plus the "Catat pembayaran"
// entry — shown only where the SERVICE would accept a payment (payment.record)
// and only when a payable invoice actually exists (no fake buttons).

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PaymentsTable } from "@/components/tables/payments-table";
import { PaymentRecordDialog } from "@/components/payments/payment-record-dialog";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { env } from "@/server/env";
import { PAYMENTS_PAGE_SIZE } from "@/modules/payments/schema";
import { listPayableInvoices, listPayments } from "@/modules/payments/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Pembayaran — creainvoice",
};

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  const params = await searchParams;
  const page = Math.max(1, Number(first(params.page)) || 1);
  const invoice = first(params.invoice).slice(0, 100);
  const customer = first(params.customer).slice(0, 100);
  const from = first(params.from).slice(0, 10);
  const to = first(params.to).slice(0, 10);

  if (!scope) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pembayaran</h1>
        <Card>
          <CardHeader>
            <CardTitle>Belum ada workspace aktif</CardTitle>
            <CardDescription>
              Pilih atau buat organisasi terlebih dahulu untuk melihat riwayat pembayaran.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const result = await listPayments(
    { scope },
    { page, pageSize: PAYMENTS_PAGE_SIZE, invoice, customer, from, to },
  );
  const mayRecord = Boolean(scope);
  const payableInvoices = mayRecord ? await listPayableInvoices({ scope }) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Pembayaran</h1>
          <p className="text-sm text-muted-foreground">
            Riwayat pembayaran seluruh invoice di organisasi ini. Pencatatan manual — tidak ada
            integrasi payment gateway.
          </p>
        </div>
        {mayRecord && payableInvoices.length > 0 ? (
          <PaymentRecordDialog
            invoices={payableInvoices}
            canOverrideOverpayment={Boolean(scope)}
            maxUploadMb={Math.round(env.UPLOAD_MAX_MB)}
          />
        ) : null}
      </div>

      <PaymentsTable
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        invoice={invoice}
        customer={customer}
        from={from}
        to={to}
      />
    </div>
  );
}
