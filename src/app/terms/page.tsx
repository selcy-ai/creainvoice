// src/app/terms/page.tsx
// Public terms (feature 11C, security-standards §Compliance): reachable
// WITHOUT a session — /privacy and /terms are in the proxy's PUBLIC_PATHS.
// Content follows UU PDP + self-hosted scope (not a payment gateway, not a
// bank, essential-session cookies only, analytics deferred per Scope Limits).

import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Syarat & Ketentuan — creainvoice",
  description:
    "Syarat dan ketentuan penggunaan creainvoice, termasuk ketentuan cookie dan batasan tanggung jawab.",
  robots: { index: true, follow: true },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-12">
        <header className="flex flex-col gap-2">
          <Link href="/login" className="text-sm text-muted-foreground hover:underline">
            ← Kembali ke halaman masuk
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Syarat &amp; Ketentuan</h1>
          <p className="text-sm text-muted-foreground">
            Berlaku untuk penggunaan creainvoice. Terakhir diperbarui: 10 Oktober 2026.
          </p>
        </header>

        <Card>
          <CardContent className="flex flex-col gap-6 py-6">
            <Section title="Penerimaan syarat">
              Dengan mengakses dan menggunakan creainvoice, Anda menyetujui syarat dan ketentuan
              ini. Jika Anda menggunakan aplikasi ini atas nama organisasi, Anda menyatakan
              berwenang untuk mengikat organisasi tersebut.
            </Section>

            <Section title="Sifat layanan">
              creainvoice adalah alat pembuatan dan pengelolaan invoice yang di-hosting sendiri
              (self-hosted). Aplikasi ini <strong>bukan</strong> penyedia layanan pembayaran, bukan
              bank, dan bukan penyedia jasa akuntansi. Status pembayaran yang tercatat di aplikasi
              bersifat catatan (rekaman), bukan konfirmasi transfer dana dari bank.
            </Section>

            <Section title="Akun dan keamanan">
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Akun dibuat oleh administrator platform; tidak ada pendaftaran mandiri yang
                  terbuka untuk publik.
                </li>
                <li>
                  Anda bertanggung jawab menjaga kerahasiaan kata sandi dan segera melaporkan
                  penggunaan yang tidak sah kepada administrator Anda.
                </li>
                <li>
                  Beberapa akses Anda dapat dicatat dalam log audit untuk keamanan dan
                  akuntabilitas.
                </li>
              </ul>
            </Section>

            <Section title="Cookie">
              Aplikasi ini menggunakan cookie sesi yang <strong>esensial</strong> — diperlukan agar
              Anda tetap masuk dan agar fitur autentikasi berfungsi. Saat ini tidak ada cookie
              analitik pihak ketiga yang aktif di instance ini. Jika analitik diaktifkan di masa
              depan, persetujuan Anda akan diminta lebih dahulu.
            </Section>

            <Section title="Data dan kepatuhan">
              Pemrosesan data pribadi tunduk pada UU No. 27 Tahun 2022 (UU PDP). Rincian jenis data,
              dasar pemrosesan, retensi, dan hak Anda tersedia di{" "}
              <Link href="/privacy" className="underline">
                Kebijakan Privasi
              </Link>
              .
            </Section>

            <Section title="Batasan tanggung jawab">
              Sejauh diizinkan hukum yang berlaku, pengguna bertanggung jawab atas kebenaran data
              yang dimasukkan (termasuk nomor invoice, nilai tagihan, dan data customer) dan atas
              pengelolaan instance self-hosted-nya sendiri, termasuk backup dan keamanan akses.
            </Section>

            <Section title="Perubahan syarat">
              Syarat ini dapat diperbarui sewaktu-waktu. Tanggal pembaruan tercantum di bagian atas
              halaman ini. Penggunaan lanjutan setelah perubahan berarti Anda menerima versi terbaru.
            </Section>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}