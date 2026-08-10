"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Plug, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const supabase = createClient();
  const toast = useToast();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    if (!data.session) {
      toast.error("Logged in but no session. Try again.");
      setLoading(false);
      return;
    }
    toast.success("Signed in");
    // Use a small delay so the cookie is fully set before navigation
    setTimeout(() => {
      window.location.href = "/dashboard";
    }, 200);
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <form
        onSubmit={handleLogin}
        className="w-full max-w-sm bg-white p-6 rounded-lg shadow-sm space-y-4"
      >
        <div className="text-center mb-2">
          <Plug className="w-8 h-8 text-blue-600 mx-auto mb-2" />
          <h1 className="text-xl font-bold text-gray-900">
            Construction Management App
          </h1>
          <p className="text-xs text-gray-500">Sign in to continue</p>
        </div>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
          autoComplete="email"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
          autoComplete="current-password"
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </main>
  );
}