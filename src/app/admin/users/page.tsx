"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import { HardHat, Building2, ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";

export default function NewUserPage() {
  const router = useRouter();
  const [role, setRole] = useState<"crew" | "customer">("crew");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        full_name: fullName || null,
        role,
        customer_name: role === "customer" ? customerName : null,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Failed to create user");
      setLoading(false);
      return;
    }

    toast.success(`Created ${role}: ${email}`);
    setEmail("");
    setPassword("");
    setFullName("");
    setCustomerName("");
    setLoading(false);

    // Auto-navigate back to dashboard after a brief delay so user sees the success message
    setTimeout(() => {
      router.push("/dashboard");
    }, 800);
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
          Add User
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md mx-auto p-4">
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg p-4 shadow-sm space-y-4"
        >
          <div className="flex bg-gray-100 rounded-lg p-1">
            <button
              type="button"
              onClick={() => setRole("crew")}
              className={`flex-1 py-2 rounded-md text-sm font-medium flex items-center justify-center gap-2 ${
                role === "crew" ? "bg-white shadow text-gray-900" : "text-gray-600"
              }`}
            >
              <HardHat className="w-4 h-4" />
              Crew
            </button>
            <button
              type="button"
              onClick={() => setRole("customer")}
              className={`flex-1 py-2 rounded-md text-sm font-medium flex items-center justify-center gap-2 ${
                role === "customer" ? "bg-white shadow text-gray-900" : "text-gray-600"
              }`}
            >
              <Building2 className="w-4 h-4" />
              Customer
            </button>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Full Name</span>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              placeholder="Jane Doe"
            />
          </label>

          {role === "customer" && (
            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Company Name
              </span>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
                placeholder="Acme Construction"
              />
            </label>
          )}

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="off"
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              placeholder="user@example.com"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Temporary Password
            </span>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              placeholder="min. 6 characters"
            />
            <span className="text-xs text-gray-500 mt-1 block">
              User can change this after signing in (later).
            </span>
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="w-5 h-5 animate-spin" />}
            {loading ? "Creating..." : `Add ${role === "crew" ? "Crew Member" : "Customer"}`}
          </button>
        </form>
      </main>

      <BottomNav />
    </div>
  );
}