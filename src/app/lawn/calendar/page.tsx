import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import { headers } from "next/headers";
import LawnCalendarBoard, {
  type BoardVisit,
  type BoardCrew,
} from "@/components/LawnCalendarBoard";
import CalendarFeedCard from "@/app/calendar/CalendarFeedCard";
import { startOfWeek, addDays, toISODate } from "@/lib/weekUtils";
import { OFFICE_LIKE } from "@/lib/roles";

type CalVisit = {
  id: string;
  due_date: string;
  status: string;
  crew_id: string | null;
  recurring_schedule_id: string;
  recurring_schedules: { service_type: string | null } | null;
  jobs: { name: string | null } | null;
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseMonth(s: string | undefined) {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-based
  if (s) {
    const [yStr, mStr] = s.split("-");
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10);
    if (!isNaN(y) && !isNaN(m) && m >= 1 && m <= 12) {
      year = y;
      month = m - 1;
    }
  }
  const iso = `${year}-${String(month + 1).padStart(2, "0")}`;
  return { year, month, iso };
}

function shiftMonth(year: number, month: number, delta: number) {
  const d = new Date(year, month + delta, 1);
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

export default async function LawnCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; month?: string; date?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role;
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const view = sp.view === "week" || sp.view === "agenda" ? sp.view : "month";

  const todayIso = new Date().toISOString().slice(0, 10);

  // Fetch visits and crews
  let gte: string;
  let lte: string;

  if (view === "month") {
    const { year, month, iso } = parseMonth(sp.month);
    const monthStart = `${iso}-01`;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthEnd = `${iso}-${String(daysInMonth).padStart(2, "0")}`;
    gte = monthStart;
    lte = monthEnd;
  } else if (view === "week") {
    let anchorDate: Date;
    if (sp.date) {
      const d = new Date(`${sp.date}T00:00:00`);
      if (!isNaN(d.getTime())) {
        anchorDate = d;
      } else {
        anchorDate = new Date();
      }
    } else {
      anchorDate = new Date();
    }
    const weekStart = startOfWeek(anchorDate);
    const weekEnd = addDays(weekStart, 6);
    gte = toISODate(weekStart);
    lte = toISODate(weekEnd);
  } else {
    gte = todayIso;
    lte = toISODate(addDays(new Date(), 30));
  }

  const [{ data: visitRows }, { data: crewRows }] = await Promise.all([
    supabase
      .from("lawn_visits")
      .select(
        "id, due_date, status, crew_id, recurring_schedule_id, recurring_schedules(service_type), jobs(name)",
      )
      .gte("due_date", gte)
      .lte("due_date", lte)
      .order("due_date", { ascending: true }),
    supabase
      .from("crew_members")
      .select("id, name, working_days, max_visits_per_day")
      .order("name"),
  ]);

  const boardVisits: BoardVisit[] =
    (visitRows as unknown as CalVisit[] | null ?? []).map((v) => ({
      id: v.id,
      due_date: v.due_date,
      status: v.status as BoardVisit["status"],
      crew_id: v.crew_id,
      recurring_schedule_id: v.recurring_schedule_id,
      job_name: v.jobs?.name ?? "Untitled",
      service_type: v.recurring_schedules?.service_type ?? null,
    }));

  const boardCrews: BoardCrew[] =
    (
      crewRows as
        | { id: string; name: string; working_days: number[] | null; max_visits_per_day: number | null }[]
        | null
      ?? []
    ).map((c) => ({
      id: c.id,
      name: c.name?.trim() ?? "Crew",
      working_days: c.working_days,
      max_visits_per_day: c.max_visits_per_day,
    }));

  const serviceTypes = Array.from(
    new Set(
      boardVisits
        .map((v) => v.service_type)
        .filter((s): s is string => !!s),
    ),
  ).sort();

  // Build month view props if applicable
  let monthProps: {
    monthLabel: string;
    cells: (string | null)[];
    prevHref: string;
    nextHref: string;
    todayHref: string;
    isCurrentMonth: boolean;
  } | undefined = undefined;

  if (view === "month") {
    const { year, month, iso } = parseMonth(sp.month);
    const firstWeekday = new Date(year, month, 1).getDay(); // Sunday = 0
    const leading = firstWeekday === 0 ? 6 : firstWeekday - 1;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells: (string | null)[] = [];
    for (let i = 0; i < leading; i++) {
      cells.push(null);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(`${iso}-${String(d).padStart(2, "0")}`);
    }

    monthProps = {
      monthLabel: `${MONTH_NAMES[month]} ${year}`,
      cells,
      prevHref: `/lawn/calendar?view=month&month=${shiftMonth(
        year,
        month,
        -1,
      )}`,
      nextHref: `/lawn/calendar?view=month&month=${shiftMonth(
        year,
        month,
        1,
      )}`,
      todayHref: `/lawn/calendar?view=month`,
      isCurrentMonth: iso === todayIso.slice(0, 7),
    };
  }

  // Build week view props if applicable
  let weekProps:
    | {
        days: string[];
        prevHref: string;
        nextHref: string;
        todayHref: string;
      }
    | undefined = undefined;

  if (view === "week") {
    let anchorDate: Date;
    if (sp.date) {
      const d = new Date(`${sp.date}T00:00:00`);
      if (!isNaN(d.getTime())) {
        anchorDate = d;
      } else {
        anchorDate = new Date();
      }
    } else {
      anchorDate = new Date();
    }
    const weekStart = startOfWeek(anchorDate);

    weekProps = {
      days: Array.from({ length: 7 }, (_, i) =>
        toISODate(addDays(weekStart, i)),
      ),
      prevHref: `/lawn/calendar?view=week&date=${toISODate(addDays(
        weekStart,
        -7,
      ))}`,
      nextHref: `/lawn/calendar?view=week&date=${toISODate(addDays(
        weekStart,
        7,
      ))}`,
      todayHref: `/lawn/calendar?view=week`,
    };
  }

  // Fetch calendar feed for sync card
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost";
  const scheme = host.startsWith("localhost") ? "http" : "https";
  const origin = `${scheme}://${host}`;

  const { data: feed } = await supabase
    .from("calendar_feeds")
    .select("token, last_fetched_at")
    .eq("user_id", me.user.id)
    .maybeSingle();

  const initialUrl = feed?.token
    ? `${origin}/api/calendar/feed?token=${feed.token}`
    : null;

  return (
    <PageContainer
      title="Lawn Calendar"
      subtitle="Monthly crew routes"
      backHref="/lawn"
      backLabel="Lawn"
      maxWidth="full"
    >
      <LawnCalendarBoard
        view={view}
        todayIso={todayIso}
        visits={boardVisits}
        crews={boardCrews}
        serviceTypes={serviceTypes}
        month={view === "month" ? monthProps : undefined}
        week={view === "week" ? weekProps : undefined}
        monthViewHref="/lawn/calendar?view=month"
        weekViewHref="/lawn/calendar?view=week"
        agendaViewHref="/lawn/calendar?view=agenda"
      />

      <section className="space-y-3 pt-2">
        <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide">
          Sync to your phone
        </h2>
        <CalendarFeedCard
          initialUrl={initialUrl}
          role={role}
          lastFetchedAt={feed?.last_fetched_at ?? null}
        />
      </section>
    </PageContainer>
  );
}
