"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import PageContainer from "@/components/PageContainer";
import { useToast } from "@/components/Toast";
import { Loader2, Save, Bell, MessageSquare, Mail, Star, Plus, Trash2 } from "lucide-react";
import { SMS_ENABLED } from "@/lib/smsFeature";
import { OFFICE_LIKE, type Role } from "@/lib/roles";

// Office-only notification settings + template editor (lawn variant). Manages
// two org-scoped tables via the browser session client (RLS tier_office for
// templates, tier_office_or_pm for settings — both admit office/admin/
// super_admin, which is the page's OFFICE_LIKE gate). Templates are seeded per
// org (customer_notifications.sql) — the office edits wording + toggles active
// per event×channel; there's no add/delete here. The settings row is upserted
// (one per org): the global enable + the Google review URL the review_request
// template links to.

type Template = {
  id: string;
  event: string;
  channel: "email" | "sms";
  subject: string | null;
  body: string;
  active: boolean;
};

// Review-destination row (review_platforms, item 14): one platform URL the
// happy-path (4-5★) review gate offers the customer. Falls back to the legacy
// google_review_url above when the org hasn't configured any.
type ReviewPlatform = {
  id: string;
  platform: string;
  review_url: string;
  active: boolean;
};

const PLATFORM_OPTIONS = [
  { value: "google", label: "Google" },
  { value: "facebook", label: "Facebook" },
  { value: "yelp", label: "Yelp" },
  { value: "nextdoor", label: "Nextdoor" },
] as const;

const EVENT_ORDER = [
  "visit_reminder",
  "on_my_way",
  "service_complete",
  "service_skipped",
  "review_request",
] as const;

const EVENT_LABEL: Record<string, string> = {
  visit_reminder: "Visit reminder",
  on_my_way: "On my way",
  service_complete: "Service complete",
  service_skipped: "Visit skipped",
  review_request: "Review request",
};

const EVENT_HINT: Record<string, string> = {
  visit_reminder: "Sent the morning of a scheduled visit (automated).",
  on_my_way: "Sent when the crew taps “On my way” on the visit page.",
  service_complete: "Sent when a visit is marked done. Includes a photo link.",
  service_skipped: "Sent when a visit is marked skipped (weather, no access, etc.).",
  review_request: "Sent right after service complete. Links to your review URL.",
};

const TOKENS =
  "{{customer_name}} {{job_name}} {{address}} {{service_date}} {{org_name}} {{photo_link}} {{review_link}}";

export default function LawnNotificationsPage() {
  const router = useRouter();
  const toast = useToast();

  const [authorized, setAuthorized] = useState(false);
  const [orgId, setOrgId] = useState("");

  const [enabled, setEnabled] = useState(false);
  const [reviewUrl, setReviewUrl] = useState("");
  // Review gate threshold (item 15 config): the minimum happy rating that gets
  // routed to public review destinations. 1-3★ stays internal regardless.
  const [gateThreshold, setGateThreshold] = useState(4);
  const [savingSettings, setSavingSettings] = useState(false);

  const [platforms, setPlatforms] = useState<ReviewPlatform[]>([]);
  const [newPlatform, setNewPlatform] = useState("");
  const [newPlatformUrl, setNewPlatformUrl] = useState("");
  const [platformBusy, setPlatformBusy] = useState<string | null>(null);

  const [templates, setTemplates] = useState<Template[]>([]);
  // Per-row draft of subject/body so edits don't mutate the list until saved.
  const [drafts, setDrafts] = useState<Record<string, { subject: string; body: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const supabase = createClient();
    const [{ data: settings }, { data: tpls }, { data: pf }] = await Promise.all([
      supabase
        .from("notification_settings")
        .select("enabled, google_review_url, review_gate_threshold")
        .maybeSingle(),
      supabase
        .from("notification_templates")
        .select("id, event, channel, subject, body, active")
        .order("event")
        .order("channel"),
      supabase
        .from("review_platforms")
        .select("id, platform, review_url, active")
        .order("created_at"),
    ]);
    const s = settings as unknown as
      | {
          enabled: boolean;
          google_review_url: string | null;
          review_gate_threshold: number | null;
        }
      | null;
    setEnabled(s?.enabled ?? false);
    setReviewUrl(s?.google_review_url ?? "");
    setGateThreshold(s?.review_gate_threshold ?? 4);
    setPlatforms((pf as ReviewPlatform[] | null) ?? []);
    const list = (tpls as Template[] | null) ?? [];
    // Stable order regardless of DB sort.
    list.sort(
      (a, b) =>
        EVENT_ORDER.indexOf(a.event as (typeof EVENT_ORDER)[number]) -
          EVENT_ORDER.indexOf(b.event as (typeof EVENT_ORDER)[number]) ||
        (a.channel === "email" ? -1 : 1)
    );
    setTemplates(list);
    setDrafts(
      Object.fromEntries(
        list.map((t) => [t.id, { subject: t.subject ?? "", body: t.body }])
      )
    );
  }

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
        .select("role, organization_id")
        .eq("id", user.id)
        .single();
      const role = (profile?.role as Role) ?? "crew";
      // OFFICE_LIKE = { office, admin, super_admin } — the page's intended
      // audience (templates/settings are org-scoped; super_admin admitted by
      // design per the page header comment). Hand-rolled check replaced with
      // the set so it can't drift from the role taxonomy.
      if (!OFFICE_LIKE.has(role)) {
        router.push("/dashboard");
        return;
      }
      setOrgId((profile?.organization_id as string) ?? "");
      setAuthorized(true);
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveSettings() {
    if (!orgId) {
      toast.error("Could not resolve your organization — reload and try again");
      return;
    }
    setSavingSettings(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("notification_settings")
      .upsert(
        {
          organization_id: orgId,
          enabled,
          google_review_url: reviewUrl.trim() || null,
          review_gate_threshold: gateThreshold,
        },
        { onConflict: "organization_id" }
      );
    setSavingSettings(false);
    if (error) toast.error(`Failed: ${error.message}`);
    else toast.success("Settings saved");
  }

  // --- Review destinations (review_platforms CRUD, item 14) ---

  async function addPlatform() {
    const url = newPlatformUrl.trim();
    if (!newPlatform || !url) {
      toast.error("Pick a platform and paste its review URL");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      toast.error("URL must start with http:// or https://");
      return;
    }
    setPlatformBusy("add");
    const supabase = createClient();
    const { data, error } = await supabase
      .from("review_platforms")
      .insert({
        organization_id: orgId,
        platform: newPlatform,
        review_url: url,
        active: true,
      })
      .select("id, platform, review_url, active")
      .single();
    setPlatformBusy(null);
    if (error || !data) {
      toast.error(`Failed: ${error?.message ?? "error"}`);
      return;
    }
    setPlatforms((prev) => [...prev, data as ReviewPlatform]);
    setNewPlatform("");
    setNewPlatformUrl("");
    toast.success("Review destination added");
  }

  async function togglePlatform(p: ReviewPlatform) {
    setPlatformBusy(p.id);
    const supabase = createClient();
    const { error } = await supabase
      .from("review_platforms")
      .update({ active: !p.active })
      .eq("id", p.id);
    setPlatformBusy(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setPlatforms((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: !p.active } : x))
    );
  }

  async function removePlatform(p: ReviewPlatform) {
    if (!confirm(`Remove the ${p.platform} review destination?`)) return;
    setPlatformBusy(p.id);
    const supabase = createClient();
    const { error } = await supabase
      .from("review_platforms")
      .delete()
      .eq("id", p.id);
    setPlatformBusy(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setPlatforms((prev) => prev.filter((x) => x.id !== p.id));
    toast.success("Review destination removed");
  }

  async function toggleActive(t: Template) {
    setBusyId(t.id);
    const supabase = createClient();
    const { error } = await supabase
      .from("notification_templates")
      .update({ active: !t.active })
      .eq("id", t.id);
    setBusyId(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setTemplates((prev) =>
      prev.map((x) => (x.id === t.id ? { ...x, active: !x.active } : x))
    );
  }

  async function saveTemplate(t: Template) {
    const draft = drafts[t.id];
    if (!draft) return;
    setSavingId(t.id);
    const supabase = createClient();
    const { error } = await supabase
      .from("notification_templates")
      .update({
        subject: t.channel === "email" ? draft.subject.trim() || null : null,
        body: draft.body,
      })
      .eq("id", t.id);
    setSavingId(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setTemplates((prev) =>
      prev.map((x) =>
        x.id === t.id
          ? {
              ...x,
              subject: t.channel === "email" ? draft.subject.trim() || null : null,
              body: draft.body,
            }
          : x
      )
    );
    toast.success("Template saved");
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    );
  }

  // Group templates by event for display.
  const grouped = EVENT_ORDER.map((ev) => ({
    event: ev,
    rows: templates.filter((t) => t.event === ev),
  })).filter((g) => g.rows.length > 0);

  return (
    <PageContainer title="Notifications" backHref="/lawn" backLabel="Lawn" maxWidth="list">
      {/* Global settings */}
      <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Bell className="w-4 h-4 text-green-600" />
          Customer notifications
        </h2>
        <p className="text-xs text-gray-500">
          Templated email &amp; text messages sent to customers at visit
          milestones. Email works now; text (SMS) sends once Twilio is
          configured. Per-customer opt-in is set on each customer.
        </p>

        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-sm font-medium text-gray-700">
            Enable notifications
          </span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-5 h-5 rounded border-gray-300 text-green-600"
          />
        </label>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Google review URL
          </label>
          <input
            type="url"
            placeholder="https://g.page/your-business/review"
            value={reviewUrl}
            onChange={(e) => setReviewUrl(e.target.value)}
            className="block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm"
          />
          <p className="text-[11px] text-gray-400 mt-1">
            Used by the “Review request” template&rsquo;s <code>{`{{review_link}}`}</code>,
            and as the fallback destination when no review platforms are set
            below.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Review gate threshold
          </label>
          <select
            value={gateThreshold}
            onChange={(e) => setGateThreshold(Number(e.target.value))}
            className="block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm bg-white"
          >
            {[5, 4, 3].map((n) => (
              <option key={n} value={n}>
                {n}★ and above goes to public review
              </option>
            ))}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">
            Ratings below this stay internal so the office can follow up before
            a bad experience becomes a public review.
          </p>
        </div>

        <button
          type="button"
          onClick={saveSettings}
          disabled={savingSettings}
          className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {savingSettings ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Save settings
        </button>
      </div>

      {/* Review destinations (item 14): where the happy-path gate sends the
          customer. One row per platform; the gate page renders a button each. */}
      <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Star className="w-4 h-4 text-green-600" />
          Review destinations
        </h2>
        <p className="text-xs text-gray-500">
          Where happy customers are sent to leave a public review. Each active
          destination gets its own button on the thank-you screen. With none
          set, the Google review URL above is used.
        </p>

        {platforms.length > 0 && (
          <ul className="space-y-2">
            {platforms.map((p) => (
              <li
                key={p.id}
                className={`flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 text-sm ${
                  p.active ? "" : "opacity-60"
                }`}
              >
                <span className="font-semibold text-gray-700 capitalize w-20 shrink-0">
                  {p.platform}
                </span>
                <span className="flex-1 min-w-0 truncate text-gray-500 text-xs">
                  {p.review_url}
                </span>
                <button
                  type="button"
                  onClick={() => togglePlatform(p)}
                  disabled={platformBusy === p.id}
                  className={`text-[10px] font-semibold px-2 py-1 rounded shrink-0 ${
                    p.active
                      ? "bg-green-100 text-green-700"
                      : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {p.active ? "Active" : "Inactive"}
                </button>
                <button
                  type="button"
                  onClick={() => removePlatform(p)}
                  disabled={platformBusy === p.id}
                  className="text-gray-300 hover:text-red-600 shrink-0"
                  aria-label={`Remove ${p.platform}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <select
            value={newPlatform}
            onChange={(e) => setNewPlatform(e.target.value)}
            className="w-32 px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white"
          >
            <option value="">Platform</option>
            {PLATFORM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            type="url"
            placeholder="https://…review URL"
            value={newPlatformUrl}
            onChange={(e) => setNewPlatformUrl(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <button
            type="button"
            onClick={addPlatform}
            disabled={platformBusy === "add"}
            className="flex items-center gap-1.5 shrink-0 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-2 active:bg-slate-800 disabled:opacity-50"
          >
            {platformBusy === "add" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            Add
          </button>
        </div>
      </div>

      {/* Token legend */}
      <div className="bg-gray-100 rounded-lg p-3 text-[11px] text-gray-500">
        <p className="font-semibold text-gray-600 mb-0.5">Available tokens</p>
        <p className="font-mono break-words">{TOKENS}</p>
      </div>

      {/* Templates grouped by event */}
      {grouped.map((g) => (
        <div key={g.event} className="space-y-2">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wide">
            {EVENT_LABEL[g.event] ?? g.event}
          </h3>
          <p className="text-[11px] text-gray-400 -mt-1">
            {EVENT_HINT[g.event] ?? ""}
          </p>
          {g.rows.map((t) => {
            const draft = drafts[t.id] ?? { subject: "", body: "" };
            const dirty =
              (t.channel === "email"
                ? (t.subject ?? "") !== draft.subject.trim()
                : false) || t.body !== draft.body;
            // SMS isn't live yet — render a read-only "Coming soon" card and
            // skip the editable controls so the office can't toggle/edit a
            // channel that won't deliver.
            if (t.channel === "sms" && !SMS_ENABLED) {
              return (
                <div
                  key={t.id}
                  className="bg-white rounded-lg p-3 shadow-sm space-y-2 opacity-80"
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-gray-700">
                      <MessageSquare className="w-3.5 h-3.5 text-gray-400" />
                      Text (SMS)
                    </span>
                    <span className="text-[10px] font-semibold px-2 py-1 rounded bg-amber-100 text-amber-700">
                      Coming soon
                    </span>
                  </div>
                  <textarea
                    readOnly
                    value={draft.body}
                    rows={2}
                    className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono bg-gray-50 text-gray-400 cursor-not-allowed"
                  />
                  <p className="text-[11px] text-gray-400">
                    Text messaging arrives once Twilio is configured.
                  </p>
                </div>
              );
            }
            return (
              <div
                key={t.id}
                className={`bg-white rounded-lg p-3 shadow-sm space-y-2 ${
                  t.active ? "" : "opacity-60"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-gray-700">
                    {t.channel === "email" ? (
                      <Mail className="w-3.5 h-3.5 text-gray-400" />
                    ) : (
                      <MessageSquare className="w-3.5 h-3.5 text-gray-400" />
                    )}
                    {t.channel === "email" ? "Email" : "Text (SMS)"}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleActive(t)}
                    disabled={busyId === t.id}
                    className={`text-[10px] font-semibold px-2 py-1 rounded ${
                      t.active
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {t.active ? "Active" : "Inactive"}
                  </button>
                </div>

                {t.channel === "email" && (
                  <input
                    type="text"
                    placeholder="Email subject"
                    value={draft.subject}
                    onChange={(e) =>
                      setDrafts((d) => ({
                        ...d,
                        [t.id]: { ...d[t.id], subject: e.target.value },
                      }))
                    }
                    className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                )}
                <textarea
                  placeholder="Message body"
                  value={draft.body}
                  onChange={(e) =>
                    setDrafts((d) => ({
                      ...d,
                      [t.id]: { ...d[t.id], body: e.target.value },
                    }))
                  }
                  rows={t.channel === "email" ? 5 : 2}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                />

                <button
                  type="button"
                  onClick={() => saveTemplate(t)}
                  disabled={savingId === t.id || !dirty}
                  className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  {savingId === t.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  Save template
                </button>
              </div>
            );
          })}
        </div>
      ))}

      {templates.length === 0 && (
        <div className="bg-white rounded-lg p-6 text-center">
          <Bell className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-700">No templates yet</p>
          <p className="text-xs text-gray-500 mt-1">
            Run <code>customer_notifications.sql</code> in the Supabase SQL
            editor to seed the default templates.
          </p>
        </div>
      )}
    </PageContainer>
  );
}