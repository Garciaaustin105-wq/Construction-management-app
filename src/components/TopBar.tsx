"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function TopBar({
  title,
  subtitle,
  showSignOut = true,
}: {
  title: string;
  subtitle?: string;
  showSignOut?: boolean;
}) {
  const router = useRouter();
  const supabase = createClient();

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-gray-900 truncate">{title}</h1>
        {subtitle && (
          <p className="text-xs text-gray-500 truncate">{subtitle}</p>
        )}
      </div>
      {showSignOut && (
        <button
          onClick={handleSignOut}
          className="text-xs text-gray-600 px-3 py-2 rounded hover:bg-gray-100 flex items-center gap-1"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      )}
    </header>
  );
}