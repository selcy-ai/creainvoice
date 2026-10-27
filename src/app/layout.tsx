import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { CookieConsentBanner } from "@/components/layout/cookie-consent";
import { Toaster } from "@/components/ui/toast";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "CreaInvoice — Platform Invoice",
  description: "Buat, kelola, dan ekspor invoice profesional untuk bisnis Anda.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorBackground: "transparent",
        },
        elements: {
          // Follow the app shell (v4 Bento Kausal tokens): the Clerk cards
          // inherit the page background and radius instead of Clerk's
          // default white/purple.
          rootBox: "bg-transparent",
          card: "bg-card text-foreground rounded-xl shadow-none border border-border",
          headerTitle: "text-foreground",
          headerSubtitle: "text-muted-foreground",
          primaryButton:
            "bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg",
          formButtonPrimary:
            "bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg",
          footerActionLink: "text-primary",
        },
      }}
    >
      <html
        lang="id"
        className={inter.variable}
        suppressHydrationWarning
      >
        <body className="min-h-screen bg-background text-foreground antialiased">
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            {children}
            <Toaster />
            <CookieConsentBanner />
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
