"use client";

// src/components/auth/register-form.tsx — public sign-up (Change 14).
//
// Posts to better-auth's /sign-up/email. The account is created with
// emailVerified=false; better-auth requires verification before issuing a
// session, so the user is sent to a "periksa email Anda" state (the
// verification link is logged server-side until SMTP lands).

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FieldErrors = {
  name?: string;
  email?: string;
  password?: string;
  confirm?: string;
};

const MIN_PASSWORD = 8;

export function RegisterForm() {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setFormError(null);
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");

    const nextErrors: FieldErrors = {};
    if (name.length < 2) nextErrors.name = "Nama minimal 2 karakter.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) nextErrors.email = "Email tidak valid.";
    if (password.length < MIN_PASSWORD) {
      nextErrors.password = `Kata sandi minimal ${MIN_PASSWORD} karakter.`;
    }
    if (confirm !== password) nextErrors.confirm = "Konfirmasi kata sandi tidak cocok.";
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setLoading(false);
      return;
    }

    try {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;

      if (!response.ok) {
        setFormError(
          payload?.error?.message ?? "Pendaftaran gagal. Coba email lain.",
        );
        setLoading(false);
        return;
      }

      // Account created; a session is not issued until the email is verified.
      router.push("/login?registered=1");
      router.refresh();
    } catch {
      setFormError("Tidak dapat menghubungi server. Coba beberapa saat lagi.");
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl bg-card p-6 text-card-foreground ring-1 ring-foreground/10">
      <div className="mb-6 flex flex-col gap-1.5">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">Daftar</h1>
        <p className="text-sm text-muted-foreground">
          Buat akun CreaInvoice. Pendaftaran terbuka untuk siapa saja.
        </p>
      </div>

      {/*
        action + method="POST" are the no-JS contract: when JS is blocked or
        slow to hydrate (the tunnel/phone case), the browser still submits the
        form as a POST with the credentials in the BODY — never a GET that
        would land them in the URL (security-standards). better-auth accepts
        form-encoded on these routes and enforces Fetch-Metadata/origin CSRF
        checks on it. When JS runs, onSubmit intercepts and takes over.
      */}
      <form
        action="/api/auth/sign-up/email"
        method="POST"
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
        noValidate
      >
        {/* The no-JS POST needs the post-registration destination in the body. */}
        <input type="hidden" name="callbackURL" value="/login?registered=1" />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Nama</Label>
          <Input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            placeholder="Nama Anda"
            aria-invalid={errors.name ? "true" : undefined}
            aria-describedby={errors.name ? "name-error" : undefined}
            required
          />
          {errors.name ? (
            <p id="name-error" className="text-xs text-destructive">
              {errors.name}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="nama@perusahaan.id"
            aria-invalid={errors.email ? "true" : undefined}
            aria-describedby={errors.email ? "email-error" : undefined}
            required
          />
          {errors.email ? (
            <p id="email-error" className="text-xs text-destructive">
              {errors.email}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Kata sandi</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password ? "true" : undefined}
            aria-describedby={errors.password ? "password-error" : undefined}
            required
          />
          {errors.password ? (
            <p id="password-error" className="text-xs text-destructive">
              {errors.password}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm">Ulangi kata sandi</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.confirm ? "true" : undefined}
            aria-describedby={errors.confirm ? "confirm-error" : undefined}
            required
          />
          {errors.confirm ? (
            <p id="confirm-error" className="text-xs text-destructive">
              {errors.confirm}
            </p>
          ) : null}
        </div>

        {formError ? (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {formError}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Memproses…" : "Daftar"}
        </Button>
      </form>

      {/* No-JS guidance: the form still submits as a POST above (never a GET
       * that would leak credentials into the URL), but the auth endpoint
       * answers JSON, so a browser without JavaScript will show that
       * response instead of a page. */}
      <noscript>
        <p className="mt-4 text-xs text-muted-foreground">
          JavaScript dinonaktifkan. Aktifkan JavaScript untuk mendaftar.
        </p>
      </noscript>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Sudah punya akun?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Masuk
        </Link>
      </p>
    </div>
  );
}
