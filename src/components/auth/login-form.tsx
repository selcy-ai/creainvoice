"use client";

// src/components/auth/login-form.tsx — local email+password sign-in (Change 14).
//
// Posts to better-auth's own endpoint (POST /api/auth/sign-in/email) with a
// plain form action — no client SDK, no third-party host. The card + layout
// are the v4 ones the app already ships; only the form contents are new.
//
// On success better-auth sets the session cookie (HttpOnly+SameSite, Secure
// in production) and the client routes to /dashboard.

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "cn";

type FieldErrors = { email?: string; password?: string };

/**
 * The form itself. `useSearchParams` must sit inside a Suspense boundary
 * when the page is statically rendered, so the page wraps this in
 * <React.Suspense>.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  const callback = searchParams.get("callbackUrl") ?? "/dashboard";

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setFormError(null);
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const rememberMe = formData.get("remember") === "on";

    const nextErrors: FieldErrors = {};
    if (!email) nextErrors.email = "Email wajib diisi.";
    if (!password) nextErrors.password = "Kata sandi wajib diisi.";
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setLoading(false);
      return;
    }

    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, rememberMe }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;

      if (!response.ok) {
        const message = payload?.error?.message ?? "Email atau kata sandi salah.";
        // better-auth returns UNAUTHORIZED for both unknown emails and wrong
        // passwords on purpose — do not leak which one failed.
        setFormError(message);
        setLoading(false);
        return;
      }

      router.push(callback);
      router.refresh();
    } catch {
      setFormError("Tidak dapat menghubungi server. Coba beberapa saat lagi.");
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl bg-card p-6 text-card-foreground ring-1 ring-foreground/10">
      <div className="mb-6 flex flex-col gap-1.5">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">Masuk</h1>
        <p className="text-sm text-muted-foreground">
          Masuk ke akun CreaInvoice Anda.
        </p>
      </div>

      {/*
        action + method="POST" are the no-JS contract: when JS is blocked or
        slow to hydrate (the tunnel/phone case), the browser still submits the
        form as a POST with the credentials in the BODY — never a GET that
        would land them in the URL (security-standards). better-auth accepts
        form-encoded on these routes as an intentional progressive-enhancement
        path and enforces Fetch-Metadata/origin CSRF checks on it. When JS
        runs, onSubmit intercepts and takes over.
      */}
      <form
        action="/api/auth/sign-in/email"
        method="POST"
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
        noValidate
      >
        {/* The JS path reads ?callbackUrl; the no-JS POST needs it in the body. */}
        <input type="hidden" name="callbackURL" value={callback} />
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
            autoComplete="current-password"
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

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            name="remember"
            className="size-4 rounded border-border accent-primary"
          />
          Ingat saya di perangkat ini
        </label>

        {formError ? (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {formError}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Memproses…" : "Masuk"}
        </Button>
      </form>

      {/* No-JS guidance: the form still submits as a POST above (never a GET
       * that would leak credentials into the URL), but the auth endpoint
       * answers JSON, so a browser without JavaScript will show that
       * response instead of a page. */}
      <noscript>
        <p className="mt-4 text-xs text-muted-foreground">
          JavaScript dinonaktifkan. Aktifkan JavaScript untuk masuk.
        </p>
      </noscript>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Belum punya akun?{" "}
        <Link
          href="/register"
          className={cn("font-medium text-primary hover:underline")}
        >
          Daftar
        </Link>
      </p>
    </div>
  );
}
