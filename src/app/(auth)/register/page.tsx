// src/app/(auth)/register/page.tsx — public sign-up (Change 14).
//
// security-standards.md baris 7: public registration is ON for the
// self-hosted build. The form carries action=/api/auth/sign-up/email +
// method=POST so a browser with JavaScript blocked still submits the
// credentials in the POST body (never a GET that leaks them into the URL).
// JS running takes over via the client handler. better-auth creates the
// account with emailVerified=false and requires verification before a
// session is issued (no SMTP yet — the verification link is logged on the
// server, and a later feature adds a real transport).

import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = {
  title: "Daftar — CreaInvoice",
};

export default function RegisterPage() {
  return <RegisterForm />;
}
