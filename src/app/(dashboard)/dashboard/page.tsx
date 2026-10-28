// src/app/(dashboard)/dashboard/page.tsx
// Dashboard (feature 08): seven summary cards from database aggregates, a
// ringkas 12-month tagihan-vs-pembayaran chart (recharts), and the 5 newest
// activity events. Everything is loaded for the ACTIVE workspace only
// (org isolation) and gated by invoice.view — no scope, no numbers.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActivityTimeline } from "@/components/dashboard/activity-timeline";
import { MonthlyChart } from "@/components/dashboard/monthly-chart";
import { SummaryCards } from "@/components/dashboard/summary-cards";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getDashboardCards,
  getMonthlySeries,
  getRecentActivity,
} from "@/modules/dashboard/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Dashboard — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope) {
    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Ringkasan tagihan dan pembayaran workspace aktif Anda.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Belum ada workspace aktif</CardTitle>
            <CardDescription>
              Pilih atau buat organisasi terlebih dahulu untuk melihat ringkasan
              invoice.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const [cards, series, activity] = await Promise.all([
    getDashboardCards({ scope }),
    getMonthlySeries({ scope }),
    getRecentActivity({ scope }),
  ]);

  const displayName = session?.user?.name ?? session?.user?.username ?? session?.user?.email ?? "Pengguna";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">
          Halo, {displayName}
        </h1>
        <p className="text-sm text-muted-foreground">
          Ringkasan invoice dan pembayaran workspace aktif Anda.
        </p>
      </div>

      <SummaryCards
        cards={cards}
        billedSeries={series.points.map((point) => Number(point.billed))}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2 ring-border shadow-xs">
          <CardHeader>
            <CardTitle>Tagihan vs pembayaran</CardTitle>
            <CardDescription>
              12 bulan terakhir — invoice terbit dibanding pembayaran yang masuk.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {series.empty ? (
              <div
                className="rounded-md border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground"
                data-testid="dashboard-chart-empty"
              >
                Belum ada tagihan atau pembayaran dalam 12 bulan terakhir.
                Grafik muncul begitu ada invoice terbit.
              </div>
            ) : (
              <MonthlyChart points={series.points} />
            )}
          </CardContent>
        </Card>

        <Card className="ring-border shadow-xs">
          <CardHeader>
            <CardTitle>Aktivitas terbaru</CardTitle>
            <CardDescription>5 event terakhir di organisasi ini.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityTimeline items={activity} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
