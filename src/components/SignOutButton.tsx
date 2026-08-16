"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LogOut } from "lucide-react";

export default function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const supabase = createClient();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <button
      onClick={handleSignOut}
      className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold text-red-600 bg-red-50 hover:bg-red-100 active:bg-red-200 ${className ?? ""}`}
    >
      <LogOut className="w-5 h-5" />
      <span>Sign Out</span>
    </button>
  );
}