"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Loader2, ShieldCheck } from "lucide-react";
import { useToast } from "@/components/Toast";
import { BRAND } from "@/lib/brand";
import { isLawn } from "@/lib/variant";
import { needsMfaChallenge } from "@/lib/mfaGate";

// Step-up screen shown right after a password/magic-link sign-in when the
// account has a verified TOTP factor enrolled but this session hasn't
// verified it yet (aal1 -> aal2). Reached from /login (handleLogin + the
// implicit-flow fragment handler) and /auth/callback -- all three redirect
// here with ?next=<where they were headed> instead of completing sign-in
// directly, per needsMfaChallenge() in src/lib/mfaGate.ts.
function ChallengeForm() {
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp.get("next") || (isLawn() ? "/lawn" : "/dashboard");

  // "checking" = resolving whether a challenge is even needed (guards against
  // someone bookmarking/refreshing this URL after already stepping up, or
  // arriving with no session at all). "ready" = factor + challenge resolved,
  // waiting on the code. code entry.
  const [status, setStatus] = useState<"checking" | "ready" | "error">("checking");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        router.replace("/login");
        return;
      }
      if (!(await needsMfaChallenge(supabase))) {
        // Already stepped up (or nothing enrolled) -- nothing to challenge,
        // don't strand the user on this screen.
        router.replace(next);
        return;
      }
      const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
      const totp = factors?.totp?.[0];
      if (cancelled) return;
      if (listErr || !totp) {
        setStatus("error");
        return;
      }
      // A challenge is created fresh in handleVerify (not here) so it can't
      // go stale while the user is still typing their code.
      setFactorId(totp.id);
      setStatus("ready");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setVerifying(true);
    // A fresh challenge per attempt (matches Supabase's own documented
    // pattern) -- avoids reusing one that expired while the user was typing.
    const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
    if (chErr || !ch) {
      toast.error(chErr?.message ?? "Could not start a verification challenge");
      setVerifying(false);
      return;
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: ch.id,
      code: code.trim(),
    });
    setVerifying(false);
    if (verifyErr) {
      toast.error(verifyErr.message || "Invalid code — try again");
      setCode("");
      return;
    }
    toast.success("Verified");
    router.replace(next);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white p-6 rounded-lg shadow-sm space-y-4">
        <div className="text-center mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={BRAND.logoPath}
            alt={BRAND.company}
            width={260}
            height={72}
            className="mx-auto mb-1"
          />
          <p className="text-xs text-gray-500 mt-1">Two-factor verification</p>
        </div>

        {status === "checking" && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        )}

        {status === "error" && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
            Couldn&apos;t start a verification challenge. Try signing in again, or
            contact support if this keeps happening.
          </div>
        )}

        {status === "ready" && (
          <form onSubmit={handleVerify} className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <ShieldCheck className="w-5 h-5 text-brand shrink-0" />
              <span>Enter the 6-digit code from your authenticator app.</span>
            </div>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Code</span>
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
            <button
              type="submit"
              disabled={verifying || code.length !== 6}
              className="w-full bg-brand text-white py-3 rounded-lg font-semibold active:bg-brand-dark disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {verifying && <Loader2 className="w-4 h-4 animate-spin" />}
              {verifying ? "Verifying..." : "Verify"}
            </button>
          </form>
        )}

        <button
          type="button"
          onClick={handleSignOut}
          className="block w-full text-center text-sm text-gray-500 active:text-gray-700"
        >
          Not you? Sign out
        </button>
      </div>
    </main>
  );
}

export default function MfaChallengePage() {
  return (
    <Suspense>
      <ChallengeForm />
    </Suspense>
  );
}
