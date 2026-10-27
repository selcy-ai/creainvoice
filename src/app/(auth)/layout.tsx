import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Masuk — CreaInvoice",
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <span className="text-xl font-semibold tracking-tight text-foreground">
            CreaInvoice
          </span>
          <p className="text-sm text-muted-foreground">
            Platform invoice untuk bisnis Anda.
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
