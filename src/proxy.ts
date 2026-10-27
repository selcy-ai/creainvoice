// src/proxy.ts — route protection (Change 6: Clerk).
//
// Next 16 renamed the middleware convention to proxy.ts — same contract, see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
//
// clerkMiddleware() authenticates the request and makes auth() work in the
// render tree. By default every route is public in Clerk's middleware model;
// the redirect logic lives in the layouts/pages (auth() + redirect), because
// a compromised process must not mean a bypass.
//
// The Clerk webhook route (/api/clerk/webhook) authenticates with its own
// Svix signing secret, so it never touches this layer.

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Pages reachable WITHOUT a Clerk session: the Clerk sign-in page and the
// legal pages (security-standards: /privacy and /terms must be public).
const isPublicRoute = createRouteMatcher([
  "/login(.*)",
  "/privacy(.*)",
  "/terms(.*)",
]);

export default clerkMiddleware(
  async (auth, request) => {
    if (request.nextUrl.pathname.startsWith("/print")) return;
    if (isPublicRoute(request)) return;
    // Protected pages redirect to the sign-in page; the render tree performs
    // the same check with auth() (defense in depth).
    const { userId, redirectToSignIn } = await auth();
    if (!userId) {
      await redirectToSignIn();
    }
  },
  {
    // Signed-out users hitting a protected page are sent here. Clerk's
    // <SignIn /> lives at /login.
    signInUrl: "/login",
  },
);

export const config = {
  // Excludes: API routes (their own auth: Clerk webhook signature or the
  // signed print token), static assets, health endpoint, and the internal
  // print route (feature 06).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|health|robots.txt|print).*)"],
};
