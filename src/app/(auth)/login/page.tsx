// src/app/(auth)/login/page.tsx — local sign-in form (Change 14).
//
// Replaces Clerk's <SignIn />: the app now owns the whole flow. The form is a
// server-rendered card that POSTs to better-auth's own endpoint
// (POST /api/auth/sign-in/email) — no client auth SDK, no third-party host,
// so login works from any origin the deployment trusts (LAN included).
//
// The card and layout are the v4 ones this app already ships: this page only
// supplies the form inside (auth)/layout (BR-6 of the change spec).

import type { Metadata } from "next";
import * as React from "react";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Masuk — CreaInvoice",
};

export default function LoginPage() {
  // useSearchParams in the client form requires a Suspense boundary for the
  // static prerender.
  return (
    <React.Suspense fallback={null}>
      <LoginForm />
    </React.Suspense>
  );
}
