"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ArrowLeft } from "lucide-react";
import { useToast } from "@/components/Toast";
import Link from "next/link";

// Public self-serve signup: a new business owner creates their organization
// and becomes its admin. The actual org + admin creation happens server-side
// in /api/signup (service role, env-gated by SAAS_OPEN).
export default function SignupPage() {
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const res = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        business_name: businessName,
        full_name: fullName,
        email,
        password,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Sign up failed");
      setLoading(false);
      return;
    }

    toast.success("Account created — sign in with your new credentials.");
    setLoading(false);
    setTimeout(() => router.push("/login"), 900);
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-white p-6 rounded-lg shadow-sm space-y-4"
      >
        <div className="text-center mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/terra-vista-logo.svg"
            alt="Terra Vista Construction Management"
            width={260}
            height={72}
            className="mx-auto mb-1"
          />
          <p className="text-xs text-gray-500 mt-1">
            Create your business workspace
          </p>
        </div>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">
            Business name
          </span>
          <input
            type="text"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            required
            placeholder="Acme Electrical"
            className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Your name</span>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            placeholder="Jane Doe"
            className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@business.com"
            className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="min. 8 characters"
            className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
          />
        </label>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          {loading ? "Creating your workspace..." : "Create workspace"}
        </button>

        <Link
          href="/login"
          className="block text-center text-sm text-blue-600 active:text-blue-700 flex items-center justify-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to sign in
        </Link>
      </form>
    </main>
  );
}