import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { LEGAL_ENTITY, SUPPORT_EMAIL, LEGAL_LAST_UPDATED } from "@/lib/legal";

// Public, static legal page — no auth required. Content reflects the ACTUAL
// third-party processors and data flows in this codebase as of 2026-08-27
// (Supabase, Stripe, Google Maps, Resend, Twilio, Anthropic, Sentry, Vercel,
// Google Ads once activated) rather than generic boilerplate. This is a
// good-faith first draft, not legal advice — see the note in
// GOOGLE_ADS_PHASE2_CAMPAIGN.md / conversation history: have an actual
// attorney review before relying on this for compliance.
const supportEmail = SUPPORT_EMAIL;
const lastUpdated = LEGAL_LAST_UPDATED;

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-white">
      <header className="border-b border-gray-100">
        <div className="max-w-3xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={BRAND.logoPath} alt={BRAND.company} className="h-8 w-auto" />
          </Link>
          <Link href="/" className="text-sm text-gray-600 hover:text-gray-900">
            Back home
          </Link>
        </div>
      </header>

      <article className="max-w-3xl mx-auto px-4 py-12">
        <h1 className="text-3xl font-bold text-gray-900">Privacy policy</h1>
        <p className="mt-2 text-sm text-gray-500">Last updated: {lastUpdated}</p>

        <p className="mt-6 text-gray-700">
          {LEGAL_ENTITY} (&quot;we,&quot; &quot;us&quot;) operates this
          software as a service under the name {BRAND.company}. This policy
          explains what data we collect, why, and who else touches it.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Information we collect</h2>
        <p className="mt-3 text-gray-700">
          <strong>Account information.</strong> When you sign up, we collect
          your business name, your name, your email address, and a password
          (stored as a salted hash by our authentication provider — we never
          see or store the plaintext password).
        </p>
        <p className="mt-3 text-gray-700">
          <strong>Business data you enter.</strong> Running your business
          through this platform means you (and anyone you invite) enter data
          about your own customers and operations — names, emails, phone
          numbers, service addresses, job/estimate/invoice details, before/after
          photos (which may include GPS location metadata), and crew member
          information. This data belongs to you; we process it on your behalf
          to provide the service.
        </p>
        <p className="mt-3 text-gray-700">
          <strong>Location data.</strong> Property addresses and map
          coordinates are used for scheduling, the property-boundary
          measurement tool, and route optimization.
        </p>
        <p className="mt-3 text-gray-700">
          <strong>Payment information.</strong> If you subscribe to a paid
          plan, billing is handled entirely by Stripe — we do not store your
          card number. If you use this platform to accept payments from your
          own customers, that also runs through Stripe (Stripe Connect); we
          never hold your customers&apos; funds directly.
        </p>
        <p className="mt-3 text-gray-700">
          <strong>Usage and campaign data.</strong> If you arrive from a
          tagged link (for example, a search ad), we record which campaign
          referred you (utm_source, utm_medium, utm_campaign, and similar
          parameters) so we know which channels are working. We also collect
          standard technical data — pages visited, general performance
          metrics, and error reports — to keep the service running.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Who else processes this data</h2>
        <p className="mt-3 text-gray-700">
          We use a small number of third-party service providers (subprocessors)
          to run the platform. Each only receives the data it needs to perform
          its function:
        </p>
        <ul className="mt-3 list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Supabase</strong> — database, authentication, and file storage for all account and business data.</li>
          <li><strong>Stripe</strong> — subscription billing, and (if enabled) payment processing between you and your own customers.</li>
          <li><strong>Google Maps Platform</strong> — address lookup, the property-measurement tool, and route optimization.</li>
          <li><strong>Resend</strong> — delivery of transactional emails (account verification, notifications).</li>
          <li><strong>Twilio</strong> — delivery of transactional SMS, if your organization enables text notifications.</li>
          <li><strong>Anthropic</strong> — powers optional AI features (drafting customer emails, summarizing visit history) that your office staff can choose to use.</li>
          <li><strong>Sentry</strong> — error monitoring, so we notice and fix bugs.</li>
          <li><strong>Vercel</strong> — application hosting and aggregate performance analytics.</li>
          <li><strong>Google Ads</strong> — if we&apos;re running search ads, Google receives standard conversion data (that a signup happened) when you sign up after clicking an ad. No account data is shared with Google.</li>
          <li>
            <strong>Accounting providers (QuickBooks and similar)</strong> — only
            if you explicitly connect one from your billing settings, to sync
            your customers and invoices.
          </li>
        </ul>
        <p className="mt-3 text-gray-700">
          We don&apos;t sell your data, and we don&apos;t share it with anyone
          outside this list except where required by law.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Cookies and local storage</h2>
        <p className="mt-3 text-gray-700">
          We use essential cookies to keep you signed in. We use your
          browser&apos;s session storage (not a tracking cookie, and not
          shared across sites) to remember which campaign link you arrived on,
          for the duration of your visit. If Google Ads conversion tracking is
          active, Google may set its own cookie for that purpose — see
          Google&apos;s own privacy policy for how it handles that data.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Data retention and deletion</h2>
        <p className="mt-3 text-gray-700">
          We retain your account and business data for as long as your account
          is active. You can request deletion of your account and its data at
          any time by emailing{" "}
          <a href={`mailto:${supportEmail}`} className="text-brand hover:underline">
            {supportEmail}
          </a>
          . Some records (for example, billing history) may be retained longer
          where we&apos;re required to by law.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Your rights</h2>
        <p className="mt-3 text-gray-700">
          You can request access to, correction of, or deletion of your
          personal data by contacting us at{" "}
          <a href={`mailto:${supportEmail}`} className="text-brand hover:underline">
            {supportEmail}
          </a>
          .
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Children&apos;s privacy</h2>
        <p className="mt-3 text-gray-700">
          This service is intended for business use and is not directed at
          children. We do not knowingly collect personal data from anyone
          under 13.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">International users</h2>
        <p className="mt-3 text-gray-700">
          This service is operated in the United States, and data is stored
          and processed in the United States. If you access the service from
          outside the US, your information will be transferred to and
          processed in the US.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Changes to this policy</h2>
        <p className="mt-3 text-gray-700">
          If we make material changes to this policy, we&apos;ll update the
          date at the top of this page.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Contact</h2>
        <p className="mt-3 text-gray-700">
          Questions about this policy?{" "}
          <a href={`mailto:${supportEmail}`} className="text-brand hover:underline">
            {supportEmail}
          </a>
        </p>
      </article>
    </main>
  );
}
