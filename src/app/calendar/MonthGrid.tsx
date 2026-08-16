import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import EmptyState from "@/components/EmptyState";
import type { CalEvent, CalEventType } from "@/lib/calendarEvents";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
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

const TYPE_COLORS: Record<CalEventType, { dot: string; chip: string }> = {
  "job-start": { dot: "bg-blue-500", chip: "bg-blue-50 text-blue-800 border border-blue-200" },
  "job-end": { dot: "bg-blue-500", chip: "bg-blue-50 text-blue-800 border border-blue-200" },
  event: { dot: "bg-purple-500", chip: "bg-purple-50 text-purple-800 border border-purple-200" },
  sub: { dot: "bg-amber-500", chip: "bg-amber-50 text-amber-800 border border-amber-200" },
  invoice: { dot: "bg-red-500", chip: "bg-red-50 text-red-800 border border-red-200" },
  estimate: { dot: "bg-indigo-500", chip: "bg-indigo-50 text-indigo-800 border border-indigo-200" },
  lawn: { dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-800 border border-emerald-200" },
};

const MAX_CHIPS_PER_CELL = 3;

function parseMonth(monthStr: string) {
  const match = monthStr.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    const today = new Date();
    return {
      year: today.getFullYear(),
      month: today.getMonth(),
      iso: today.toISOString().slice(0, 7),
    };
  }
  return {
    year: parseInt(match[1], 10),
    month: parseInt(match[2], 10) - 1,
    iso: `${match[1]}-${match[2]}`,
  };
}

function shiftMonth(year: number, month: number, delta: number) {
  const newDate = new Date(year, month + delta, 1);
  return `${newDate.getFullYear()}-${String(newDate.getMonth() + 1).padStart(2, "0")}`;
}

export default async function MonthGrid({ events, month }: { events: CalEvent[]; month: string }) {
  const { year, month: monthIdx, iso } = parseMonth(month);
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  const monthStart = `${iso}-01`;
  const monthEnd = `${iso}-${String(daysInMonth).padStart(2, "0")}`;

  const filteredEvents = events.filter(
    (e) => e.date >= monthStart && e.date <= monthEnd
  );

  const groupedEvents = new Map<string, CalEvent[]>();
  filteredEvents.forEach((e) => {
    const dateStr = e.date;
    if (!groupedEvents.has(dateStr)) {
      groupedEvents.set(dateStr, []);
    }
    groupedEvents.get(dateStr)!.push(e);
  });

  const todayIso = new Date().toISOString().slice(0, 10);
  const isCurrentMonth = iso === todayIso.slice(0, 7);

  const firstWeekday = new Date(year, monthIdx, 1).getDay();
  const leading = (firstWeekday + 6) % 7;
  const cells = Array(leading).fill(null).concat(Array.from({ length: daysInMonth }, (_, i) => i + 1));

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <Link
          href={`/calendar?view=month&month=${shiftMonth(year, monthIdx, -1)}`}
          aria-label="Previous month"
          className="text-gray-500 hover:text-gray-700"
        >
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <div className="flex items-center gap-2">
          <p className="text-base font-bold text-gray-900">
            {MONTH_NAMES[monthIdx]} {year}
          </p>
          {!isCurrentMonth && (
            <Link
              href="/calendar?view=month"
              className="text-xs text-blue-600 font-medium"
            >
              Today
            </Link>
          )}
        </div>
        <Link
          href={`/calendar?view=month&month=${shiftMonth(year, monthIdx, 1)}`}
          aria-label="Next month"
          className="text-gray-500 hover:text-gray-700"
        >
          <ChevronRight className="w-4 h-4" />
        </Link>
      </div>
      <div className="grid grid-cols-7 gap-1 mb-4">
        {DAY_LABELS.map((day, i) => (
          <div key={i} className="text-center text-[10px] font-semibold text-gray-400 uppercase">
            {day}
          </div>
        ))}
      </div>
      {filteredEvents.length === 0 ? (
        <div className="bg-white rounded-lg">
          <EmptyState
            icon={CalendarDays}
            title="No events this month"
            description="Events scheduled this month will appear here."
          />
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, i) => {
            const dateStr = day ? `${iso}-${String(day).padStart(2, "0")}` : null;
            const isToday = dateStr === todayIso;
            const eventsForDay = dateStr ? groupedEvents.get(dateStr) || [] : [];

            return (
              <div
                key={dateStr || `b-${i}`}
                className={`min-h-[64px] rounded-lg p-1 flex flex-col gap-1 ${
                  isToday ? "bg-blue-50 ring-1 ring-blue-300" : "bg-white"
                }`}
              >
                {day && (
                  <span
                    className={`text-[10px] font-semibold self-end ${
                      isToday ? "text-blue-700" : "text-gray-400"
                    }`}
                  >
                    {day}
                  </span>
                )}
                {eventsForDay.slice(0, MAX_CHIPS_PER_CELL).map((ev) => {
                  const color = TYPE_COLORS[ev.type];
                  return (
                    <Link
                      key={ev.id}
                      href={ev.href || "#"}
                      className={`block rounded px-1 py-0.5 text-[10px] leading-tight truncate ${color.chip}`}
                    >
                      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${color.dot}`} />
                      <span className="align-middle">{ev.title}</span>
                      {ev.time && (
                        <span className="align-middle text-[9px] opacity-70">
                          {ev.time}
                        </span>
                      )}
                    </Link>
                  );
                })}
                {eventsForDay.length > MAX_CHIPS_PER_CELL && (
                  <span className="text-[9px] text-gray-400 px-1">
                    +{eventsForDay.length - MAX_CHIPS_PER_CELL} more
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}