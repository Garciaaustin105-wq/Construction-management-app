/**
 * Scheduling ops page (lawn variant): the weather auto-reschedule settings
 * that arm the nightly cron, plus the bulk tools — batch reschedule, org
 * blackout dates, service zones, crew time off. The manual same-day weather
 * board lives at /lawn/weather; this page is the settings + bulk-tools half.
 */

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_LIKE } from "@/lib/roles";
import PageContainer from "@/components/PageContainer";
import SchedulingTools, {
  type SchedulingCrew,
  type SchedulingBlackout,
  type SchedulingZone,
  type SchedulingTimeOff,
  type SchedulingProps,
} from "@/components/SchedulingTools";

export const dynamic = "force-dynamic";

export default async function SchedulingPage() {
  const me = await requireRole(OFFICE_LIKE, "/dashboard");

  const supabase = await createClient();

  const { data: orgData } = await supabase
    .from("organizations")
    .select("id, auto_weather_reschedule_enabled, service_area_lat, service_area_lng")
    .eq("id", me.orgId)
    .single();

  // Lists are plain selects (RLS scopes to this org) — no .single()/.maybeSingle().
  const [{ data: crewData }, { data: blackoutData }, { data: zoneData }, { data: timeOffData }] =
    await Promise.all([
      supabase
        .from("crew_members")
        .select("id, name, working_days, max_visits_per_day")
        .order("name"),
      supabase.from("org_blackout_dates").select("id, date, reason").order("date"),
      supabase
        .from("service_zones")
        .select(
          "id, name, center_lat, center_lng, radius_miles, assigned_day_of_week, default_crew_id, active"
        )
        .order("name"),
      supabase
        .from("crew_time_off")
        .select("id, crew_id, start_date, end_date, reason")
        .order("start_date"),
    ]);

  const props: SchedulingProps = {
    orgId: me.orgId ?? "",
    weather: {
      enabled: orgData?.auto_weather_reschedule_enabled ?? false,
      lat: orgData?.service_area_lat ?? null,
      lng: orgData?.service_area_lng ?? null,
    },
    crews: (crewData as SchedulingCrew[] | null) ?? [],
    blackouts: (blackoutData as SchedulingBlackout[] | null) ?? [],
    zones: (zoneData as SchedulingZone[] | null) ?? [],
    timeOff: (timeOffData as SchedulingTimeOff[] | null) ?? [],
  };

  return (
    <PageContainer
      title="Scheduling"
      subtitle="Weather, capacity, zones"
      backHref="/lawn"
      backLabel="Back"
      maxWidth="list"
      mainClassName="space-y-6"
    >
      <SchedulingTools {...props} />
    </PageContainer>
  );
}