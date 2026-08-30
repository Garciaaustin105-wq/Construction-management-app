import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { LEGAL_ENTITY, SUPPORT_EMAIL, LEGAL_LAST_UPDATED } from "@/lib/legal";

// Public, static legal page — no auth required. Good-faith first draft
// reflecting the actual service (see src/app/privacy/page.tsx header note) —
// NOT legal advice. Governing law is set to Florida per the LLC's state of
// registration; still worth an attorney's review before this is final.
export default function TermsOfServicePage() {
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
        <h1 className="text-3xl font-bold text-gray-900">Terms of service</h1>
        <p className="mt-2 text-sm text-gray-500">Last updated: {LEGAL_LAST_UPDATED}</p>

        <p className="mt-6 text-gray-700">
          These terms govern your use of {BRAND.company}, operated by{" "}
          {LEGAL_ENTITY} (&quot;we,&quot; &quot;us&quot;). By creating an
          account, you agree to these terms.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">The service</h2>
        <p className="mt-3 text-gray-700">
          {BRAND.company} is business-management software — scheduling,
          routing, estimating, billing, and customer/crew management — for
          service businesses. We provide the platform; you&apos;re responsible
          for the business you run through it.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Your account</h2>
        <p className="mt-3 text-gray-700">
          You must provide accurate information when you sign up and keep your
          password secure. You&apos;re responsible for all activity that
          happens under your account and any accounts you create for your
          staff or crew.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Plans and billing</h2>
        <p className="mt-3 text-gray-700">
          Some tiers are free; paid tiers are billed on a recurring basis
          through Stripe at the price shown at checkout. You can cancel a paid
          plan at any time — access continues through the end of the period
          you&apos;ve already paid for, and we don&apos;t provide refunds for
          partial periods except where required by law. Free-tier accounts
          remain subject to the usage limits described on our pricing page.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Your data</h2>
        <p className="mt-3 text-gray-700">
          You own the business and customer data you enter into the platform.
          We process it on your behalf to provide the service (see our{" "}
          <Link href="/privacy" className="text-brand hover:underline">
            Privacy Policy
          </Link>{" "}
          for detail) and don&apos;t claim ownership of it. If you connect the
          platform to your customers via email, SMS, or online booking
          features, you&apos;re responsible for having the appropriate consent
          from those customers and for complying with applicable
          communications laws (for example, TCPA and CAN-SPAM) in how you use
          those features.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Acceptable use</h2>
        <p className="mt-3 text-gray-700">
          Don&apos;t use the service for anything illegal, to send unsolicited
          bulk messages, to attempt to access another organization&apos;s
          data, or to reverse-engineer, resell, or white-label the platform
          without our written permission.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Copyright complaints (DMCA)</h2>
        <p className="mt-3 text-gray-700">
          If you believe content stored on this platform by one of our
          customers infringes your copyright, send a notice to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-brand hover:underline">
            {SUPPORT_EMAIL}
          </a>{" "}
          including: (1) a description of the copyrighted work you claim is
          infringed, (2) the specific material you want removed and where to
          find it, (3) your contact information, (4) a statement that you
          have a good-faith belief the use isn&apos;t authorized, (5) a
          statement, under penalty of perjury, that the notice is accurate
          and you&apos;re authorized to act on the copyright owner&apos;s
          behalf, and (6) your signature. We&apos;ll remove or disable access
          to material that appears to infringe and notify the customer who
          posted it. If they submit a valid counter-notice disputing the
          claim, we may restore the material and will tell you when we do.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Our intellectual property</h2>
        <p className="mt-3 text-gray-700">
          The software, design, and branding of {BRAND.company} belong to{" "}
          {LEGAL_ENTITY}. These terms don&apos;t grant you any rights to our
          intellectual property beyond using the service as intended.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Indemnification</h2>
        <p className="mt-3 text-gray-700">
          You agree to defend, indemnify, and hold {LEGAL_ENTITY} harmless
          from any claim, loss, or expense (including reasonable attorneys&apos;
          fees) arising from: your use of the service, the data or content
          you or your staff/crew enter into it, your violation of these
          terms, or your violation of any law or a third party&apos;s rights
          (for example, a dispute with your own customer over how you used
          the service to communicate with them).
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Service availability</h2>
        <p className="mt-3 text-gray-700">
          We aim to keep the service available and reliable, but we don&apos;t
          guarantee uninterrupted access. The service is provided
          &quot;as is&quot; without warranties of any kind, to the extent
          permitted by law.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Limitation of liability</h2>
        <p className="mt-3 text-gray-700">
          To the extent permitted by law, {LEGAL_ENTITY} is not liable for
          indirect, incidental, or consequential damages arising from your use
          of the service. Our total liability for any claim is limited to the
          amount you paid us in the 12 months before the claim arose.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Termination</h2>
        <p className="mt-3 text-gray-700">
          You can stop using the service and delete your account at any time.
          We may suspend or terminate accounts that violate these terms. On
          request, we&apos;ll help you export your data before deletion.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Dispute resolution: binding arbitration</h2>
        <p className="mt-3 text-gray-700">
          <strong>Please read this section carefully — it affects your legal
          rights.</strong> You and {LEGAL_ENTITY} agree to resolve any dispute
          arising from these terms or the service through binding individual
          arbitration, rather than in court, except that either side may
          bring an individual claim in small claims court, and we may seek
          injunctive relief in court to protect our intellectual property or
          prevent unauthorized access to the service.
        </p>
        <p className="mt-3 text-gray-700">
          <strong>Class action waiver.</strong> Arbitration will be on an
          individual basis. You and we each waive any right to bring or
          participate in a class, collective, or representative action, and
          waive any right to a jury trial.
        </p>
        <p className="mt-3 text-gray-700">
          <strong>How arbitration works.</strong> Arbitration will be
          administered by the American Arbitration Association under its
          Commercial Arbitration Rules, seated in Florida, before a single
          arbitrator. The arbitrator&apos;s decision is final and binding,
          enforceable in any court with jurisdiction. Each side bears its own
          attorneys&apos; fees unless the arbitrator awards them under
          applicable law.
        </p>
        <p className="mt-3 text-gray-700">
          <strong>Opting out.</strong> You can opt out of this arbitration
          agreement by emailing{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-brand hover:underline">
            {SUPPORT_EMAIL}
          </a>{" "}
          within 30 days of first creating an account, stating that you
          decline to arbitrate. Opting out doesn&apos;t affect any other part
          of these terms.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Governing law</h2>
        <p className="mt-3 text-gray-700">
          These terms are governed by the laws of the State of Florida,
          without regard to its conflict-of-laws principles. Any dispute not
          subject to arbitration above (for example, a small-claims or
          injunctive-relief matter) will be resolved in the state or federal
          courts located in Florida.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Changes to these terms</h2>
        <p className="mt-3 text-gray-700">
          If we make material changes, we&apos;ll update the date at the top
          of this page.
        </p>

        <h2 className="mt-10 text-xl font-semibold text-gray-900">Contact</h2>
        <p className="mt-3 text-gray-700">
          Questions about these terms?{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-brand hover:underline">
            {SUPPORT_EMAIL}
          </a>
        </p>
      </article>
    </main>
  );
}
