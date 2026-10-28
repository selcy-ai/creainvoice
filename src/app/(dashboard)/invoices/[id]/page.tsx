// src/app/(dashboard)/invoices/[id]/page.tsx
// Invoice detail (feature 05): the document's read model plus its lifecycle
// actions (Issue / Mark sent / Cancel / Revise). Issued invoices render from
// the frozen SNAPSHOTS (detail-service), so editing the profile, customer or
// bank afterwards never changes this page — the "Data saat diterbitkan" note
// says so out loud. Overdue is computed on read; the PDF section reports the
// honest queue status (no fake download before feature 06 renders the file).

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  INVOICE_STATUS_LABELS,
  InvoiceStatusBadge,
} from "@/components/invoice/invoice-status-badge";
import { InvoiceLifecycleActions } from "@/components/invoice/invoice-lifecycle-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isAppError } from "@/lib/errors";
import { formatIdr } from "@/lib/money";
import { env } from "@/server/env";
import { getInvoiceDetail, type InvoiceDetailView } from "@/modules/invoices/detail-service";
import { getInvoicePaymentPanel, type InvoicePaymentPanel } from "@/modules/payments/service";
import { PaymentHistory } from "@/components/payments/payment-history";
import { INVOICE_TYPE_LABELS, INVOICE_TAX_MODE_LABELS } from "@/modules/invoices/schema";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Detail invoice — creainvoice",
};

export const dynamic = "force-dynamic";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
  });
}

/** 1536 → "1,5 KB" (id-ID decimal comma). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString("id-ID", { maximumFractionDigits: 1 })} KB`;
  return `${(kb / 1024).toLocaleString("id-ID", { maximumFractionDigits: 2 })} MB`;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium sm:text-right">{value}</dd>
    </div>
  );
}

function billingLabel(invoice: InvoiceDetailView): string {
  const { billingMode, billingPercent, billingAmount } = invoice.billing;
  if (invoice.invoiceType === "DOWN_PAYMENT" || invoice.invoiceType === "TERM") {
    if (billingMode === "PERCENT" && billingPercent) return `${billingPercent}% dari nilai pekerjaan`;
    if (billingMode === "MANUAL" && billingAmount) return formatIdr(billingAmount);
  }
  if (invoice.invoiceType === "CUSTOM" && billingAmount) return formatIdr(billingAmount);
  return "Tagih penuh nilai pekerjaan";
}

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope) redirect("/invoices");

  let invoice: InvoiceDetailView;
  try {
    invoice = await getInvoiceDetail(id, { scope });
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  // Payment history (feature 07): same IDOR contract — a foreign invoice id
  // answers 404 here as well.
  let paymentPanel: InvoicePaymentPanel;
  try {
    paymentPanel = await getInvoicePaymentPanel(id, { scope });
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const title = invoice.number ?? invoice.numberPreview ?? "Invoice draft";
  const isOverdue = invoice.displayStatus === "OVERDUE";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight sm:text-[28px]">{title}</h1>
            <InvoiceStatusBadge status={invoice.displayStatus} />
            <Badge variant="secondary">{INVOICE_TYPE_LABELS[invoice.invoiceType]}</Badge>
            {invoice.fromSnapshot ? (
              <Badge variant="outline">Data saat diterbitkan</Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {invoice.customer?.name ?? "Customer belum dipilih"}
            {" · "}
            {formatDate(invoice.invoiceDate)}
            {invoice.dueDate ? ` · Jatuh tempo ${formatDate(invoice.dueDate)}` : ""}
          </p>
          {isOverdue ? (
            <p className="text-sm font-medium text-destructive">
              Lewat jatuh tempo sejak {formatDate(invoice.dueDate)} — tagihan belum lunas.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {invoice.permissions.edit ? (
            <Button render={<Link href={`/invoices/${invoice.id}/edit`} />}>Edit draft</Button>
          ) : null}
          <InvoiceLifecycleActions
            invoiceId={invoice.id}
            invoiceLabel={invoice.number ?? invoice.numberPreview ?? "Invoice draft"}
            permissions={invoice.permissions}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Rincian dokumen</CardTitle>
              <CardDescription>
                {invoice.fromSnapshot
                  ? "Dibekukan saat invoice diterbitkan — tidak berubah oleh edit profil/customer/bank."
                  : "Data draft yang masih bisa diedit."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Nomor" value={<span className="font-mono">{title}</span>} />
                <Row label="Tanggal invoice" value={formatDate(invoice.invoiceDate)} />
                <Row label="Jatuh tempo" value={formatDate(invoice.dueDate)} />
                <Row
                  label="Jenis penagihan"
                  value={`${INVOICE_TYPE_LABELS[invoice.invoiceType]} — ${billingLabel(invoice)}`}
                />
                {invoice.billing.termName || invoice.billing.customLabel ? (
                  <Row
                    label="Label"
                    value={invoice.billing.termName ?? invoice.billing.customLabel ?? "—"}
                  />
                ) : null}
                <Row
                  label="Referensi"
                  value={
                    invoice.referenceNumber ? (
                      <span className="font-mono">{invoice.referenceNumber}</span>
                    ) : (
                      "—"
                    )
                  }
                />
                <Row
                  label="Project/PO"
                  value={
                    invoice.project ? (
                      <Link href={`/projects/${invoice.project.id}`} className="hover:underline">
                        {invoice.project.title}
                      </Link>
                    ) : (
                      "—"
                    )
                  }
                />
                <Row label="Pembayaran" value={invoice.paymentTerms ?? "—"} />
                <Row label="Pajak" value={INVOICE_TAX_MODE_LABELS[invoice.amounts.taxMode]} />
                <Row label="Mata uang" value={invoice.currency} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Item pekerjaan</CardTitle>
              <CardDescription>{invoice.items.length} baris</CardDescription>
            </CardHeader>
            <CardContent>
              {invoice.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Belum ada item — tambahkan lewat editor draft.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">#</TableHead>
                      <TableHead>Uraian</TableHead>
                      <TableHead className="text-right">Jumlah</TableHead>
                      <TableHead className="text-right">Harga</TableHead>
                      <TableHead className="text-right">Diskon</TableHead>
                      <TableHead className="text-right">Jumlah</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoice.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="text-muted-foreground">{item.position}</TableCell>
                        <TableCell>
                          <div className="font-medium">{item.description}</div>
                          {item.details ? (
                            <div className="text-xs text-muted-foreground">{item.details}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {item.quantity} {item.unit}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatIdr(item.unitPrice)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatIdr(item.discountAmount)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatIdr(item.lineAmount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pihak &amp; dokumen</CardTitle>
              <CardDescription>Issuer, customer, PIC, rekening, penanda tangan.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Profil penerbit" value={invoice.issuer.name} />
                <Row label="Alamat penerbit" value={invoice.issuer.address ?? "—"} />
                <Row label="Customer" value={invoice.customer?.name ?? "—"} />
                <Row label="NPWP customer" value={invoice.customer?.taxId ?? "—"} />
                <Row label="PIC" value={invoice.contact?.name ?? "—"} />
                <Row
                  label="Rekening pembayaran"
                  value={
                    invoice.bank ? (
                      <span className="font-mono">
                        {invoice.bank.bankName} · {invoice.bank.maskedNumber} ·{" "}
                        {invoice.bank.accountHolder}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
                <Row
                  label="Penanda tangan"
                  value={
                    invoice.signer
                      ? `${invoice.signer.name}${invoice.signer.title ? `, ${invoice.signer.title}` : ""}`
                      : "—"
                  }
                />
                <Row
                  label="Meterai"
                  value={
                    invoice.stampMode === "NONE"
                      ? "Tanpa meterai"
                      : invoice.stampMode === "E_METERAI"
                        ? "Meterai elektronik"
                        : invoice.stampMode === "PHYSICAL"
                          ? "Meterai fisik"
                          : "Ruang kosong meterai"
                  }
                />
              </dl>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Tagihan</CardTitle>
              <CardDescription>
                {invoice.fromSnapshot
                  ? "Angka hasil perhitungan server saat penerbitan."
                  : "Angka hasil perhitungan server (diperbarui setiap autosave)."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Nilai pekerjaan" value={<span className="font-mono">{formatIdr(invoice.amounts.workValue)}</span>} />
                <Row label="Subtotal item" value={<span className="font-mono">{formatIdr(invoice.amounts.itemsSubtotal)}</span>} />
                <Row
                  label="Sudah ditagihkan sebelumnya"
                  value={<span className="font-mono">{formatIdr(invoice.amounts.previouslyBilled)}</span>}
                />
                <Row label="Dasar penagihan" value={<span className="font-mono">{formatIdr(invoice.amounts.billingBase)}</span>} />
                <Row label="Diskon" value={<span className="font-mono">{formatIdr(invoice.amounts.discountAmount)}</span>} />
                <Row label="Biaya tambahan" value={<span className="font-mono">{formatIdr(invoice.amounts.additionalAmount)}</span>} />
                <Row
                  label={invoice.amounts.taxMode === "NONE" ? "Pajak" : `Pajak (${invoice.amounts.taxPercent ?? "0"}%)`}
                  value={<span className="font-mono">{formatIdr(invoice.amounts.taxAmount)}</span>}
                />
                <Row label="Pembulatan" value={<span className="font-mono">{formatIdr(invoice.amounts.roundingAmount)}</span>} />
                <div className="flex flex-col gap-1 border-t-2 border-border py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                  <dt className="text-sm font-semibold">Grand total</dt>
                  <dd className="font-mono text-lg font-semibold">
                    {formatIdr(invoice.amounts.grandTotal)}
                  </dd>
                </div>
                {!invoice.isDraft ? (
                  <>
                    <Row
                      label="Sisa tagihan"
                      value={<span className="font-mono">{formatIdr(invoice.amounts.remainingAfter)}</span>}
                    />
                    <Row
                      label="Sudah dibayar"
                      value={<span className="font-mono">{formatIdr(invoice.amounts.amountPaid)}</span>}
                    />
                  </>
                ) : null}
              </dl>
              {invoice.notes ? (
                <>
                  {/* Feature 10: the card shows the resolved text — identical to
                      what the printed document carries. */}
                  <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">
                    {invoice.notesDisplay}
                  </p>
                  {invoice.notesUnknownTokens.length > 0 ? (
                    <p className="mt-2 text-xs text-warning">
                      Token tidak dikenal{" "}
                      <span className="font-mono">
                        {invoice.notesUnknownTokens.map((token) => `{${token}}`).join(", ")}
                      </span>{" "}
                      tampil apa adanya di dokumen.
                    </p>
                  ) : null}
                </>
              ) : null}
              {!invoice.isDraft ? (
                <p className="mt-4 text-xs text-muted-foreground">
                  Sudah dibayar dan sisa tagihan mengikuti riwayat pembayaran di bawah —
                  snapshot dokumen tetap terkunci sejak diterbitkan.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>PDF resmi</CardTitle>
              <CardDescription>
                Dokumen PDF dicetak dari data terbit — bukan dari profil terbaru.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {invoice.isDraft ? (
                <p className="text-sm text-muted-foreground">
                  PDF dibuat setelah invoice diterbitkan.
                </p>
              ) : invoice.pdfJob === null ? (
                <p className="text-sm text-muted-foreground">Belum ada antrean PDF untuk invoice ini.</p>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <Badge variant={invoice.pdfJob.status === "FAILED" ? "destructive" : "secondary"}>
                      {invoice.pdfJob.status === "PENDING"
                        ? "PDF menunggu"
                        : invoice.pdfJob.status === "RUNNING"
                          ? "PDF sedang dibuat"
                          : invoice.pdfJob.status === "SUCCESS"
                            ? "PDF siap"
                            : "PDF gagal dibuat"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Antrean dibuat {formatTimestamp(invoice.pdfJob.createdAt)}
                      {invoice.pdfJob.attempt > 1 ? ` · percobaan ke-${invoice.pdfJob.attempt}` : ""}
                    </span>
                  </div>
                  {invoice.pdf ? (
                    <>
                      <div>
                        <p className="font-mono text-sm font-medium">{invoice.pdf.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatBytes(invoice.pdf.sizeBytes)} · versi {invoice.pdf.version} ·
                          dibuat {formatTimestamp(invoice.pdf.generatedAt)}
                        </p>
                      </div>
                      <div>
                        <Button
                          render={<a href={`/api/invoices/${invoice.id}/pdf`} download />}
                          data-testid="download-pdf"
                        >
                          Unduh PDF
                        </Button>
                      </div>
                    </>
                  ) : invoice.pdfJob.status === "FAILED" ? (
                    <p className="text-sm text-destructive">
                      {invoice.pdfJob.errorMessage ?? "Pembuatan PDF gagal."} Percobaan otomatis
                      berhenti setelah 3 kali — invoice tetap terbit dan tidak berubah.
                    </p>
                  ) : invoice.pdfJob.status === "SUCCESS" ? (
                    <p className="text-sm text-muted-foreground">
                      Job selesai tetapi file belum ada di penyimpanan — antrean akan diproses
                      ulang otomatis.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      File belum tersedia — pembuatan PDF berjalan otomatis di layanan terpisah.
                      Tombol unduh muncul begitu filenya benar-benar ada.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Riwayat</CardTitle>
              <CardDescription>Penerbitan, pembatalan, dan revisi.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Dibuat" value={formatTimestamp(invoice.createdAt)} />
                <Row label="Terakhir diubah" value={formatTimestamp(invoice.updatedAt)} />
                <Row label="Diterbitkan" value={formatTimestamp(invoice.issuedAt)} />
                <Row label="Diterbitkan oleh" value={invoice.issuedByName ?? "—"} />
                {invoice.cancelledAt ? (
                  <>
                    <Row label="Dibatalkan" value={formatTimestamp(invoice.cancelledAt)} />
                    <Row label="Alasan pembatalan" value={invoice.cancellationReason ?? "—"} />
                  </>
                ) : null}
                {invoice.revisedFrom ? (
                  <Row
                    label="Revisi dari"
                    value={
                      <Link href={`/invoices/${invoice.revisedFrom.id}`} className="hover:underline">
                        {invoice.revisedFrom.number ?? invoice.revisedFrom.numberPreview ?? "draft"}
                      </Link>
                    }
                  />
                ) : null}
                {invoice.replacedBy ? (
                  <Row
                    label="Digantikan oleh"
                    value={
                      <Link href={`/invoices/${invoice.replacedBy.id}`} className="hover:underline">
                        {invoice.replacedBy.number ?? invoice.replacedBy.numberPreview ?? "draft"}
                      </Link>
                    }
                  />
                ) : null}
                {invoice.status === "REVISED" || invoice.status === "CANCELLED" ? (
                  <Row
                    label="Status tersimpan"
                    value={INVOICE_STATUS_LABELS[invoice.status]}
                  />
                ) : null}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      <PaymentHistory panel={paymentPanel} maxUploadMb={Math.round(env.UPLOAD_MAX_MB)} />
    </div>
  );
}
