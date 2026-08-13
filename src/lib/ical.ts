// iCal feed builder — thin wrapper over `ical-generator` (RFC 5545 escaping,
// line-folding, and all-day DATE vs timed UTC DTSTART/exclusive DTEND are
// handled by the library so Google/Outlook/Apple don't silently reject the
// calendar). Hand-rolling this is easy to get subtly wrong and hard to debug
// without a real provider, so we delegate.
//
// UIDs are stable per source row (`<kind>:<id>@<host>`) so providers UPDATE
// existing events instead of duplicating them on every re-fetch.

import ical from "ical-generator";

export type FeedEvent = {
  // Stable UID — `<kind>:<rowId>@<host>`. Kept stable across fetches.
  uid: string;
  summary: string;
  start: Date;
  end?: Date;
  // true → all-day DATE value (jobs/sub/invoice/quote dates); false/omitted →
  // timed UTC DTSTART (schedule_events).
  allDay?: boolean;
  description?: string;
};

// Build a full text/calendar document from the role-scoped event list. `host`
// is the deployed app host (used as the UID authority + PRODID).
export function buildCalendar(events: FeedEvent[], host: string): string {
  const cal = ical({
    name: "Terra Vista",
    // PRODID identifies the generating app per RFC 5545.
    prodId: { company: "Terra Vista", product: "Construction Calendar", language: "EN" },
    // Hint providers how often to re-poll the subscribe URL.
    ttl: 60 * 60, // 1 hour, in seconds
  });

  for (const ev of events) {
    cal.createEvent({
      id: ev.uid,
      summary: ev.summary,
      start: ev.start,
      end: ev.end,
      allDay: ev.allDay ?? false,
      description: ev.description,
    });
  }

  // ical-generator's toString() emits the VCALENDAR block. We suffix a
  // X-WR-CALNAME so the subscribe shows a friendly name in Apple/Outlook.
  const ics = cal.toString();
  const calnameLine = `X-WR-CALNAME:Terra Vista`;
  // Insert right after the VERSION line if present (otherwise prepend).
  if (ics.includes("VERSION:2.0")) {
    return ics.replace("VERSION:2.0", `VERSION:2.0\n${calnameLine}`);
  }
  return ics;
}

// Stable UID helper — `<kind>:<rowId>@<host>`.
export function feedUid(kind: string, rowId: string, host: string): string {
  return `${kind}:${rowId}@${host}`;
}