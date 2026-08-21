"use client";

import { usePathname } from "next/navigation";
import { ToastProvider } from "@/components/Toast";
import BottomNav from "@/components/BottomNav";
import Sidebar from "@/components/Sidebar";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import { isPublicRoute } from "@/lib/navItems";
import { RoleSeedProvider } from "@/lib/useRole";
import type { Role } from "@/lib/roles";

export default function Providers({
  children,
  initialRole,
}: {
  children: React.ReactNode;
  // Server-seeded profile role (read in the root layout) so the chrome paints
  // with the real role on its first client frame — no cold-load nav flash.
  // Falls back to null when the layout couldn't read it (logged-out / error).
  initialRole: Role | null;
}) {
  const pathname = usePathname();
  // On public/portal routes there is no sidebar, so the content must not be
  // offset (otherwise /login would shift right with an empty 256px gap). The
  // offset equals the sidebar's fixed width (lg:pl-64 = w-64 = 16rem).
  const showChrome = !isPublicRoute(pathname ?? "/");
  return (
    <RoleSeedProvider value={initialRole}>
      <ToastProvider>
        <Sidebar />
        <div className={showChrome ? "lg:pl-64" : undefined}>{children}</div>
        <BottomNav />
        <ServiceWorkerRegister />
      </ToastProvider>
    </RoleSeedProvider>
  );
}