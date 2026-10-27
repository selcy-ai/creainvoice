// src/app/privacy/page.tsx
// Public privacy policy (feature 11C, security-standards §Compliance):
// reachable WITHOUT a session — /privacy and /terms are in the proxy's
// PUBLIC_PATHS so anonymous visitors on the login page can read them.
// Content follows UU PDP (data types, contract basis, retention, rights),
// never lorem ipsum.

import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Kebijakan Privasi — creainvoice",
  description:
    "Kebijakan privasi creainvoice sesuai UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi.",
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

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-12">
        <header className="flex flex-col gap-2">
          <Link href="/login" className="text-sm text-muted-foreground hover:underline">
            ← Kembali ke halaman masuk
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Kebijakan Privasi</h1>
          <p className="text-sm text-muted-foreground">
            Berlaku untuk penggunaan creainvoice. Terakhir diperbarui: 10 Oktober 2026.
          </p>
        </header>

        <Card>
          <CardContent className="flex flex-col gap-6 py-6">
            <Section title="Tentang creainvoice">
              creainvoice adalah platform invoice <strong>self-hosted</strong>. Aplikasi ini
              dijalankan di infrastruktur yang Anda (atau organisasi Anda) miliki dan kendalikan.
              Data Anda tidak dikirim ke server pihak ketiga untuk pemrosesan bisnis.
            </Section>

            <Section title="Data pribadi yang diproses">
              Sesuai UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP), kami
              memproses data pribadi berikut sebatas kebutuhan penerbitan invoice:
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Data akun: nama pengguna, email, nama, dan kata sandi (disimpan ter-hash).</li>
                <li>
                  Data profil perusahaan dan penanda tangan: nama, alamat, nomor telepon/
                  WhatsApp, fax, email, website, NPWP, dan gambar tanda tangan.
                </li>
                <li>
                  Data customer dan PIC: nama perusahaan, alamat, kontak, dan NPWP — termasuk
                  data pribadi PIC yang tercantum pada invoice.
                </li>
                <li>Data transaksi: nomor invoice, item pekerjaan, nilai tagihan, dan pembayaran.</li>
                <li>Data teknis: nomor rekening bank (disimpan terenkripsi) dan log audit aksi.</li>
              </ul>
            </Section>

            <Section title="Dasar pemrosesan">
              Dasar pemrosesan data pribadi adalah <strong>pelaksanaan kontrak</strong> — yaitu
              hubungan kerja atau kerja sama yang menjadi dasar penerbitan invoice antara Anda dan
              pihak yang ditagih. Kami tidak menggunakan data pribadi untuk tujuan pemasaran tanpa
              persetujuan terpisah.
            </Section>

            <Section title="Retensi data">
              Data disimpan selama akun dan organisasi aktif di instance ini. Dokumen invoice dan
              data terkait tagihan dapat disimpan selama masa yang diatur kontrak dan aturan
              perpajakan yang berlaku (umumnya 10 tahun untuk dokumen terkait pajak). Anda dapat
              meminta penghapusan data sesuai hak Anda di bawah.
            </Section>

            <Section title="Keamanan data">
              <ul className="list-disc space-y-1 pl-5">
                <li>Kata sandi disimpan dalam bentuk ter-hash (tidak pernah plaintext).</li>
                <li>Nomor rekening bank dienkripsi saat disimpan (AES-256-GCM).</li>
                <li>Akses antar-organisasi dibatasi secara ketat (org isolation).</li>
                <li>
                  Sebagian besar akses sensitif tercatat di log audit untuk akuntabilitas.
                </li>
              </ul>
            </Section>

            <Section title="Hak Anda sebagai pemilik data">
              Sesuai UU PDP, Anda berhak memperoleh informasi tentang pemrosesan data Anda,
              memperbaui data yang keliru, dan meminta penghapusan data. Karena creainvoice
              self-hosted, permintaan tersebut ditujukan kepada administrator instance Anda
              (super admin) yang mengelola data di server ini.
            </Section>

            <Section title="Transfer ke pihak ketiga">
              Kami tidak menjual atau mentransfer data pribadi ke pihak ketiga untuk tujuan
              komersial. Karena instance ini self-hosted di infrastruktur Anda sendiri, data tidak
              dipindahkan ke wilayah hukum lain secara default.
            </Section>

            <Section title="Cookie">
              Aplikasi ini memakai cookie sesi yang bersifat esensial untuk menjaga Anda tetap
              masuk. Saat ini tidak ada cookie analitik pihak ketiga yang aktif. Lihat{" "}
              <Link href="/terms" className="underline">
                Syarat &amp; Ketentuan
              </Link>{" "}
              untuk detail lebih lanjut.
            </Section>

            <Section title="Kontak">
              Untuk pertanyaan tentang privasi atau permintaan terkait data pribadi, hubungi
              administrator instance creainvoice Anda.
            </Section>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}