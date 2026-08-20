"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import { useToast } from "@/components/Toast";
import { Loader2, Save, Bell, MessageSquare, Mail } from "lucide-react";
import { SMS_ENABLED } from "@/lib/smsFeature";

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
  const [savingSettings, setSavingSettings] = useState(false);

  const [templates, setTemplates] = useState<Template[]>([]);
  // Per-row draft of subject/body so edits don't mutate the list until saved.
  const [drafts, setDrafts] = useState<Record<string, { subject: string; body: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const supabase = createClient();
    const [{ data: settings }, { data: tpls }] = await Promise.all([
      supabase
        .from("notification_settings")
        .select("enabled, google_review_url")
        .maybeSingle(),
      supabase
        .from("notification_templates")
        .select("id, event, channel, subject, body, active")
        .order("event")
        .order("channel"),
    ]);
    const s = settings as unknown as
      | { enabled: boolean; google_review_url: string | null }
      | null;
    setEnabled(s?.enabled ?? false);
    setReviewUrl(s?.google_review_url ?? "");
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
      const role = profile?.role ?? "crew";
      if (
        role !== "office" &&
        role !== "admin" &&
        role !== "super_admin"
      ) {
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
        },
        { onConflict: "organization_id" }
      );
    setSavingSettings(false);
    if (error) toast.error(`Failed: ${error.message}`);
    else toast.success("Settings saved");
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
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Notifications" backHref="/lawn" backLabel="Lawn" />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
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
              Used by the “Review request” template&rsquo;s <code>{`{{review_link}}`}</code>.
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
      </main>
    </div>
  );
}