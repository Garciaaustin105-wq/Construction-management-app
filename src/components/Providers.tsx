"use client";

import { usePathname } from "next/navigation";
import { ToastProvider } from "@/components/Toast";
import BottomNav from "@/components/BottomNav";
import Sidebar from "@/components/Sidebar";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import { isPublicRoute } from "@/lib/navItems";

export default function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // On public/portal routes there is no sidebar, so the content must not be
  // offset (otherwise /login would shift right with an empty 256px gap). The
  // offset equals the sidebar's fixed width (lg:pl-64 = w-64 = 16rem).
  const showChrome = !isPublicRoute(pathname ?? "/");
  return (
    <ToastProvider>
      <Sidebar />
      <div className={showChrome ? "lg:pl-64" : undefined}>{children}</div>
      <BottomNav />
      <ServiceWorkerRegister />
    </ToastProvider>
  );
}