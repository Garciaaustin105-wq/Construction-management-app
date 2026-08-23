"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Sparkles, Lock, Copy, Check, Mail } from "lucide-react";
import Card, { CardHeader } from "@/components/ui/Card";
import Button, { LinkButton, buttonClasses } from "@/components/ui/Button";
import { FormField, Select } from "@/components/ui/FormField";
import FormGrid from "@/components/ui/FormGrid";
import AiUsageMeter from "@/components/AiUsageMeter";
import AiResultCard from "@/components/AiResultCard";
import { useToast } from "@/components/Toast";
import {
  AiRequestError,
  draftCustomerEmail,
  fetchAiQuota,
  isAiDisabled,
  isAiExhausted,
  summarizeVisits,
  type AiQuota,
  type CustomerEmailType,
  type DraftCustomerEmailResponse,
  type SummarizeVisitsResponse,
} from "@/lib/aiClient";

// Interactive half of /lawn/ai. The server page owns the role gate and hands
// this component only what it already read through RLS (the customer list), so
// nothing here makes an access decision. Every AI call goes through
// /api/ai/* — no LLM key, no service-role client, no quota logic in the browser.

export type CustomerOption = { id: string; name: string; emailOptIn: boolean };

// Default window: the last 30 days, inclusive. Matches how the office talks
// about a billing period ("what happened last month") without needing a
// calendar component the repo doesn't have.
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function AiAdminClient({
  customers,
}: {
  customers: CustomerOption[];
}) {
  const toast = useToast();

  const [quota, setQuota] = useState<AiQuota | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [loadingQuota, setLoadingQuota] = useState(true);

  const [customerId, setCustomerId] = useState("");
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SummarizeVisitsResponse | null>(null);

  // ── Draft customer email (slice 2) ────────────────────────────────────────
  // Its own customer picker, independent of the summarize card above: an email
  // is always about ONE customer, whereas a summary may be org-wide.
  const [emailCustomerId, setEmailCustomerId] = useState("");
  const [emailType, setEmailType] = useState<CustomerEmailType>("season_recap");
  // Wider default window than summarize — an email references a season, not a
  // billing month.
  const [emailFrom, setEmailFrom] = useState(isoDaysAgo(365));
  const [emailTo, setEmailTo] = useState(isoDaysAgo(0));
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<DraftCustomerEmailResponse | null>(null);
  // The draft is EDITABLE — the office tweaks it before copying, and Copy /
  // Open-in-email both read this live state, not the model's original output.
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [copied, setCopied] = useState(false);

  const loadQuota = useCallback(async (signal?: AbortSignal) => {
    try {
      const q = await fetchAiQuota(signal);
      setQuota(q);
      setQuotaError(null);
    } catch (e) {
      if (signal?.aborted) return;
      // The quota route is the gate's display half. If it is down we show the
      // error instead of the form — running the LLM blind is exactly what
      // checkAiQuota's fail-closed behaviour is there to prevent.
      setQuotaError(e instanceof Error ? e.message : "Could not load AI usage");
    } finally {
      if (!signal?.aborted) setLoadingQuota(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void loadQuota(ac.signal);
    return () => ac.abort();
  }, [loadQuota]);

  const disabled = isAiDisabled(quota);
  const exhausted = isAiExhausted(quota);

  async function run() {
    if (!from || !to) {
      toast.warning("Pick a start and end date");
      return;
    }
    if (from > to) {
      toast.warning("The start date must be on or before the end date");
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const res = await summarizeVisits({
        from,
        to,
        ...(customerId ? { customerId } : {}),
      });
      setResult(res);
      // The route returns the post-action quota, so the meter updates without
      // a second round trip.
      setQuota(res.quota);
      if (res.visitCount === 0) {
        toast.info("No visits in that range — the summary reflects an empty period");
      }
    } catch (e) {
      const status = e instanceof AiRequestError ? e.status : 0;
      if (status === 429) {
        toast.error("You've used all your AI actions for this month");
        void loadQuota();
      } else if (status === 402 || status === 403) {
        toast.error("AI isn't included on your current plan");
        void loadQuota();
      } else {
        toast.error(e instanceof Error ? e.message : "Summary failed");
      }
    } finally {
      setRunning(false);
    }
  }

  // The `upsell` type is marketing, so it's gated on the customer's marketing
  // consent (`customers.email_opt_in`). NOTE: the server route validates that
  // `type` is in the enum but does NOT re-check opt-in — this UI gate is
  // currently the only thing stopping a marketing draft for a non-consenting
  // customer. Flagged to Claude-direct.
  const selectedEmailCustomer = customers.find((c) => c.id === emailCustomerId);
  const upsellBlocked = !!selectedEmailCustomer && !selectedEmailCustomer.emailOptIn;

  function pickEmailCustomer(id: string) {
    setEmailCustomerId(id);
    // Switching to a customer who hasn't opted in can't leave `upsell` selected.
    const next = customers.find((c) => c.id === id);
    if (emailType === "upsell" && next && !next.emailOptIn) {
      setEmailType("season_recap");
    }
  }

  async function draftEmail() {
    if (!emailCustomerId) {
      toast.warning("Pick a customer");
      return;
    }
    if (emailFrom && emailTo && emailFrom > emailTo) {
      toast.warning("The start date must be on or before the end date");
      return;
    }
    setDrafting(true);
    setDraft(null);
    setCopied(false);
    try {
      const res = await draftCustomerEmail({
        customerId: emailCustomerId,
        type: emailType,
        ...(emailFrom ? { from: emailFrom } : {}),
        ...(emailTo ? { to: emailTo } : {}),
      });
      setDraft(res);
      // Same shared meter as summarize — the route returns the post-action
      // quota so this needs no second round trip.
      setQuota(res.quota);
      if (res.draftable) {
        setSubject(res.subject);
        setBodyText(res.body);
      } else {
        // No LLM ran and no action was consumed; `body` holds the reason.
        setSubject("");
        setBodyText("");
        toast.info("Not enough history to draft that email");
      }
    } catch (e) {
      const status = e instanceof AiRequestError ? e.status : 0;
      if (status === 429) {
        toast.error("You've used all your AI actions for this month");
        void loadQuota();
      } else if (status === 402 || status === 403) {
        toast.error("AI isn't included on your current plan");
        void loadQuota();
      } else {
        toast.error(e instanceof Error ? e.message : "Draft failed");
      }
    } finally {
      setDrafting(false);
    }
  }

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${bodyText}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Copied");
    } catch {
      // Clipboard is permission-gated and unavailable on insecure origins.
      toast.error("Couldn't copy — select the text and copy manually");
    }
  }

  // Built from the LIVE edited state so the office can tweak, then open.
  const mailtoHref = `mailto:${encodeURIComponent(
    draft?.customerEmail ?? ""
  )}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;

  if (loadingQuota) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-gray-500 py-4 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading AI usage…
        </div>
      </Card>
    );
  }

  if (quotaError) {
    return (
      <Card>
        <CardHeader title="AI usage unavailable" />
        <p className="text-sm text-gray-600">{quotaError}</p>
        <div className="mt-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setLoadingQuota(true);
              void loadQuota();
            }}
          >
            Try again
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {quota && (
        <Card>
          <AiUsageMeter used={quota.used} max={quota.max} />
        </Card>
      )}

      {/* Tier has no AI at all → upgrade wall, form hidden. Deliberately does
          NOT say "upgrade from free": per src/lib/plans.ts the paid Starter
          tier is also 0, so this is shown to paying customers too. */}
      {disabled ? (
        <Card>
          <CardHeader
            title="AI admin isn't on your plan"
            subtitle="Available on Pro and Business"
          />
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-gray-400">
              <Lock className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm text-gray-600">
                AI visit summaries read your own visit history and write the
                recap for you — the month&rsquo;s work per customer, in plain
                English, ready to send. Upgrade to switch it on.
              </p>
              <div className="mt-3">
                <LinkButton href="/admin/billing" size="sm">
                  See plans
                </LinkButton>
              </div>
            </div>
          </div>
        </Card>
      ) : (
        <>
        <Card>
          <CardHeader
            title="Summarize visits"
            subtitle="Pick a period — and a customer, to narrow it"
          />

          {exhausted && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">
                You&rsquo;ve used all {quota?.max} AI actions this month.
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                Your allowance resets at the start of next month.
              </p>
            </div>
          )}

          <FormGrid columns={2}>
            <FormField label="Customer" htmlFor="ai-customer" hint="All customers if left blank">
              <Select
                id="ai-customer"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                disabled={running || exhausted}
              >
                <option value="">All customers</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>

            <div className="grid grid-cols-2 gap-2">
              <FormField label="From" htmlFor="ai-from" required>
                <input
                  id="ai-from"
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                  disabled={running || exhausted}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base bg-white disabled:bg-gray-50"
                />
              </FormField>
              <FormField label="To" htmlFor="ai-to" required>
                <input
                  id="ai-to"
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                  disabled={running || exhausted}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base bg-white disabled:bg-gray-50"
                />
              </FormField>
            </div>
          </FormGrid>

          <div className="mt-4 flex items-center gap-3">
            <Button type="button" onClick={run} disabled={running || exhausted}>
              {running ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              {running ? "Summarizing…" : "Summarize visits"}
            </Button>
            <p className="text-xs text-gray-400">Uses 1 AI action</p>
          </div>
        </Card>

        {/* Summarize result sits directly under the card that produced it. */}
        {result && (
          <AiResultCard
            title="Visit summary"
            subtitle={`${result.visitCount} visit${result.visitCount === 1 ? "" : "s"} · ${from} → ${to}`}
            text={result.summary}
          />
        )}

        {/* ── Draft customer email ─────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Draft customer email"
            subtitle="Reads this customer's lawn history and writes the email"
          />

          {/* No "out of actions" banner here on purpose — the quota is shared
              with the summarize card above, which already shows it. Repeating
              it would warn twice about one allowance. The controls below are
              still disabled when exhausted. */}

          <FormGrid columns={2}>
            <FormField label="Customer" htmlFor="email-customer" required>
              <Select
                id="email-customer"
                value={emailCustomerId}
                onChange={(e) => pickEmailCustomer(e.target.value)}
                disabled={drafting || exhausted}
              >
                <option value="">Select a customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="Email type"
              htmlFor="email-type"
              hint={
                upsellBlocked
                  ? "Customer hasn't opted into marketing — pick another type."
                  : undefined
              }
            >
              <Select
                id="email-type"
                value={emailType}
                onChange={(e) => setEmailType(e.target.value as CustomerEmailType)}
                disabled={drafting || exhausted}
              >
                <option value="season_recap">Season recap</option>
                <option value="renewal">Renewal reminder</option>
                <option value="check_in">Check-in / follow-up</option>
                <option value="upsell" disabled={upsellBlocked}>
                  Service recommendation
                </option>
              </Select>
            </FormField>

            <div className="grid grid-cols-2 gap-2 lg:col-span-2">
              <FormField label="History from" htmlFor="email-from">
                <input
                  id="email-from"
                  type="date"
                  value={emailFrom}
                  max={emailTo || undefined}
                  onChange={(e) => setEmailFrom(e.target.value)}
                  disabled={drafting || exhausted}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base bg-white disabled:bg-gray-50"
                />
              </FormField>
              <FormField label="History to" htmlFor="email-to">
                <input
                  id="email-to"
                  type="date"
                  value={emailTo}
                  min={emailFrom || undefined}
                  onChange={(e) => setEmailTo(e.target.value)}
                  disabled={drafting || exhausted}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base bg-white disabled:bg-gray-50"
                />
              </FormField>
            </div>
          </FormGrid>

          <div className="mt-4 flex items-center gap-3">
            <Button type="button" onClick={draftEmail} disabled={drafting || exhausted}>
              {drafting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              {drafting ? "Drafting…" : "Draft email"}
            </Button>
            <p className="text-xs text-gray-400">Uses 1 AI action</p>
          </div>
        </Card>

        {/* Not enough history: the route returns a reason and consumes no
            action, so this is informational only — no copy/mailto. */}
        {draft && !draft.draftable && (
          <Card>
            <CardHeader title="Not enough history" subtitle={draft.customerName} />
            <p className="text-sm text-gray-600">{draft.body}</p>
          </Card>
        )}

        {draft && draft.draftable && (
          <Card>
            <CardHeader
              title="Draft email"
              subtitle={`${draft.customerName} · ${draft.visitCount} visit${
                draft.visitCount === 1 ? "" : "s"
              } in range`}
            />

            <div className="space-y-3">
              <FormField label="Subject" htmlFor="email-subject">
                <input
                  id="email-subject"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base bg-white"
                />
              </FormField>

              <FormField label="Body" htmlFor="email-body">
                <textarea
                  id="email-body"
                  rows={10}
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base bg-white"
                />
              </FormField>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={copyDraft}>
                  {copied ? (
                    <>
                      <Check className="w-4 h-4" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      Copy
                    </>
                  )}
                </Button>

                {draft.customerEmail ? (
                  <a
                    href={mailtoHref}
                    className={buttonClasses("secondary", "sm")}
                  >
                    <Mail className="w-4 h-4" />
                    Open in email
                  </a>
                ) : (
                  <p className="text-xs text-gray-400">
                    No email on file — use Copy instead
                  </p>
                )}
              </div>
            </div>
          </Card>
        )}
        </>
      )}
    </div>
  );
}
