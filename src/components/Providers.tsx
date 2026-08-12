"use client";

import { ToastProvider } from "@/components/Toast";
import BottomNav from "@/components/BottomNav";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      {children}
      <BottomNav />
      <ServiceWorkerRegister />
    </ToastProvider>
  );
}