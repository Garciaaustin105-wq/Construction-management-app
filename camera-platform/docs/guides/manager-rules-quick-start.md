# Manager Quick-Start Guide

This guide covers the rule-based monitoring system — templates or custom
rules, turning them on, the daily report, and phone alerts — only what the
Rules, Reports and Alerts pages actually show.

## 1. Log In

1. Open the system's web page and log in with your manager account.
2. The **Rules**, **Reports** and **Alerts** links appear when your
   account is allowed to use them and manager rules are on for your site;
   ask your installer if one is missing.

## 2. Start a Rule From a Template

1. Select **Rules**.
2. At the top of the page, the **Today's manager** card shows whether
   today's manager has been learned yet from the desk camera, by clothing
   only — never a face. It reads "Learned today's manager." once learned,
   a not-learned reason otherwise — such as missing open hours or a
   marked desk area — or "Off for this site." Below it: clothing matching
   is weak across cameras and uncalibrated until tested.
3. Under "Start from a template," click one of the ten ready-made rules
   (button labeled by its name; edit anything afterward). "Manager's desk
   unattended" is listed first:
   - **Manager's desk unattended** — person missing 20+ min, open hours;
     alerts and reports.
   - **Manager away and back (desk)** — person away and back 5+ min, open
     hours; reports only.
   - **Manager's car away and back** — vehicle away and back 10+ min, open
     hours; reports only.
   - **Person after hours** — person enters, closed hours; alerts and
     reports.
   - **Lingering** — person present 10+ min, any time; alerts and reports.
   - **Vehicle arrives** — vehicle enters an area, any time; alerts and
     reports.
   - **Vehicle leaves** — vehicle leaves an area, any time; alerts and
     reports.
   - **Door used** — person enters a door area, any time; reports only.
   - **Manager leaves** — matches today's manager, leaves the area 5+ min,
     open hours; alerts and reports. (Uses the **Today's manager** status
     from step 2 above.)
   - **Manager returns** — same match, returns after 5+ min away, open
     hours; reports only. (Same prerequisite.)
4. To build one from scratch instead, click **New rule**.

## 3. Fill In the Rule

1. **Name** — a short description.
2. **Who** — a person or a vehicle.
3. **Condition** — enters, leaves, is missing for more than, is present for
   more than, is away and back for at least, matches today's manager and
   leaves for at least, or matches today's manager and returns after at
   least (the timed ones show a **Minutes** box).
4. **Camera**, then **Area** — pick an area your installer drew, or leave
   "Whole camera." The still below shows it outlined; you can't draw or
   edit areas here.
5. **During** — open hours, closed hours, or any time.
6. **Alert me** and **Add to the daily report** — check either or both.
7. **Cooldown (minutes)** — how long before the same rule can fire again.
8. Watch the plain-words sentence under the form update live, naming every
   choice above.
9. Click **Save rule**.

If **During** is open or closed hours before the store's hours are set,
the page shows "Set the store's open hours first — see Open hours
below," and **Save rule** stays disabled until fixed (or During switches
to "any time").

## 4. Set the Store's Open Hours

1. In the **Open hours** section at the bottom of the Rules page, check
   each open day and set its start and end time.
2. It reads "Open hours are set," or "Not set — rules using open or closed
   hours are refused until this is set."
3. Click **Save open hours**.

## 5. Turn Rules On and Off

1. Under **Existing rules**, each rule shows its name, an on/off checkbox,
   its sentence, and an **Edit** button to reload it above.
2. A rule that's on is checked about every 5 seconds. When its condition
   is met, a report line is added and, if **Alert me** was checked, a
   phone alert follows (subject to the cooldown).

## 6. Read the Daily Report

1. Select **Reports**. It opens on today, in the store's own time zone.
2. Firings group by rule, newest first — e.g. "Manager's desk unattended
   2:10-2:55 (45 min)" — each with a **Review** link to that moment.
3. Use the **←** and **→** buttons to move between days. If nothing fired,
   it reads "No rule firings for this day."
4. Below the report: "Reports go back to \<date\>, as far as this NVR keeps
   video."

## 7. Get Phone Alerts

1. Select **Alerts**.
2. Choose **All my rules**, or **Pick rules** and check the ones you want.
3. Click **Get alerts on this phone**. This needs https (e.g. the store's
   secure link), or the page hides the button.
4. On an iPhone, first tap Share, then "Add to Home Screen" — alerts only
   work after that.
5. Click **Send a test alert** to confirm it arrived.

## 8. Manage Your Devices

1. Under **My devices**, each registered phone is listed with a
   **Remove** button that stops its alerts.
2. "No devices yet." shows until you register one.

## Good to Know

- Reports and alerts never show a name or face — no face recognition,
  ever; appearance of the day matches clothing only.
- A firing never repeats to the same device. A subscription is removed
  only once confirmed gone; other failures retry, then are marked failed.
- If manager rules are off for your site, the Rules, Reports and Alerts
  links are hidden and no alerts are sent.

---

**End of guide.**
