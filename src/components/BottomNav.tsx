"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Home,
  Camera,
  Users,
  LogOut,
  Receipt,
  Clock,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useUnreadCount } from "@/lib/useUnreadCount";

export default function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [role, setRole] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const unread = useUnreadCount();

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      setRole(data?.role ?? null);
    })();
  }, [supabase]);

  // Auto-hide on scroll down, reveal on scroll up (Facebook-style).
  useEffect(() => {
    let lastY = window.scrollY;
    function onScroll() {
      const y = window.scrollY;
      if (y <= 8) {
        setHidden(false);
      } else if (y > lastY + 4) {
        setHidden(true);
      } else if (y < lastY - 4) {
        setHidden(false);
      }
      lastY = y;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const items = [
    { href: "/dashboard", label: "Home", Icon: Home },
    { href: "/crew/photo", label: "Photo", Icon: Camera },
    { href: "/crew/time", label: "Time", Icon: Clock },
  ];
  if (role === "office") {
    items.push({ href: "/receipts", label: "Receipts", Icon: Receipt });
    items.push({ href: "/admin/users", label: "Admin", Icon: Users });
  }

  // The bottom nav is persistent (rendered from the root layout) but should
  // not appear on public/portal routes that have their own chrome.
  if (pathname === "/" || pathname === "/login" || pathname === "/customer") {
    return null;
  }

  return (
    <nav
      className={`fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50 transition-transform duration-200 ${
        hidden ? "translate-y-full" : "translate-y-0"
      }`}
    >
      <div className="max-w-md mx-auto flex">
        {items.map(({ href, label, Icon }) => {
          const active = pathname === href;
          const showBadge = href === "/dashboard" && unread > 0;
          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 flex flex-col items-center justify-center py-3 text-xs relative ${
                active ? "text-blue-600" : "text-gray-600"
              }`}
            >
              <Icon
                className={`w-6 h-6 mb-0.5 ${active ? "stroke-[2.5]" : ""}`}
                strokeWidth={active ? 2.5 : 2}
              />
              <span className={active ? "font-semibold" : ""}>{label}</span>
              {showBadge && (
                <span className="absolute top-1 right-3 bg-red-600 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </Link>
          );
        })}
        <button
          onClick={handleSignOut}
          className="flex-1 flex flex-col items-center justify-center py-3 text-xs text-gray-600"
        >
          <LogOut className="w-6 h-6 mb-0.5" />
          <span>Sign Out</span>
        </button>
      </div>
    </nav>
  );
}