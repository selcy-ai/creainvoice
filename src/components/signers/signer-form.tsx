"use client";

// src/components/signers/signer-form.tsx
// Signer create/edit form (feature 10). Plain FormData + useActionState — the
// multipart body carries the optional signature image as a File, and the server
// sniffs it from content (never from the filename). VIEWER gets the identical
// form read-only; there is no secret on a signer, so nothing is masked here.

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bannerError, fieldError } from "@/components/forms/form-utils";
import { createSignerAction, updateSignerAction } from "@/modules/signers/actions";
import type { ActionResult } from "@/lib/api-response";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

export interface SignerFormProps {
  mode: "create" | "edit";
  /** Present in edit mode — the action scopes it (server re-verifies org). */
  signerId?: string;
  defaultValues: {
    name: string;
    title: string;
    location: string;
    isDefault: boolean;
    isActive: boolean;
  };
  /** Storage path of the current signature image, if any. */
  signaturePath?: string | null;
  canEdit: boolean;
}

export function SignerForm({
  mode,
  signerId,
  defaultValues,
  signaturePath,
  canEdit,
}: SignerFormProps) {
  const router = useRouter();
  const [isDefault, setIsDefault] = React.useState(defaultValues.isDefault);
  const [isActive, setIsActive] = React.useState(defaultValues.isActive);

  const [state, formAction, pending] = useActionState<
    ActionResult<{ signerId: string }> | null,
    FormData
  >(
    async (_prev, form) => {
      const result =
        mode === "create" ? await createSignerAction(form) : await updateSignerAction(form);
      if (result.ok) {
        toast.add({
          title: mode === "create" ? "Penanda tangan dibuat" : "Perubahan disimpan",
          description: defaultValues.name || "Data penanda tangan tersimpan.",
          type: "success",
        });
        if (mode === "create") {
          router.push(`/signers/${result.data.signerId}`);
        } else {
          router.refresh();
        }
      }
      return result;
    },
    null,
  );

  const banner = bannerError(state);
  const disabled = !canEdit || pending;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {signerId ? <input type="hidden" name="signerId" value={signerId} /> : null}
      <input type="hidden" name="isDefault" value={String(isDefault)} />
      <input type="hidden" name="isActive" value={String(isActive)} />

      {!canEdit ? (
        <p className="rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
          Mode lihat saja. Hanya STAFF, ADMIN, atau OWNER yang dapat mengubah data penanda tangan.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Data penanda tangan</CardTitle>
          <CardDescription>
            Nama dan jabatan tampil di blok tanda tangan dokumen invoice.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Nama</Label>
              <Input
                id="name"
                name="name"
                autoComplete="off"
                placeholder="mis. Andi Wijaya"
                defaultValue={defaultValues.name}
                disabled={disabled}
                aria-invalid={Boolean(fieldError(state, "name")) || undefined}
              />
              <FieldError message={fieldError(state, "name")} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="title">Jabatan (opsional)</Label>
              <Input
                id="title"
                name="title"
                placeholder="mis. Direktur"
                defaultValue={defaultValues.title}
                disabled={disabled}
                aria-invalid={Boolean(fieldError(state, "title")) || undefined}
              />
              <FieldError message={fieldError(state, "title")} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="location">Lokasi penanda tanganan (opsional)</Label>
            <Input
              id="location"
              name="location"
              placeholder="mis. Yogyakarta"
              defaultValue={defaultValues.location}
              disabled={disabled}
              aria-invalid={Boolean(fieldError(state, "location")) || undefined}
            />
            <FieldError message={fieldError(state, "location")} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gambar tanda tangan</CardTitle>
          <CardDescription>
            Opsional. PNG/JPEG/WebP maksimal 2 MB — isi file di-sniff langsung, nama berkas tidak
            dipercaya.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {signaturePath ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated storage route (feature 02 precedent) */}
              <img
                src={`/api/storage/${signaturePath}`}
                alt="Tanda tangan tersimpan"
                className="h-16 w-auto rounded-md border border-border bg-background object-contain p-1"
              />
              <p className="text-xs text-muted-foreground">
                Gambar saat ini. Unggah gambar baru untuk mengganti (yang lama dihapus otomatis).
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Belum ada gambar tanda tangan.</p>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="signatureFile">Unggah gambar baru</Label>
            <Input
              id="signatureFile"
              name="signatureFile"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={disabled}
              aria-invalid={Boolean(fieldError(state, "signatureFile")) || undefined}
            />
            <p className="text-xs text-muted-foreground">
              Kosongkan untuk mempertahankan gambar saat ini.
            </p>
            <FieldError message={fieldError(state, "signatureFile")} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pengaturan</CardTitle>
          <CardDescription>
            Penanda tangan utama menjadi preset saat membuat invoice. Penanda nonaktif tetap tampil
            di sini tetapi hilang dari pilihan invoice.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor="isDefault" className="flex items-center gap-2 font-normal">
            <Checkbox
              id="isDefault"
              checked={isDefault}
              onCheckedChange={(checked) => setIsDefault(checked === true)}
              disabled={disabled}
            />
            <span className="text-sm">Jadikan penanda tangan utama</span>
          </Label>
          <Label htmlFor="isActive" className="flex items-center gap-2 font-normal">
            <Checkbox
              id="isActive"
              checked={isActive}
              onCheckedChange={(checked) => setIsActive(checked === true)}
              disabled={disabled}
            />
            <span className="text-sm">Penanda tangan aktif</span>
          </Label>
        </CardContent>
      </Card>

      {banner ? (
        <p role="alert" className="text-sm text-destructive">
          {banner}
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            {pending
              ? "Menyimpan..."
              : mode === "create"
                ? "Buat penanda tangan"
                : "Simpan perubahan"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
