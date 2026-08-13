import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import SignupForm from "./SignupForm";

// Server component — reads the SAAS_OPEN env flag so the page reflects the
// actual signup state. When closed, it shows an intentional "invitation-only"
// panel instead of a functional-looking form that fails on submit (which read
// as broken: "feature coming soon"). When open, it renders the client form.
export default function SignupPage() {
  const open = process.env.SAAS_OPEN === "true";

  if (!open) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm bg-white p-6 rounded-lg shadow-sm space-y-4 text-center">
          <div className="mb-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/terra-vista-logo.svg"
              alt="Terra Vista Construction Management"
              width={260}
              height={72}
              className="mx-auto mb-1"
            />
          </div>
          <h1 className="text-lg font-semibold text-gray-900">
            Signups are invitation-only
          </h1>
          <p className="text-sm text-gray-600">
            New business workspaces aren&apos;t open for self-serve signup yet.
            If you&apos;ve been invited, your admin will create your account —
            or contact support to get started.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-1 text-sm text-blue-600 active:text-blue-700"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <SignupForm />
    </main>
  );
}