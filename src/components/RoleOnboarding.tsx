"use client";
import { useEffect, useState } from "react";
import { X, Compass } from "lucide-react";

type Variant = "construction" | "lawn";

const CONTENT: Record<string, { subtitle: string; bullets: string[] }> = {
  "construction:crew": {
    subtitle: "Field crew — capture the day",
    bullets: [
      "Tap **Time** to clock in at the job and pick the cost code.",
      "Tap **Photos** to snap before/after shots of your work.",
      "Tap **Daily Log** at the end of the day to record what got done.",
      "Tap **Punch** to log an item that needs fixing.",
    ],
  },
  "construction:superintendent": {
    subtitle: "Superintendent — run the site",
    bullets: [
      "**Time** shows the crew's week — review and approve hours.",
      "**Daily Logs** and **Punch** let you close items from the field.",
      "**Change Orders** show what's changed on your site.",
    ],
  },
  "construction:project_manager": {
    subtitle: "Project Manager — run jobs end-to-end",
    bullets: [
      "**Daily Logs / Punch / Change Orders / Submittals / Receipts** keep field and office in sync.",
      "**Reports** and **Insights** show margin per job.",
    ],
  },
  "construction:office": {
    subtitle: "Office — the back office",
    bullets: [
      "Create estimates, send invoices, manage customers and subs.",
      "**Reports** and **Insights** are your command center.",
      "**Client Portal** invites let customers approve and sign online.",
    ],
  },
  "construction:sales": {
    subtitle: "Sales — own the pre-sale funnel",
    bullets: [
      "**New Estimate** is your starting point.",
      "**Customers** are your leads.",
      "**Insights** shows what's open and aging. No invoices or billing here.",
    ],
  },
  "construction:accountant": {
    subtitle: "Accountant — read-only financials",
    bullets: [
      "Read-only: **Invoices, Customers, Reports, Insights**. No editing.",
      "Use **Reports** for AR aging and job cost.",
    ],
  },
  "lawn:crew": {
    subtitle: "Field crew — run the route",
    bullets: [
      "**Route** shows today's visits.",
      "Complete a visit with before/after photos.",
      "Clock in and out. Mark a visit skipped if a yard is locked.",
    ],
  },
  "lawn:superintendent": {
    subtitle: "Superintendent — route oversight",
    bullets: [
      "**Route** and **Time** show the crew's day.",
    ],
  },
  "lawn:project_manager": {
    subtitle: "Project Manager — schedules and pricing",
    bullets: [
      "Set up **recurring schedules** and per-visit pricing.",
      "**Cycle billing** invoices automatically each month.",
    ],
  },
  "lawn:office": {
    subtitle: "Office — dispatch and billing",
    bullets: [
      "Lawn **Home** is dispatch: today's route and schedules.",
      "**Customers**, **Invoices**, and **Insights** run the back office.",
      "**Cycle billing** auto-sends. **Notifications** show customer actions.",
    ],
  },
  "lawn:sales": {
    subtitle: "Sales — lawn pre-sale funnel",
    bullets: [
      "**Estimates**, **Customers**, and **Insights** — same pre-sale flow, lawn catalog.",
    ],
  },
  "lawn:accountant": {
    subtitle: "Accountant — read-only financials",
    bullets: [
      "Read-only: **Invoices**, **Customers**, **Insights** (lawn).",
    ],
  },
};

export default function RoleOnboarding({ role, variant }: { role: string; variant: Variant }) {
  const key = `tv_onboarding_v${variant}_r${role}_dismissed`;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const dismissed = localStorage.getItem(key);
      if (dismissed !== "1") {
        // setState-in-effect is intentional here: localStorage is browser-only,
        // so the dismissed flag can only be read after mount (SSR-safe).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setVisible(true);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [key]);

  const content = CONTENT[`${variant}:${role}`];
  if (!content) {
    return null;
  }

  const dismiss = () => {
    try {
      localStorage.setItem(key, "1");
    } catch {
      // Ignore localStorage errors
    }
    setVisible(false);
  };

  const splitText = (text: string) => {
    const parts = text.split("**");
    return parts.map((part, index) => (
      <span key={index} className={index % 2 === 1 ? "font-semibold text-gray-900" : ""}>
        {part}
      </span>
    ));
  };

  if (!visible) {
    return null;
  }

  return (
    <div className="bg-white rounded-lg p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <Compass className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">Getting started</p>
          <p className="text-xs text-gray-500 mt-0.5">{content.subtitle}</p>
          <ul className="mt-2 space-y-1">
            {content.bullets.map((bullet, index) => (
              <li key={index} className="text-sm text-gray-700 flex gap-1.5">
                <span className="text-gray-400">·</span>
                {splitText(bullet)}
              </li>
            ))}
          </ul>
        </div>
        <button onClick={dismiss} className="text-gray-400 hover:text-gray-700 p-1 -mt-1 -mr-1 flex-shrink-0" aria-label="Dismiss">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}