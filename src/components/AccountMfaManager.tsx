"use client";

import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, ShieldOff, Copy } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";

type ViewState = "loading" | "disabled" | "enrolling" | "enabled";

// Self-service TOTP (authenticator-app) MFA enrollment/disable, following
// Supabase's documented enroll -> challenge -> verify flow exactly. Free —
// this is the TOTP MFA API specifically, not the paid phone/SMS add-on (see
// docs.supabase.com/guides/auth/auth-mfa/totp: "free to use... enabled on
// all Supabase projects by default").
export default function AccountMfaManager() {
  const supabase = createClient();
  const toast = useToast();

  const [view, setView] = useState<ViewState>("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) {
      toast.error("Could not load two-factor status");
      setView("disabled");
      return;
    }
    const verified = data.totp.find((f) => f.status === "verified");
    if (verified) {
      setFactorId(verified.id);
      setView("enabled");
    } else {
      setFactorId(null);
      setView("disabled");
    }
  }

  useEffect(() => {
    // refresh() setState's after an await, not synchronously during render --
    // the standard "fetch on mount" pattern already used by CustomerMessages/
    // AccountingConnectButton in this codebase.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startEnroll() {
    setBusy(true);
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    setBusy(false);
    if (error || !data) {
      toast.error(error?.message ?? "Could not start enrollment");
      return;
    }
    setFactorId(data.id);
    setQrCode(data.totp.qr_code);
    setSecret(data.totp.secret);
    setCode("");
    setView("enrolling");
  }

  async function cancelEnroll() {
    // Clean up the half-enrolled (unverified) factor rather than leaving it
    // dangling — Supabase doesn't auto-expire it.
    if (factorId) {
      await supabase.auth.mfa.unenroll({ factorId }).catch(() => {});
    }
    setFactorId(null);
    setQrCode(null);
    setSecret(null);
    setCode("");
    setView("disabled");
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({
      factorId,
    });
    if (chErr || !challenge) {
      setBusy(false);
      toast.error(chErr?.message ?? "Could not verify — try again");
      return;
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    setBusy(false);
    if (verifyErr) {
      toast.error(verifyErr.message || "Invalid code — try again");
      setCode("");
      return;
    }
    toast.success("Two-factor authentication enabled");
    setQrCode(null);
    setSecret(null);
    setCode("");
    await refresh();
  }

  async function disable() {
    if (!factorId) return;
    if (!confirm("Disable two-factor authentication on your account?")) return;
    setBusy(true);
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    setBusy(false);
    if (error) {
      toast.error(error.message || "Could not disable — try again");
      return;
    }
    toast.success("Two-factor authentication disabled");
    await refresh();
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h2 className="text-lg font-medium text-gray-900">
        Two-factor authentication
      </h2>
      <p className="mt-1 text-sm text-gray-500">
        Add an authenticator app (Google Authenticator, Authy, 1Password) as a
        second step when you sign in.
      </p>

      {view === "loading" && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      )}

      {view === "disabled" && (
        <button
          type="button"
          onClick={startEnroll}
          disabled={busy}
          className="mt-4 flex items-center gap-2 bg-brand text-white px-4 py-2.5 rounded-lg font-semibold text-sm active:bg-brand-dark disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
          Enable two-factor authentication
        </button>
      )}

      {view === "enabled" && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            Two-factor authentication is enabled.
          </div>
          <button
            type="button"
            onClick={disable}
            disabled={busy}
            className="flex items-center gap-2 text-sm text-red-600 font-medium disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldOff className="w-4 h-4" />}
            Disable two-factor authentication
          </button>
        </div>
      )}

      {view === "enrolling" && qrCode && (
        <form onSubmit={confirmEnroll} className="mt-4 space-y-4">
          <div className="text-center">
            {/* Supabase returns the QR as inline SVG markup; render it as an
                <img> via a data URL rather than dangerouslySetInnerHTML. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(qrCode)}`}
              alt="Scan with your authenticator app"
              className="mx-auto w-48 h-48 border border-gray-200 rounded-lg p-2"
            />
          </div>
          {secret && (
            <div className="text-center">
              <p className="text-xs text-gray-500">Can&apos;t scan? Enter this code manually:</p>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(secret).catch(() => {});
                  toast.success("Copied");
                }}
                className="mt-1 inline-flex items-center gap-1.5 font-mono text-sm bg-gray-100 px-2.5 py-1 rounded"
              >
                {secret}
                <Copy className="w-3.5 h-3.5 text-gray-400" />
              </button>
            </div>
          )}
          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Enter the 6-digit code from your app
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              required
              minLength={6}
              maxLength={6}
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base text-center tracking-[0.5em] font-mono"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={cancelEnroll}
              disabled={busy}
              className="flex-1 border border-gray-300 text-gray-700 py-2.5 rounded-lg font-semibold text-sm disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="flex-1 bg-brand text-white py-2.5 rounded-lg font-semibold text-sm active:bg-brand-dark disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Enable
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
