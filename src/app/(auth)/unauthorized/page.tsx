import type { Metadata } from "next";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Akses Ditolak — CreaInvoice",
};

export default function UnauthorizedPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Akses ditolak</CardTitle>
        <CardDescription>403 — Halaman ini tidak bisa dibuka.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Akun Anda tidak memiliki akses ke halaman ini. Setiap pengguna
          adalah admin penuh dari workspace organisasinya sendiri — jika
          halaman ini milik organisasi lain, pilih organisasi Anda di
          pengalih workspace.
        </p>
        <Button render={<Link href="/dashboard">Kembali ke dashboard</Link>} variant="outline" />
      </CardContent>
    </Card>
  );
}
