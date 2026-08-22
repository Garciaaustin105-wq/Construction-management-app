import Link from "next/link";
import { CalendarDays } from "lucide-react";
import EmptyState from "@/components/EmptyState";
import type { CalEvent, CalEventType } from "@/lib/calendarEvents";

const TYPE_COLORS: Record<CalEventType, { dot: string }> = {
  "job-start": { dot: "bg-blue-500" },
  "job-end": { dot: "bg-blue-500" },
  event: { dot: "bg-purple-500" },
  sub: { dot: "bg-amber-500" },
  invoice: { dot: "bg-red-500" },
  estimate: { dot: "bg-indigo-500" },
  lawn: { dot: "bg-emerald-500" },
  install: { dot: "bg-cyan-500" },
};

export default async function AgendaList({ events }: { events: CalEvent[] }) {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const end = new Date();
  end.setDate(end.getDate() + 60);
  const endIso = end.toISOString().slice(0, 10);

  const filteredEvents = events.filter(
    (ev) => ev.date >= todayIso && ev.date <= endIso
  );

  filteredEvents.sort((a, b) => {
    if (a.date === b.date) {
      return (a.time || "").localeCompare(b.time || "");
    }
    return a.date.localeCompare(b.date);
  });

  if (filteredEvents.length === 0) {
    return (
      <div className="bg-white rounded-lg">
        <EmptyState
          icon={CalendarDays}
          title="No upcoming events"
          description="Events in the next 60 days will appear here."
        />
      </div>
    );
  }

  const groupedEvents = new Map<string, CalEvent[]>();
  filteredEvents.forEach((ev) => {
    if (!groupedEvents.has(ev.date)) {
      groupedEvents.set(ev.date, []);
    }
    groupedEvents.get(ev.date)!.push(ev);
  });

  return (
    <div className="bg-white rounded-lg shadow-sm divide-y">
      {Array.from(groupedEvents.entries()).map(([dateStr, events]) => {
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        const tomorrowIso = tomorrow.toISOString().slice(0, 10);

        let label = "";
        if (dateStr === todayIso) {
          label = "Today";
        } else if (dateStr === tomorrowIso) {
          label = "Tomorrow";
        } else {
          label = new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          });
        }

        return (
          <div key={dateStr}>
            <div className="px-3 py-2 bg-gray-50 sticky top-0">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {label}
              </p>
            </div>
            {events.map((ev) => {
              const rowClass =
                "flex items-center gap-2 px-3 py-2 active:bg-gray-50";
              const inner = (
                <>
                  <span
                    className={`inline-block w-2 h-2 rounded-full shrink-0 ${TYPE_COLORS[ev.type].dot}`}
                  />
                  <span className="text-sm text-gray-900 truncate flex-1 min-w-0">
                    {ev.title}
                  </span>
                  {ev.time && (
                    <span className="text-xs text-gray-400 ml-auto shrink-0 pl-2">
                      {ev.time}
                    </span>
                  )}
                </>
              );
              return ev.href ? (
                <Link key={ev.id} href={ev.href} className={rowClass}>
                  {inner}
                </Link>
              ) : (
                <div key={ev.id} className={rowClass}>
                  {inner}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}