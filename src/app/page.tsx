import Link from "next/link";
import {
  CheckCircle2,
  CloudRain,
  Route,
  Users,
  ClipboardList,
  FileSignature,
  Clock,
  GitBranch,
} from "lucide-react";
import { redirect } from "next/navigation";
import { getMe } from "@/lib/tenant";
import { BRAND } from "@/lib/brand";
import { isLawn } from "@/lib/variant";
import { PLAN_TIERS, PAID_TIERS } from "@/lib/plans";

// The app's root URL. A signed-in user who opens the site (e.g. a desktop
// browser pointed at "/") should land on their dashboard, not on the marketing
// page. The PWA manifest already sends mobile installs straight to /dashboard
// via start_url; this mirrors that for plain browser visits so desktop users
// aren't shown the pitch every time they open the app.
//
// Logged-out visitors get the real marketing homepage below instead of a bare
// "Sign In" screen — this is the landing spot for organic content, community
// mentions, and (eventually) paid search, so it carries the actual pitch and a
// free-tier CTA rather than just brand chrome. Copy branches on isLawn() since
// one deploy sells the lawn free tier and the other sells the construction
// trial — see src/lib/variant.ts.
export default async function HomePage() {
  const me = await getMe();
  if (me) redirect(isLawn() ? "/lawn" : "/dashboard");

  return isLawn() ? <LawnMarketing /> : <ConstructionMarketing />;
}

function formatLimit(n: number | null, unit: string): string {
  if (n === null) return `Unlimited ${unit}`;
  return `${n} ${unit}`;
}

function Nav({ ctaLabel }: { ctaLabel: string }) {
  return (
    <header className="border-b border-gray-100">
      <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={BRAND.logoPath} alt={BRAND.company} className="h-8 w-auto" />
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm text-gray-600 hover:text-gray-900">
            Sign in
          </Link>
          <Link
            href="/signup"
            className="text-sm bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-dark"
          >
            {ctaLabel}
          </Link>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-gray-100 py-8">
      <div className="max-w-5xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-gray-500">
        <span>
          &copy; {new Date().getFullYear()} {BRAND.company}
        </span>
        <Link href="/login" className="hover:text-gray-800">
          Sign in
        </Link>
      </div>
    </footer>
  );
}

function LawnMarketing() {
  const free = PLAN_TIERS.free;
  const paid = PAID_TIERS.map((t) => PLAN_TIERS[t]);

  const features = [
    {
      icon: CheckCircle2,
      title: "Free means free",
      body: "A genuinely free tier — real scheduling, routing, and billing. No card to start, no trial clock ticking down.",
    },
    {
      icon: CloudRain,
      title: "Built for how weather runs your week",
      body: "Weather-aware scheduling flags and reschedules affected visits automatically, so a rainout doesn't mean redoing the week by hand.",
    },
    {
      icon: Route,
      title: "Smarter routes, not just a map",
      body: "Real route optimization plans your crews' day — fewer miles on the odometer, more stops before dark.",
    },
    {
      icon: Users,
      title: "You don't pay for every hand that touches a job",
      body: "No-login, scheduling-only crew members let you run a real crew without buying a paid seat for every mower operator.",
    },
  ];

  return (
    <main className="min-h-screen bg-white">
      <Nav ctaLabel="Start free" />

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 pt-16 pb-14 text-center">
        <span className="inline-block bg-brand-bg text-brand-dark text-xs font-semibold px-3 py-1 rounded-full mb-5">
          No credit card required
        </span>
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 max-w-2xl mx-auto">
          Run your lawn care business without the spreadsheet — free, for real.
        </h1>
        <p className="mt-4 text-gray-600 max-w-xl mx-auto">
          Scheduling, routing, and billing for solo operators and small crews.
          Start on a free tier that stays free — upgrade only when you outgrow it.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link
            href="/signup"
            className="bg-brand text-white px-6 py-3 rounded-lg font-semibold hover:bg-brand-dark"
          >
            Start free
          </Link>
          <Link
            href="/login"
            className="px-6 py-3 rounded-lg font-semibold text-gray-700 border border-gray-300 hover:bg-gray-50"
          >
            Sign in
          </Link>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-5xl mx-auto px-4 py-14 border-t border-gray-100 scroll-mt-16">
        <div className="grid sm:grid-cols-2 gap-8">
          {features.map((f) => (
            <div key={f.title} className="flex gap-4">
              <div className="shrink-0 w-10 h-10 rounded-lg bg-brand-bg flex items-center justify-center">
                <f.icon className="w-5 h-5 text-brand-dark" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">{f.title}</h3>
                <p className="mt-1 text-sm text-gray-600">{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-5xl mx-auto px-4 py-14 border-t border-gray-100 scroll-mt-16">
        <h2 className="text-2xl font-bold text-gray-900 text-center">
          Straightforward pricing
        </h2>
        <p className="mt-2 text-gray-600 text-center">
          Start free. Upgrade only when your crew or customer list outgrows it.
        </p>
        <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border-2 border-brand p-5 flex flex-col">
            <h3 className="font-semibold text-gray-900">{free.label}</h3>
            <p className="mt-1 text-2xl font-bold text-gray-900">$0</p>
            <p className="text-sm text-gray-500 mb-4">{free.blurb}</p>
            <ul className="text-sm text-gray-600 space-y-1 mt-auto">
              <li>{formatLimit(free.maxCustomers, "customers")}</li>
              <li>{formatLimit(free.maxCrewMembers, "crew members")}</li>
              <li>{formatLimit(free.maxUsers, "app seats")}</li>
            </ul>
          </div>
          {paid.map((tier) => (
            <div key={tier.label} className="rounded-xl border border-gray-200 p-5 flex flex-col">
              <h3 className="font-semibold text-gray-900">{tier.label}</h3>
              <p className="mt-1 text-2xl font-bold text-gray-900">
                ${tier.priceMonthly}
                <span className="text-sm font-normal text-gray-500">/mo</span>
              </p>
              <p className="text-sm text-gray-500 mb-4">{tier.blurb}</p>
              <ul className="text-sm text-gray-600 space-y-1 mt-auto">
                <li>{formatLimit(tier.maxCustomers, "customers")}</li>
                <li>{formatLimit(tier.maxCrewMembers, "crew members")}</li>
                <li>{formatLimit(tier.maxUsers, "app seats")}</li>
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 text-center">
          <Link
            href="/signup"
            className="inline-block bg-brand text-white px-6 py-3 rounded-lg font-semibold hover:bg-brand-dark"
          >
            Start free
          </Link>
        </div>
      </section>

      <Footer />
    </main>
  );
}

function ConstructionMarketing() {
  const features = [
    {
      icon: ClipboardList,
      title: "One record, field to office",
      body: "Daily logs and RFIs sync from the field the moment they're created — no more waiting on an end-of-day recap.",
    },
    {
      icon: GitBranch,
      title: "Change orders that don't get lost in email",
      body: "Change orders and submittals move through review and approval in the app, with a clear history of who signed off and when.",
    },
    {
      icon: Clock,
      title: "Crew time tracking built in",
      body: "Punch clock and time tracking tied directly to jobs and cost codes — no separate timesheet app to reconcile.",
    },
    {
      icon: FileSignature,
      title: "Estimates and invoices, e-signed",
      body: "Send client-ready estimates and invoices and collect an e-signature without printing a thing.",
    },
  ];

  return (
    <main className="min-h-screen bg-white">
      <Nav ctaLabel="Start free trial" />

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 pt-16 pb-14 text-center">
        <span className="inline-block bg-brand-bg text-brand-dark text-xs font-semibold px-3 py-1 rounded-full mb-5">
          30-day free trial — no credit card required
        </span>
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 max-w-2xl mx-auto">
          Field-to-office construction management, without the busywork.
        </h1>
        <p className="mt-4 text-gray-600 max-w-xl mx-auto">
          Daily logs, RFIs, submittals, change orders, and punch lists — synced
          from the field to the office in real time.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link
            href="/signup"
            className="bg-brand text-white px-6 py-3 rounded-lg font-semibold hover:bg-brand-dark"
          >
            Start free trial
          </Link>
          <Link
            href="/login"
            className="px-6 py-3 rounded-lg font-semibold text-gray-700 border border-gray-300 hover:bg-gray-50"
          >
            Sign in
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-4 py-14 border-t border-gray-100">
        <div className="grid sm:grid-cols-2 gap-8">
          {features.map((f) => (
            <div key={f.title} className="flex gap-4">
              <div className="shrink-0 w-10 h-10 rounded-lg bg-brand-bg flex items-center justify-center">
                <f.icon className="w-5 h-5 text-brand-dark" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">{f.title}</h3>
                <p className="mt-1 text-sm text-gray-600">{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-4 pb-14 text-center">
        <Link
          href="/signup"
          className="inline-block bg-brand text-white px-6 py-3 rounded-lg font-semibold hover:bg-brand-dark"
        >
          Start your free trial
        </Link>
      </div>

      <Footer />
    </main>
  );
}
