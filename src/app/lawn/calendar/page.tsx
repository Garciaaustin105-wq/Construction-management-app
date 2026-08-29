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
import { getLawnWeatherBoard } from "@/lib/lawnWeather";

type CalVisit = {
  id: string;
  due_date: string;
  status: string;
  crew_id: string | null;
  recurring_schedule_id: string;
  scheduled_window_start: string | null;
  scheduled_window_end: string | null;
  recurring_schedules: { service_type: string | null } | null;
  jobs: { name: string | null; lawn_jobs: { map_lat: number | null; map_lng: number | null } | null } | null;
};

type ZoneRow = {
  id: string;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_miles: number;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Great-circle distance in miles — used to test a job's pin against each
// zone's center+radius. service_zones/RouteMapPlanner have no zone-matching
// logic anywhere else in the app to reuse (confirmed while planning this
// feature — service_zones was fetched but otherwise unused).
function milesBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// First zone (in the given order) whose circle contains the point, or null.
function zoneFor(lat: number | null, lng: number | null, zones: ZoneRow[]): string | null {
  if (lat === null || lng === null) return null;
  for (const z of zones) {
    if (milesBetween(lat, lng, z.center_lat, z.center_lng) <= Number(z.radius_miles)) {
      return z.id;
    }
  }
  return null;
}

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

  const view =
    sp.view === "week" || sp.view === "day" || sp.view === "agenda" ? sp.view : "month";

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
  } else if (view === "day") {
    const dayIso =
      sp.date && !isNaN(new Date(`${sp.date}T00:00:00`).getTime()) ? sp.date : todayIso;
    gte = dayIso;
    lte = dayIso;
  } else {
    gte = todayIso;
    lte = toISODate(addDays(new Date(), 30));
  }

  const [{ data: visitRows }, { data: crewRows }, { data: zoneRows }] = await Promise.all([
    supabase
      .from("lawn_visits")
      .select(
        "id, due_date, status, crew_id, recurring_schedule_id, scheduled_window_start, scheduled_window_end, recurring_schedules(service_type), jobs(name, lawn_jobs(map_lat, map_lng))",
      )
      .gte("due_date", gte)
      .lte("due_date", lte)
      .order("due_date", { ascending: true }),
    supabase
      .from("crew_members")
      .select("id, name, working_days, max_visits_per_day")
      .order("name"),
    supabase
      .from("service_zones")
      .select("id, name, center_lat, center_lng, radius_miles")
      .eq("active", true)
      .order("name"),
  ]);
  const zones = (zoneRows as unknown as ZoneRow[] | null) ?? [];

  const boardVisits: BoardVisit[] =
    (visitRows as unknown as CalVisit[] | null ?? []).map((v) => ({
      id: v.id,
      due_date: v.due_date,
      status: v.status as BoardVisit["status"],
      crew_id: v.crew_id,
      recurring_schedule_id: v.recurring_schedule_id,
      scheduled_window_start: v.scheduled_window_start,
      scheduled_window_end: v.scheduled_window_end,
      job_name: v.jobs?.name ?? "Untitled",
      service_type: v.recurring_schedules?.service_type ?? null,
      zone_id: zoneFor(
        v.jobs?.lawn_jobs?.map_lat != null ? Number(v.jobs.lawn_jobs.map_lat) : null,
        v.jobs?.lawn_jobs?.map_lng != null ? Number(v.jobs.lawn_jobs.map_lng) : null,
        zones,
      ),
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

  // Build day view props if applicable
  let dayProps:
    | {
        date: string;
        label: string;
        prevHref: string;
        nextHref: string;
        todayHref: string;
        isToday: boolean;
      }
    | undefined = undefined;

  if (view === "day") {
    const dayIso =
      sp.date && !isNaN(new Date(`${sp.date}T00:00:00`).getTime()) ? sp.date : todayIso;
    const d = new Date(`${dayIso}T00:00:00`);
    const label = `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
    dayProps = {
      date: dayIso,
      label,
      prevHref: `/lawn/calendar?view=day&date=${toISODate(addDays(d, -1))}`,
      nextHref: `/lawn/calendar?view=day&date=${toISODate(addDays(d, 1))}`,
      todayHref: `/lawn/calendar?view=day`,
      isToday: dayIso === todayIso,
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

  // Rain-risk overlay — reuses the SAME NWS-backed board already built for
  // /lawn/weather (getLawnWeatherBoard, 30-min cached) rather than a second
  // forecast integration. Its window is 10 days out, so only Month/Week/Day
  // dates inside that range ever show a flag; nothing further out does.
  const weatherBoard = await getLawnWeatherBoard(supabase);
  const rainRiskDates = weatherBoard.days.filter((d) => d.rainRisk).map((d) => d.date);

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
        zones={zones.map((z) => ({ id: z.id, name: z.name }))}
        rainRiskDates={rainRiskDates}
        month={view === "month" ? monthProps : undefined}
        week={view === "week" ? weekProps : undefined}
        day={view === "day" ? dayProps : undefined}
        monthViewHref="/lawn/calendar?view=month"
        weekViewHref="/lawn/calendar?view=week"
        dayViewHref="/lawn/calendar?view=day"
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
