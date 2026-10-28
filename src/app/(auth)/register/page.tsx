// src/app/(auth)/register/page.tsx — public sign-up (Change 14).
//
// security-standards.md baris 7: public registration is ON for the
// self-hosted build. The form POSTs to better-auth's /sign-up/email; the
// account is created with emailVerified=false and better-auth requires
// verification before a session is issued (no SMTP yet — the verification
// link is logged on the server, and a later feature adds a real transport).

import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = {
  title: "Daftar — CreaInvoice",
};

export default function RegisterPage() {
  return <RegisterForm />;
}
