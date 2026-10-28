// src/app/(auth)/login/page.tsx — Clerk sign-in (Change 6).
//
// <SignIn /> renders Clerk's hosted, theme-aware sign-in card (username/
// email + password, SSO, everything Clerk manages). Credentials live only in
// Clerk — the old better-auth hashes could not be migrated (agreed), so any
// pre-existing user must reset their password through Clerk.

import { SignIn } from "@clerk/nextjs";

export default function LoginPage() {
  return <SignIn />;
}
