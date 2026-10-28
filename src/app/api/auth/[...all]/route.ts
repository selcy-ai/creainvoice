// src/app/api/auth/[...all]/route.ts — better-auth catch-all handler (Change 14).
//
// Every better-auth endpoint (POST /api/auth/sign-in/email, /sign-up/email,
// /sign-out, GET /api/auth/get-session, …) is served from here. This is the
// official Next.js App Router mounting pattern: toNextJsHandler turns the
// auth instance into `{ GET, POST }` route handlers.
//
// The route is public by definition (it IS the auth endpoint); proxy.ts
// excludes /api from protection and better-auth's own CSRF + origin checks
// gate the writes. App data routes still require the session cookie.

import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
