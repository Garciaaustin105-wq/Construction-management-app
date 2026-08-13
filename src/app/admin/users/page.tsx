"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  HardHat,
  Building2,
  ArrowLeft,
  Loader2,
  ClipboardList,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useToast } from "@/components/Toast";

type Role =
  | "crew"
  | "superintendent"
  | "project_manager"
  | "office"
  | "customer";

const ROLE_OPTIONS: {
  value: Role;
  label: string;
  icon: typeof HardHat;
  hint: string;
}[] = [
  { value: "crew", label: "Crew", icon: HardHat, hint: "Field worker" },
  {
    value: "superintendent",
    label: "Superintendent",
    icon: ClipboardList,
    hint: "Field supervisor",
  },
  {
    value: "project_manager",
    label: "Project Manager",
    icon: ShieldCheck,
    hint: "Manages projects",
  },
  { value: "office", label: "Office", icon: Users, hint: "Full access" },
  { value: "customer", label: "Customer", icon: Building2, hint: "Client portal" },
];

export default function NewUserPage() {
  const router = useRouter();
  const [role, setRole] = useState<Role>("crew");
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
          <div>
            <span className="text-sm font-medium text-gray-700 block mb-2">
              Role
            </span>
            <div className="space-y-2">
              {ROLE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = role === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setRole(opt.value)}
                    className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg border text-left ${
                      active
                        ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600"
                        : "border-gray-300 bg-white"
                    }`}
                  >
                    <Icon
                      className={`w-5 h-5 flex-shrink-0 ${
                        active ? "text-blue-600" : "text-gray-400"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-sm font-medium ${
                          active ? "text-blue-700" : "text-gray-900"
                        }`}
                      >
                        {opt.label}
                      </p>
                      <p className="text-xs text-gray-500">{opt.hint}</p>
                    </div>
                  </button>
                );
              })}
            </div>
            {role !== "customer" && (
              <p className="text-xs text-gray-400 mt-2">
                Crew members cannot view subcontractor or customer info.
              </p>
            )}
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
            {loading
              ? "Creating..."
              : `Add ${ROLE_OPTIONS.find((o) => o.value === role)?.label ?? "User"}`}
          </button>
        </form>
      </main>

    </div>
  );
}