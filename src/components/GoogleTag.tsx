"use client";

import Script from "next/script";

// Loads Google's gtag.js sitewide, gated entirely on NEXT_PUBLIC_GOOGLE_ADS_ID
// being set. Renders nothing until that env var exists, so this is a true
// no-op today (no Google Ads account yet) and turns on by setting one env var
// once Phase 2 launches — see GOOGLE_ADS_PHASE2_CAMPAIGN.md Section 0.
//
// NEXT_PUBLIC_GOOGLE_ADS_ID is the Google Ads account id, e.g. "AW-123456789"
// (found in Google Ads under Tools > Conversions > the account's tag). Firing
// the actual signup CONVERSION (not just this base tag) happens separately in
// src/lib/gtag.ts, called from SignupForm.tsx on successful signup.
export default function GoogleTag() {
  const id = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID;
  if (!id) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${id}`}
        strategy="afterInteractive"
      />
      <Script id="gtag-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${id}');
        `}
      </Script>
    </>
  );
}
