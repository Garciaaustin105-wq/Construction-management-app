"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Sparkles, Lock } from "lucide-react";
import Card, { CardHeader } from "@/components/ui/Card";
import Button, { LinkButton } from "@/components/ui/Button";
import { FormField, Select } from "@/components/ui/FormField";
import FormGrid from "@/components/ui/FormGrid";
import AiUsageMeter from "@/components/AiUsageMeter";
import AiResultCard from "@/components/AiResultCard";
import { useToast } from "@/components/Toast";
import {
  AiRequestError,
  fetchAiQuota,
  isAiDisabled,
  isAiExhausted,
  summarizeVisits,
  type AiQuota,
  type SummarizeVisitsResponse,
} from "@/lib/aiClient";

// Interactive half of /lawn/ai. The server page owns the role gate and hands
// this component only what it already read through RLS (the customer list), so
// nothing here makes an access decision. Every AI call goes through
// /api/ai/* — no LLM key, no service-role client, no quota logic in the browser.

export type CustomerOption = { id: string; name: string };

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
      )}

      {result && (
        <AiResultCard
          title="Visit summary"
          subtitle={`${result.visitCount} visit${result.visitCount === 1 ? "" : "s"} · ${from} → ${to}`}
          text={result.summary}
          actions={
            // Slice 2 wires this to /api/ai/draft-client-update. Disabled (not
            // hidden) so the office can see the feature is coming without it
            // silently doing nothing.
            <Button type="button" variant="secondary" size="sm" disabled title="Coming soon">
              Draft client update
            </Button>
          }
        />
      )}
    </div>
  );
}
