"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import EmptyState from "@/components/EmptyState";
import { useToast } from "@/components/Toast";
import { Loader2, Check, CalendarDays, Sprout, Camera } from "lucide-react";

// Field crew's own route. Lists lawn_visits where crew_id = the signed-in crew
// member (crew / superintendent), grouped Overdue / Today / Upcoming. Crew can
// mark a visit done inline (direct update via RLS — the /status API is
// office-only and would 403 for crew; crew done does NOT auto-email the
// customer, office reviews completed visits). Tapping a card opens the visit
// page for before/after photos + details (opened to crew for their own visits).

type Visit = {
  id: string;
  job_id: string;
  due_date: string;
  status: string;
  route_order: number | null;
  // customers reached through jobs (lawn_visits has job_id, no customer_id).
  jobs: {
    name: string;
    address: string | null;
    customers: { name: string | null } | null;
  } | null;
};

const STATUS_CHIP: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  done: "bg-green-100 text-green-800",
  skipped: "bg-gray-100 text-gray-500",
  paused: "bg-blue-100 text-blue-700",
};

function dueLabel(due: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (due < today) return "Overdue";
  if (due === today) return "Today";
  const t = new Date(`${due}T00:00:00.000Z`);
  return t.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function VisitCard({
  v,
  busyId,
  onDone,
}: {
  v: Visit;
  busyId: string | null;
  onDone: (id: string) => void;
}) {
  const jobName = v.jobs?.name ?? "—";
  const custName = v.jobs?.customers?.name ?? null;
  const address = v.jobs?.address ?? null;
  return (
    <div className="bg-white rounded-lg p-3 shadow-sm space-y-2">
      <div className="flex justify-between items-start gap-2">
        <Link href={`/lawn/visits/${v.id}`} className="min-w-0 flex-1 active:opacity-70">
          <p className="font-semibold text-gray-900 truncate">{jobName}</p>
          <p className="text-xs text-gray-500 truncate">
            {custName ? `${custName} · ` : ""}
            {address ?? "—"}
          </p>
        </Link>
        <span
          className={`text-[10px] font-semibold px-2 py-1 rounded whitespace-nowrap ${
            STATUS_CHIP[v.status] ?? "bg-gray-100 text-gray-600"
          }`}
        >
          {dueLabel(v.due_date)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onDone(v.id)}
          disabled={busyId === v.id}
          className="flex-1 bg-green-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {busyId === v.id ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          Mark done
        </button>
        <Link
          href={`/lawn/visits/${v.id}`}
          className="bg-white border border-gray-300 text-gray-900 py-2 px-3 rounded-lg font-semibold text-sm active:bg-gray-50 flex items-center justify-center gap-1.5"
        >
          <Camera className="w-4 h-4" />
          Photos
        </Link>
      </div>
    </div>
  );
}

function Section({
  label,
  list,
  icon,
  busyId,
  onDone,
}: {
  label: string;
  list: Visit[];
  icon: React.ReactNode;
  busyId: string | null;
  onDone: (id: string) => void;
}) {
  if (list.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide flex items-center gap-1">
        {icon}
        {label} ({list.length})
      </h2>
      <div className="space-y-2">
        {list.map((v) => (
          <VisitCard key={v.id} v={v} busyId={busyId} onDone={onDone} />
        ))}
      </div>
    </section>
  );
}

export default function MyRoutePage() {
  const router = useRouter();
  const toast = useToast();
  const [visits, setVisits] = useState<Visit[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
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
      if (role !== "crew" && role !== "superintendent") {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);

      // My pending visits due within the next 14 days (RLS crew-read keyed on
      // crew_id = auth.uid() admits exactly my rows).
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + 14);
      const horizonDate = horizon.toISOString().slice(0, 10);
      const { data: rows } = await supabase
        .from("lawn_visits")
        .select("id, job_id, due_date, status, route_order, jobs(name, address, customers(name))")
        .eq("crew_id", user.id)
        .eq("status", "pending")
        .lte("due_date", horizonDate)
        .order("due_date", { ascending: true })
        .order("route_order", { ascending: true, nullsFirst: false });
      setVisits((rows as unknown as Visit[]) ?? []);
    })();
  }, [router]);

  async function markDone(visitId: string) {
    setBusyId(visitId);
    const supabase = createClient();
    const { error } = await supabase
      .from("lawn_visits")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", visitId);
    setBusyId(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setVisits((prev) => prev.filter((v) => v.id !== visitId));
    toast.success("Marked done");
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const overdue = visits.filter((v) => v.due_date < today);
  const todays = visits.filter((v) => v.due_date === today);
  const upcoming = visits.filter((v) => v.due_date > today);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="My Route" subtitle="Your assigned lawn visits" />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-6">
        {visits.length === 0 ? (
          <div className="bg-white rounded-lg">
            <EmptyState
              icon={Sprout}
              title="No visits assigned to you"
              description="Lawn visits the office assigns to you will show up here, grouped by day."
            />
          </div>
        ) : (
          <>
            <Section
              label="Overdue"
              list={overdue}
              icon={<CalendarDays className="w-3.5 h-3.5" />}
              busyId={busyId}
              onDone={markDone}
            />
            <Section
              label="Today"
              list={todays}
              icon={<CalendarDays className="w-3.5 h-3.5" />}
              busyId={busyId}
              onDone={markDone}
            />
            <Section
              label="Upcoming"
              list={upcoming}
              icon={<CalendarDays className="w-3.5 h-3.5" />}
              busyId={busyId}
              onDone={markDone}
            />
          </>
        )}
      </main>
    </div>
  );
}