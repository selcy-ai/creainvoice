// src/app/(auth)/login/page.tsx — local sign-in form (Change 14).
//
// Replaces Clerk's <SignIn />: the app now owns the whole flow. The form carries
// action=/api/auth/sign-in/email + method=POST so a browser with JavaScript
// blocked or slow to hydrate still submits the credentials in the POST body —
// never as a GET that would leak them into the URL (security-standards). When
// JS runs, the client handler intercepts and takes over (progressive
// enhancement), so login works from any origin the deployment trusts.
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
