"use client";

// src/components/onboarding/wizard.tsx
// Orchestrates the 12 onboarding steps: progress header, step routing, and a
// local Back button. Data persists server-side per step (server actions
// advance user.onboardingStep), so closing the tab mid-wizard resumes from
// the last completed step — no localStorage involved.

import * as React from "react";
import { WizardProvider, useWizard } from "@/components/onboarding/context";
import type {
  WizardProviderProps,
} from "@/components/onboarding/context";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Step1Workspace } from "@/components/onboarding/steps/step-01-workspace";
import { Step2Company } from "@/components/onboarding/steps/step-02-company";
import { Step3Logo } from "@/components/onboarding/steps/step-03-logo";
import { Step4Color } from "@/components/onboarding/steps/step-04-color";
import { Step5Contact } from "@/components/onboarding/steps/step-05-contact";
import { Step6Bank } from "@/components/onboarding/steps/step-06-bank";
import { Step7Signer } from "@/components/onboarding/steps/step-07-signer";
import { Step8Identity } from "@/components/onboarding/steps/step-08-identity";
import { Step9Numbering } from "@/components/onboarding/steps/step-09-numbering";
import { Step10Stamp } from "@/components/onboarding/steps/step-10-stamp";
import { Step11Preview } from "@/components/onboarding/steps/step-11-preview";
import { Step12Finish } from "@/components/onboarding/steps/step-12-finish";

const STEP_META: Record<number, { title: string; description: string }> = {
  1: { title: "Organisasi", description: "Buat workspace baru atau pilih yang sudah Anda ikuti." },
  2: { title: "Profil perusahaan", description: "Data legal yang tampil di setiap invoice." },
  3: { title: "Logo perusahaan", description: "Unggah logo (PNG, JPEG, atau WebP, maksimal 2 MB)." },
  4: { title: "Warna utama", description: "Warna aksen header invoice — terlihat langsung di pratinjau." },
  5: { title: "Kontak", description: "Kanal yang bisa dihubungi pelanggan dari invoice." },
  6: { title: "Rekening bank", description: "Tujuan pembayaran. Nomor rekening disimpan terenkripsi." },
  7: { title: "Penanda tangan", description: "Orang yang menandatangani invoice Anda." },
  8: { title: "Profil invoice", description: "Nama profil dan kode singkat untuk nomor invoice." },
  9: { title: "Pola nomor invoice", description: "Format nomor dengan pratinjau langsung." },
  10: { title: "Preferensi meterai", description: "Cara CreaInvoicenampilkan area meterai." },
  11: { title: "Preview invoice", description: "Contoh invoice dengan data yang baru Anda isi." },
  12: { title: "Selesai", description: "Tinjau ringkasan dan akhiri onboarding." },
};

function ActiveStep() {
  const { step } = useWizard();
  switch (step) {
    case 1:
      return <Step1Workspace />;
    case 2:
      return <Step2Company />;
    case 3:
      return <Step3Logo />;
    case 4:
      return <Step4Color />;
    case 5:
      return <Step5Contact />;
    case 6:
      return <Step6Bank />;
    case 7:
      return <Step7Signer />;
    case 8:
      return <Step8Identity />;
    case 9:
      return <Step9Numbering />;
    case 10:
      return <Step10Stamp />;
    case 11:
      return <Step11Preview />;
    default:
      return <Step12Finish />;
  }
}

function WizardShell() {
  const { step, resumeStep, goTo } = useWizard();
  const meta = STEP_META[step] ?? STEP_META[1];
  const resumed = resumeStep > 1 && step === resumeStep;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-primary">creainvoice</p>
        <h1 className="text-2xl font-semibold tracking-tight">{meta.title}</h1>
        <p className="text-sm text-muted-foreground">{meta.description}</p>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">Langkah {step} dari 12</span>
          <span className="tabular-nums text-muted-foreground">{Math.round((step / 12) * 100)}%</span>
        </div>
        <Progress value={(step / 12) * 100} aria-label={`Kemajuan onboarding: langkah ${step} dari 12`} />
        {resumed ? (
          <p className="text-xs text-muted-foreground">
            Melanjutkan dari langkah terakhir yang Anda isi.
          </p>
        ) : null}
      </div>

      <div key={step}>
        <ActiveStep />
      </div>

      <div className="flex items-center justify-between gap-3">
        {step > 1 ? (
          <Button type="button" variant="outline" onClick={() => goTo(step - 1)}>
            Kembali
          </Button>
        ) : (
          <span />
        )}
        <p className="text-right text-xs text-muted-foreground">
          Progres tersimpan otomatis — Anda bisa menutup halaman dan lanjut nanti.
        </p>
      </div>
    </div>
  );
}

export type OnboardingWizardProps = Omit<WizardProviderProps, "children">;

export function OnboardingWizard(props: OnboardingWizardProps) {
  return (
    <WizardProvider {...props}>
      <WizardShell />
    </WizardProvider>
  );
}
