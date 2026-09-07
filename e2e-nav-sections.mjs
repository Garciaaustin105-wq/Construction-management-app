// Lawn office sidebar grouping (src/lib/navItems.ts).
//
// Run:
//   npx tsc src/lib/navItems.ts src/lib/variant.ts src/lib/roles.ts \
//     --outDir .nav-build --module esnext --target es2022 \
//     --moduleResolution bundler --skipLibCheck
//   node fix-nav-specifiers.mjs
//   NEXT_PUBLIC_APP_VARIANT=lawn node e2e-nav-sections.mjs
//
// fix-nav-specifiers stubs lucide-react (the icons are values, so the import
// survives into the emitted JS) and rewrites the "@/lib" aliases Node cannot
// resolve.
//
// Not linted by DeepSource: .mjs files are excluded in .deepsource.toml,
// because the analyzer parses them as classic scripts and reports every
// top-level `import` as a syntax error. Running this file IS its check.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT is a nav row that belongs to no
// group. The sidebar renders ungrouped rows above the sections and grouped
// rows inside them, so a row assigned to a section that is not in NAV_SECTIONS
// renders NOWHERE — the page stays reachable by URL and simply vanishes from
// the nav, which is the kind of bug nobody files because it looks like the
// feature was never built.
const M = await import("./.nav-build/navItems.js");
const { buildNavItems, NAV_SECTIONS } = M;

let pass = 0, fail = 0;
const t = (n, c, d = "") => {
  c ? (pass++, console.log("  PASS " + n))
    : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));
};

const office = buildNavItems("admin");
const sectionIds = NAV_SECTIONS.map((s) => s.id);

console.log("[every office row has somewhere to render]");
{
  const orphans = office.filter(
    (i) => i.section !== undefined && !sectionIds.includes(i.section)
  );
  t("NO ROW POINTS AT A SECTION THAT DOES NOT EXIST", orphans.length === 0,
    orphans.map((o) => `${o.label}->${o.section}`).join(", "));

  const ungrouped = office.filter((i) => !i.section);
  t("only Home renders above the groups",
    ungrouped.length === 1 && ungrouped[0].href === "/lawn",
    ungrouped.map((u) => u.label).join(", "));

  // The real regression risk: someone adds a nav row and forgets the section,
  // and it silently joins Home at the top instead of its group.
  t("every other office row is assigned",
    office.filter((i) => i.href !== "/lawn").every((i) => !!i.section));
}

console.log("\n[nothing was lost in the regroup]");
{
  t("the office nav still has every row it had", office.length >= 30,
    `got ${office.length}`);
  const hrefs = office.map((i) => i.href);
  t("no duplicate href", new Set(hrefs).size === hrefs.length);
  for (const href of [
    "/lawn", "/lawn/jobs", "/lawn/customers", "/lawn/photos", "/lawn/completed",
    "/lawn/overdue", "/lawn/approvals", "/lawn/scheduling", "/lawn/calendar",
    "/lawn/track", "/lawn/ai", "/lawn/insights", "/lawn/labor-feedback",
    "/lawn/compliance", "/lawn/sod", "/lawn/irrigation-components",
    "/estimates", "/invoices", "/manage", "/admin/email-preview",
  ]) {
    t(`  ${href} is still in the nav`, hrefs.includes(href));
  }
}

console.log("\n[the owner's four answers]");
{
  const of = (href) => office.find((i) => i.href === href);
  // AI admin gets its OWN section rather than sitting under System, where it
  // read as an internal setting.
  t("AI admin is its own section", of("/lawn/ai").section === "ai");
  t("...and is the only thing in it",
    office.filter((i) => i.section === "ai").length === 1);
  t("Insights sits with Money", of("/lawn/insights").section === "money");
  t("Email Preview is filed under System with Account",
    of("/admin/email-preview").section === "system" &&
    of("/manage").section === "system");

  // Scheduling is the main tab and Calendar sits under it.
  const today = office.filter((i) => i.section === "today");
  t("Scheduling and Calendar are both in Today",
    today.some((i) => i.href === "/lawn/scheduling") &&
    today.some((i) => i.href === "/lawn/calendar"));
  t("SCHEDULING COMES BEFORE CALENDAR",
    today.findIndex((i) => i.href === "/lawn/scheduling") <
    today.findIndex((i) => i.href === "/lawn/calendar"));
}

console.log("\n[the two rows the regroup exists to raise]");
{
  const flatOverdue = office.findIndex((i) => i.href === "/lawn/overdue");
  const today = office.filter((i) => i.section === "today");
  t("Overdue and Approvals are both in Today",
    today.some((i) => i.href === "/lawn/overdue") &&
    today.some((i) => i.href === "/lawn/approvals"));
  // They sat at roughly positions 19 and 20 of a flat list. Their index in the
  // raw array is unchanged - what changed is that Today renders first.
  t("...and Today is the first section rendered", NAV_SECTIONS[0].id === "today");
  t("(their flat position was indeed buried)", flatOverdue > 12,
    `index ${flatOverdue}`);
}

console.log("\n[grouping is lawn-office only]");
{
  for (const role of ["crew", "superintendent"]) {
    const nav = buildNavItems(role);
    t(`${role} keeps a flat nav`, nav.every((i) => !i.section),
      nav.filter((i) => i.section).map((i) => i.label).join(", "));
    t(`  ...and it stays short`, nav.length <= 8, `got ${nav.length}`);
  }
}

console.log("\n[section order is the order of the day]");
{
  t("Today first", sectionIds[0] === "today");
  t("System last", sectionIds[sectionIds.length - 1] === "system");
  t("every section has a label", NAV_SECTIONS.every((s) => !!s.label));
  t("no duplicate section id", new Set(sectionIds).size === sectionIds.length);
  // A declared section nobody uses would render as an empty heading; the
  // sidebar filters those out, but an unused id is still dead weight.
  const used = new Set(office.map((i) => i.section).filter(Boolean));
  t("EVERY DECLARED SECTION IS USED", sectionIds.every((id) => used.has(id)),
    sectionIds.filter((id) => !used.has(id)).join(", "));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
