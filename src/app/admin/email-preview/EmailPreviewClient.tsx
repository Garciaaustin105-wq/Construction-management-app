"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EMAIL_KIND_META, TEMPLATE_TOKENS } from "@/lib/emailPreviewKinds";
import type { EmailKindMeta } from "@/lib/emailPreviewKinds";
import { APP_VARIANT } from "@/lib/variant";
import { useToast } from "@/components/Toast";
import {
  Loader2,
  Send,
  Mail,
  Save,
  Pencil,
  Lock,
  Smartphone,
  Code,
  FileText,
  Eye,
  Link2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

const KINDS: EmailKindMeta[] = EMAIL_KIND_META.filter(
  (k) => k.variant === "both" || k.variant === APP_VARIANT
);

// Records returned by /api/email-preview/records. Shape mirrors PickerRecord in
// emailLoaders.ts (server-only) — duplicated here so the client doesn't pull
// server code into its bundle.
type PickerRecord = { id: string; label: string };

type ViewMode = "preview" | "html" | "text";
type DataMode = "sample" | "real";

type EmailLink = { href: string; text: string; isPlaceholder: boolean };

const PLACEHOLDER_HINTS = [
  "sample-",
  "(link generates on send)",
  "(generates on send)",
];

function isPlaceholderHref(href: string): boolean {
  if (!href) return true;
  return PLACEHOLDER_HINTS.some((h) => href.includes(h));
}

// Mobile email clients (Gmail, Apple Mail, Samsung) override fixed-width tables
// with width:100% so a 560px email reflows onto a 375px phone. The platform's
// emails wrap content in a fixed width="560" card, so naively squeezing the
// iframe to 375px just crops the right edge ("cuts off the letter"). Injecting
// the same override the real clients apply makes the mobile preview actually
// reflow instead of clipping. Injected before </head> (every render fn emits a
// full <html><head>…</head> document).
const MOBILE_STYLE =
  '<style>table[width="560"]{width:100%!important;max-width:100%!important;}img{max-width:100%!important;height:auto!important;}</style>';

function withMobileStyle(html: string): string {
  if (!html) return html;
  if (html.includes("</head>")) return html.replace("</head>", `${MOBILE_STYLE}</head>`);
  return MOBILE_STYLE + html;
}

export default function EmailPreviewClient({
  canSaveTemplates,
}: {
  canSaveTemplates: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string>(KINDS[0]?.id ?? "");
  const [subject, setSubject] = useState<string>("");
  const [html, setHtml] = useState<string>("");
  const [rawSubject, setRawSubject] = useState<string>("");
  const [rawBody, setRawBody] = useState<string>("");
  // Snapshot of the last-loaded (or last-saved) copy, for dirty tracking. The
  // editor is a real editor now — Save writes back to notification_templates —
  // so we need to know when the working copy diverges from what's persisted.
  const [savedSubject, setSavedSubject] = useState<string>("");
  const [savedBody, setSavedBody] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [sending, setSending] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [lastSentTo, setLastSentTo] = useState<string | null>(null);

  // Phase 2 — view controls + real-data picker
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [mobile, setMobile] = useState<boolean>(false);
  const [dataMode, setDataMode] = useState<DataMode>("sample");
  const [records, setRecords] = useState<PickerRecord[]>([]);
  const [recordId, setRecordId] = useState<string>("");
  const [loadingRecords, setLoadingRecords] = useState<boolean>(false);
  const [linksOpen, setLinksOpen] = useState<boolean>(false);

  const debouncedFetchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToast();

  async function fetchPreview(
    id: string,
    opts?: {
      editedSubject?: string;
      editedBody?: string;
      applyRaw?: boolean;
      recordId?: string;
    }
  ) {
    setLoading(true);
    const payload: {
      id: string;
      editedSubject?: string;
      editedBody?: string;
      recordId?: string;
    } = { id };
    if (opts?.editedSubject !== undefined) payload.editedSubject = opts.editedSubject;
    if (opts?.editedBody !== undefined) payload.editedBody = opts.editedBody;
    if (opts?.recordId) payload.recordId = opts.recordId;

    try {
      const res = await fetch("/api/email-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      setSubject(data.subject);
      setHtml(data.html);
      // Only populate the editor from the API on a kind-load (applyRaw). On an
      // edit-driven fetch the API echoes back the edited text, which would
      // fight the user's cursor / overwrite mid-typing. The saved-snapshot is
      // also only refreshed on a kind-load so dirty tracking survives a live
      // preview re-render.
      if (opts?.applyRaw) {
        if (data.rawSubject !== undefined) {
          setRawSubject(data.rawSubject);
          setSavedSubject(data.rawSubject);
        }
        if (data.rawBody !== undefined) {
          setRawBody(data.rawBody);
          setSavedBody(data.rawBody);
        }
      }
    } catch {
      toast.error("Preview failed to load");
    } finally {
      setLoading(false);
    }
  }

  // On kind-switch: cancel any pending edit-debounce, reset to Sample mode +
  // clear the record picker (the new kind's records haven't been loaded yet),
  // then fetch the saved-template / fixed-sample preview.
  useEffect(() => {
    if (debouncedFetchRef.current) {
      clearTimeout(debouncedFetchRef.current);
      debouncedFetchRef.current = null;
    }
    if (!selectedId) return;
    setDataMode("sample");
    setRecordId("");
    setRecords([]);
    fetchPreview(selectedId, { applyRaw: true });
  }, [selectedId]);

  const kind = KINDS.find((k) => k.id === selectedId) ?? null;
  const editable = kind?.editable ?? false;
  const hasRealData = !!kind?.realData;
  const dirty =
    editable &&
    canSaveTemplates &&
    (rawSubject.trim() !== savedSubject.trim() || rawBody !== savedBody);

  const activeRecordId = dataMode === "real" && recordId ? recordId : undefined;

  const handleSubjectChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRawSubject(e.target.value);
    if (debouncedFetchRef.current) clearTimeout(debouncedFetchRef.current);
    const nextSubject = e.target.value;
    const nextRecordId = activeRecordId;
    debouncedFetchRef.current = setTimeout(() => {
      fetchPreview(selectedId, {
        editedSubject: nextSubject,
        editedBody: rawBody,
        recordId: nextRecordId,
      });
    }, 400);
  };

  const handleBodyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setRawBody(e.target.value);
    if (debouncedFetchRef.current) clearTimeout(debouncedFetchRef.current);
    const nextBody = e.target.value;
    const nextRecordId = activeRecordId;
    debouncedFetchRef.current = setTimeout(() => {
      fetchPreview(selectedId, {
        editedSubject: rawSubject,
        editedBody: nextBody,
        recordId: nextRecordId,
      });
    }, 400);
  };

  // ── Real-data picker ──────────────────────────────────────────────────────
  async function loadRecords(id: string): Promise<PickerRecord[]> {
    setLoadingRecords(true);
    try {
      const res = await fetch("/api/email-preview/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data.supportsReal) {
        const recs = (data.records ?? []) as PickerRecord[];
        setRecords(recs);
        return recs;
      }
      setRecords([]);
      return [];
    } catch {
      setRecords([]);
      return [];
    } finally {
      setLoadingRecords(false);
    }
  }

  async function switchToReal() {
    if (!selectedId) return;
    setDataMode("real");
    const recs = await loadRecords(selectedId);
    if (recs.length > 0) {
      const first = recs[0].id;
      setRecordId(first);
      fetchPreview(selectedId, { applyRaw: true, recordId: first });
    } else {
      // No records (empty org) or super_admin (supportsReal false) — leave the
      // preview on sample data; the picker shows an empty-state note.
      setRecordId("");
    }
  }

  function switchToSample() {
    setDataMode("sample");
    setRecordId("");
    fetchPreview(selectedId, { applyRaw: true });
  }

  function onRecordChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    setRecordId(id);
    fetchPreview(selectedId, { applyRaw: true, recordId: id });
  }

  // ── Client-side HTML parsing (view modes + link check) ────────────────────
  // DOMParser is browser-only; this component is "use client" so it's safe.
  const textContent = useMemo(() => {
    if (typeof document === "undefined" || !html) return "";
    try {
      return (
        new DOMParser().parseFromString(html, "text/html").body.textContent ??
        ""
      );
    } catch {
      return "";
    }
  }, [html]);

  const links = useMemo<EmailLink[]>(() => {
    if (typeof document === "undefined" || !html) return [];
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return Array.from(doc.querySelectorAll("a[href]")).map((a) => {
        const el = a as HTMLAnchorElement;
        const href = el.getAttribute("href") ?? "";
        return {
          href,
          text: el.textContent ?? "",
          isPlaceholder: isPlaceholderHref(href),
        };
      });
    } catch {
      return [];
    }
  }, [html]);

  async function sendTest() {
    if (!selectedId) return;
    setSending(true);
    const payload: {
      id: string;
      editedSubject?: string;
      editedBody?: string;
      recordId?: string;
    } = { id: selectedId };
    if (editable) {
      payload.editedSubject = rawSubject;
      payload.editedBody = rawBody;
    }
    if (activeRecordId) payload.recordId = activeRecordId;

    try {
      const res = await fetch("/api/email-preview/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        setLastSentTo(data.sentTo ?? null);
        toast.success(`Test sent to ${data.sentTo}`);
      } else {
        toast.error(data.error || "Send failed");
      }
    } finally {
      setSending(false);
    }
  }

  async function saveTemplate() {
    if (!selectedId || !editable || !canSaveTemplates || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch("/api/email-preview/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: selectedId, subject: rawSubject, body: rawBody }),
      });
      const data = await res.json();
      if (data.ok) {
        // Update the snapshot so dirty clears; no re-fetch needed — the live
        // preview already reflects the current editor content.
        setSavedSubject(rawSubject.trim());
        setSavedBody(rawBody);
        toast.success("Template saved");
      } else {
        toast.error(data.error || "Save failed");
      }
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (KINDS.length === 0 || !selectedId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-lg p-6 text-center">
          <Mail className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-700">No emails to preview</p>
          <p className="text-xs text-gray-500 mt-1">No email kinds available for preview.</p>
        </div>
      </div>
    );
  }

  const editableKinds = KINDS.filter((k) => k.editable);
  const fixedKinds = KINDS.filter((k) => !k.editable);

  const renderKindButton = (k: EmailKindMeta) => (
    <button
      key={k.id}
      onClick={() => setSelectedId(k.id)}
      className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
        selectedId === k.id ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"
      }`}
    >
      {k.label}
    </button>
  );

  // Constrain the preview surface to a phone width when the mobile toggle is on.
  const previewSurfaceClass = mobile
    ? "w-full max-w-[375px] mx-auto"
    : "w-full";

  return (
    <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
        {/* Kind list — grouped into Editable templates / Fixed-copy emails so
            the distinction is obvious at a glance instead of only implied by
            which kinds happen to show an editor. */}
        <div className="bg-white rounded-lg shadow-sm p-2 space-y-2">
          {editableKinds.length > 0 && (
            <div className="space-y-1">
              <p className="px-2 pt-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1">
                <Pencil className="w-3 h-3" /> Editable templates
              </p>
              {editableKinds.map(renderKindButton)}
            </div>
          )}
          {fixedKinds.length > 0 && (
            <div className="space-y-1">
              <p className="px-2 pt-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1">
                <Lock className="w-3 h-3" /> Fixed-copy emails
              </p>
              {fixedKinds.map(renderKindButton)}
            </div>
          )}
        </div>

        {/* Selected kind detail */}
        <div className="space-y-4">
          {/* Header + Sample/Real toggle + record picker */}
          <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
                <Mail className="w-4 h-4 text-gray-400" />
                {kind?.label}
              </h2>
              <p className="text-xs text-gray-500">
                {editable
                  ? "Edit the wording below — preview updates live. Save to keep your changes."
                  : "Copy is set by the platform — preview it and send a test to yourself."}
              </p>
            </div>

            {/* Sample / Real toggle + record picker. Hidden for auth-flow
                kinds (no realData); those show a small note instead. */}
            {hasRealData ? (
              <div className="space-y-2">
                <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                  <button
                    onClick={switchToSample}
                    className={`px-3 py-1.5 font-semibold ${
                      dataMode === "sample"
                        ? "bg-blue-600 text-white"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    Sample
                  </button>
                  <button
                    onClick={switchToReal}
                    className={`px-3 py-1.5 font-semibold ${
                      dataMode === "real"
                        ? "bg-blue-600 text-white"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    Real
                  </button>
                </div>
                {dataMode === "real" && (
                  <div className="flex items-center gap-2">
                    {loadingRecords ? (
                      <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
                    ) : records.length > 0 ? (
                      <select
                        value={recordId}
                        onChange={onRecordChange}
                        className="block w-full px-2 py-1.5 border border-gray-300 rounded-lg text-xs"
                      >
                        {records.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-[11px] text-gray-400">
                        No records available for this kind in your organization.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-gray-400">
                Sample only — generated during signup / password reset, no record to pick.
              </p>
            )}
          </div>

          {/* Subject */}
          <div className="bg-white rounded-lg p-4 shadow-sm">
            <label className="text-xs font-medium text-gray-600 mb-1">Subject (as sent)</label>
            <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800">
              {subject || "—"}
            </div>
          </div>

          {/* Preview — view segmented control + mobile toggle above the surface */}
          <div className="bg-white rounded-lg p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-600">Preview</label>
              <div className="flex items-center gap-2">
                {/* View segmented control */}
                <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-[11px]">
                  <button
                    onClick={() => setViewMode("preview")}
                    className={`px-2 py-1 font-semibold flex items-center gap-1 ${
                      viewMode === "preview"
                        ? "bg-gray-800 text-white"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                    title="Rendered preview"
                  >
                    <Eye className="w-3 h-3" /> Preview
                  </button>
                  <button
                    onClick={() => setViewMode("html")}
                    className={`px-2 py-1 font-semibold flex items-center gap-1 ${
                      viewMode === "html"
                        ? "bg-gray-800 text-white"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                    title="Raw HTML"
                  >
                    <Code className="w-3 h-3" /> HTML
                  </button>
                  <button
                    onClick={() => setViewMode("text")}
                    className={`px-2 py-1 font-semibold flex items-center gap-1 ${
                      viewMode === "text"
                        ? "bg-gray-800 text-white"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                    title="Plain text"
                  >
                    <FileText className="w-3 h-3" /> Text
                  </button>
                </div>
                {/* Mobile preview toggle */}
                <button
                  onClick={() => setMobile((m) => !m)}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border ${
                    mobile
                      ? "bg-gray-800 text-white border-gray-800"
                      : "text-gray-600 border-gray-200 hover:bg-gray-50"
                  }`}
                  title="Constrain to phone width"
                >
                  <Smartphone className="w-3 h-3" /> Mobile
                </button>
              </div>
            </div>

            {loading && !html ? (
              <div className="w-full h-[520px] flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
              </div>
            ) : viewMode === "preview" ? (
              <iframe
                title="Email preview"
                srcDoc={mobile ? withMobileStyle(html) : html}
                className={`${previewSurfaceClass} h-[520px] bg-white border border-gray-200 rounded-lg`}
              />
            ) : (
              <pre
                className={`${previewSurfaceClass} font-mono text-xs overflow-auto h-[520px] bg-gray-50 p-3 rounded-lg border whitespace-pre-wrap break-words`}
              >
                {viewMode === "html" ? html : textContent}
              </pre>
            )}

            {/* Link-check panel — only in Preview view. Lists every <a href>
                parsed client-side from the rendered HTML; placeholder links
                (sample-*, "(link generates on send)") are flagged amber, real
                links green. Collapsible to keep the default view tidy. */}
            {viewMode === "preview" && links.length > 0 && (
              <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setLinksOpen((o) => !o)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-gray-600 bg-gray-50 hover:bg-gray-100"
                >
                  <span className="flex items-center gap-1.5">
                    <Link2 className="w-3.5 h-3.5" /> Links ({links.length})
                  </span>
                  {linksOpen ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                </button>
                {linksOpen && (
                  <ul className="divide-y divide-gray-100">
                    {links.map((l, i) => (
                      <li key={i} className="px-3 py-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              l.isPlaceholder
                                ? "bg-amber-100 text-amber-700"
                                : "bg-green-100 text-green-700"
                            }`}
                          >
                            {l.isPlaceholder ? "placeholder" : "real"}
                          </span>
                          <span className="text-gray-700 truncate">{l.text || "(no text)"}</span>
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-gray-500 break-all">
                          {l.href || "(empty href)"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Editor (templated kinds only) */}
          {editable && (
            <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-700">Edit template (live preview)</h2>
                <button
                  onClick={saveTemplate}
                  disabled={!dirty || saving}
                  className="inline-flex items-center gap-1.5 bg-blue-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-40 active:bg-blue-700"
                >
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Save
                </button>
              </div>
              <input
                type="text"
                value={rawSubject}
                onChange={handleSubjectChange}
                placeholder="Email subject"
                className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
              <textarea
                value={rawBody}
                onChange={handleBodyChange}
                rows={6}
                placeholder="Message body — use {{tokens}}"
                className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
              />
              <div className="bg-gray-100 rounded-lg p-2 text-[11px] text-gray-500">
                <p className="font-semibold text-gray-600 mb-0.5">Tokens</p>
                <p className="font-mono break-words">
                  {TEMPLATE_TOKENS.map((t) => `{{${t}}}`).join("  ")}
                </p>
              </div>
              {!canSaveTemplates && (
                <p className="text-[11px] text-gray-400">
                  Your account has no organization to save templates for.
                </p>
              )}
            </div>
          )}

          {/* Send button */}
          <button
            onClick={sendTest}
            disabled={loading || sending || !kind}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Send test to yourself
          </button>

          {/* Last sent to */}
          {lastSentTo && (
            <p className="text-xs text-green-600 text-center">Test sent to {lastSentTo}</p>
          )}
        </div>
      </div>
    </main>
  );
}