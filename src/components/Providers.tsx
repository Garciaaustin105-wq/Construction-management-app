"use client";

import { ToastProvider } from "@/components/Toast";
import BottomNav from "@/components/BottomNav";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      {children}
      <BottomNav />
    </ToastProvider>
  );
}