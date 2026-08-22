"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import { isOfficeLike } from "@/lib/roles";

type Row = {
  id: string;
  title: string;
  location: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  jobs: { name: string } | null;
};

export default function CrewPunchPage() {
  const router = useRouter();
  const [items, setItems] = useState<Row[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const supabaseMod = await import("@/lib/supabase/client");
      const supabase = supabaseMod.createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      const role = profile?.role ?? "crew";
      if (role === "customer") {
        router.push("/dashboard");
        return;
      }
      let q = supabase
        .from("punch_items")
        .select("id, title, location, status, priority, due_date, jobs(name)")
        .order("due_date", { ascending: true });
      // Office-like see every item; crew/superintendent see only theirs.
      if (!isOfficeLike(role)) q = q.eq("assigned_to", user.id);
      const { data } = await q;
      setItems((data ?? []) as unknown as Row[]);
      setLoaded(true);
    })();
  }, [router]);

  async function advance(r: Row) {
    const next =
      r.status === "open" ? "in_progress" : r.status === "in_progress" ? "complete" : "open";
    setBusyId(r.id);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("punch_items")
      .update({
        status: next,
        updated_at: new Date().toISOString(),
        completed_at: next === "complete" ? new Date().toISOString() : null,
        completed_by: next === "complete" ? user?.id ?? null : null,
      })
      .eq("id", r.id);
    setBusyId(null);
    if (error) return;
    setItems((prev) =>
      prev.map((x) =>
        x.id === r.id
          ? {
              ...x,
              status: next,
            }
          : x
      )
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push("/field")}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">Back to field</span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 max-w-[50%] truncate">
          My Punch List
        </h1>
        <div className="w-16" />
      </header>
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        {!loaded ? (
          <p className="text-center text-sm text-gray-400 py-10">Loading...</p>
        ) : items.length === 0 ? (
          <div className="bg-white rounded-lg">
            <EmptyState
              icon={EmptyIcons.Briefcase}
              title="No items assigned to you"
              description="Punch items assigned to you will appear here with a one-tap status button."
            />
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((r) => (
              <div
                key={r.id}
                className="bg-white rounded-lg p-3 shadow-sm"
              >
                <p className="font-semibold text-gray-900 truncate">{r.title}</p>
                <p className="text-xs text-gray-500 truncate">
                  {r.jobs?.name ?? "—"}
                  {r.location ? ` · ${r.location}` : ""}
                  {r.due_date ? ` · due ${new Date(r.due_date).toLocaleDateString()}` : ""}
                </p>
                <div className="flex items-center justify-between mt-2 gap-2">
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                    {r.priority}
                  </span>
                  <button
                    onClick={() => advance(r)}
                    disabled={busyId === r.id}
                    className="bg-blue-600 text-white px-3 py-1.5 rounded-lg font-semibold text-xs active:bg-blue-700 disabled:opacity-50"
                  >
                    {r.status === "open"
                      ? "Start"
                      : r.status === "in_progress"
                      ? "Complete"
                      : "Reopen"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}