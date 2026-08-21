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
  Crown,
  Megaphone,
  Calculator,
} from "lucide-react";
import { useToast } from "@/components/Toast";
import { isLawn } from "@/lib/variant";

type Role =
  | "crew"
  | "superintendent"
  | "project_manager"
  | "office"
  | "sales"
  | "accountant"
  | "customer"
  | "admin";

type RoleOption = {
  value: Role;
  label: string;
  icon: typeof HardHat;
  hint: string;
};

const ALL_OPTIONS: RoleOption[] = [
  { value: "crew", label: "Crew", icon: HardHat, hint: "Field worker" },
  {
    value: "superintendent",
    label: "Superintendent",
    icon: ClipboardList,
    hint: "Runs the site — daily logs, crew time, punch",
  },
  {
    value: "project_manager",
    label: "Project Manager",
    icon: ShieldCheck,
    hint: "Schedule, permits, contracts, pricing",
  },
  { value: "office", label: "Office", icon: Users, hint: "Full access" },
  { value: "sales", label: "Sales", icon: Megaphone, hint: "Estimates & pipeline" },
  {
    value: "accountant",
    label: "Accountant",
    icon: Calculator,
    hint: "Read-only financials",
  },
  { value: "admin", label: "Admin", icon: Crown, hint: "Org owner — manages users + org" },
  { value: "customer", label: "Customer", icon: Building2, hint: "Client portal" },
];

// Roles each caller role may create (mirrors /api/users canCreate).
// office may create field + sales + client roles (no office, no admin, no
// accountant — accountant is a sensitive financial role, admin-only).
function optionsFor(callerRole: string): RoleOption[] {
  let opts: RoleOption[];
  if (callerRole === "super_admin") {
    opts = ALL_OPTIONS;
  } else if (callerRole === "admin") {
    // admin may create admin (and every other assignable role)
    opts = ALL_OPTIONS;
  } else {
    // office: field + sales + client roles only (no office, no admin, no accountant)
    opts = ALL_OPTIONS.filter((o) =>
      ["crew", "superintendent", "project_manager", "sales", "customer"].includes(o.value)
    );
  }
  // Superintendent is a construction field-mgmt role (daily logs, punch,
  // submittals, time approval) with no lawn analogue — lawn field work is
  // just `crew`. Hide it on the lawn deploy so the picker matches the
  // /api/users canCreate gate (which also blocks it for lawn).
  if (isLawn()) opts = opts.filter((o) => o.value !== "superintendent");
  return opts;
}

export default function NewUserForm({
  callerRole,
  orgId,
  orgs,
}: {
  callerRole: string;
  orgId: string | null;
  orgs: { id: string; name: string }[];
}) {
  const router = useRouter();
  const isSuperAdmin = callerRole === "super_admin";
  const options = optionsFor(callerRole);
  // super_admin only provisions office helpers (analytics support) — no role
  // picker, no field/customer/admin roles. The form below hides the role
  // selector entirely for super_admin and locks role to "office".
  const [role, setRole] = useState<Role>(
    isSuperAdmin ? "office" : options[0]?.value ?? "crew"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [targetOrgId, setTargetOrgId] = useState<string>(
    orgs[0]?.id ?? orgId ?? ""
  );
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
        // super_admin must target an org; office/admin ignore this (forced server-side).
        organization_id: callerRole === "super_admin" ? targetOrgId : undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Failed to create user");
      setLoading(false);
      return;
    }

    toast.success(
      isSuperAdmin ? `Added office worker: ${email}` : `Created ${role}: ${email}`
    );
    setEmail("");
    setPassword("");
    setFullName("");
    setCustomerName("");
    setLoading(false);

    setTimeout(() => {
      router.push("/dashboard");
    }, 800);
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
          {isSuperAdmin ? "Add Office Worker" : "Add User"}
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg p-4 shadow-sm space-y-4"
        >
          {/* super_admin only adds office helpers (analytics support) — no role
              buffet. A locked banner replaces the role picker so the form is
              just org + name + email + password. */}
          {isSuperAdmin ? (
            <div className="flex items-center gap-3 px-3 py-3 rounded-lg border border-blue-200 bg-blue-50">
              <Users className="w-5 h-5 flex-shrink-0 text-blue-600" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-blue-700">
                  Office worker
                </p>
                <p className="text-xs text-blue-600">
                  Added to the org below to help with analytics &amp; office work.
                </p>
              </div>
            </div>
          ) : (
          <div>
            <span className="text-sm font-medium text-gray-700 block mb-2">
              Role
            </span>
            <div className="space-y-2">
              {options.map((opt) => {
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
                {isLawn()
                  ? "Crew members cannot view customer info."
                  : "Crew members cannot view subcontractor or customer info."}
              </p>
            )}
          </div>
          )}

          {/* super_admin picks the target org */}
          {callerRole === "super_admin" && orgs.length > 0 && (
            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Organization
              </span>
              <select
                value={targetOrgId}
                onChange={(e) => setTargetOrgId(e.target.value)}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          )}

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
              : isSuperAdmin
                ? "Add Office Worker"
                : `Add ${options.find((o) => o.value === role)?.label ?? "User"}`}
          </button>
        </form>
      </main>
    </div>
  );
}