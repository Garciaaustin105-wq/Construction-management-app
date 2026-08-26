// Shared mobile-reflow style for email preview surfaces (the /admin/email-preview
// console + the send-flow EmailPreviewModal). Kept here so both surfaces render
// the email identically — mobile email clients (Gmail, Apple Mail, Samsung)
// override fixed-width tables with width:100% so a 560px email reflows onto a
// 375px phone. The platform's emails wrap content in a fixed width="560" card,
// so naively squeezing the iframe to 375px just crops the right edge. Injecting
// the same override the real clients apply makes the preview actually reflow.
// Injected before </head> (every render fn emits a full <html><head>…</head>).

export const MOBILE_STYLE =
  '<style>table[width="560"]{width:100%!important;max-width:100%!important;}img{max-width:100%!important;height:auto!important;}</style>';

export function withMobileStyle(html: string): string {
  if (!html) return html;
  if (html.includes("</head>")) return html.replace("</head>", `${MOBILE_STYLE}</head>`);
  return MOBILE_STYLE + html;
}