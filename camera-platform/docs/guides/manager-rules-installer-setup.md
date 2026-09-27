# Setting up manager rules at a store

Manager rules watch areas you draw — the manager's desk, the manager parking
spot, doors, registers — and write a daily report. No face recognition,
ever; a report never names a person. A rule can also alert a phone once
someone turns that on for their own phone (step 7).

## 1. Turn the feature on for the site

1. Sign in as the installer. Areas need `camera.manage`. "Manager rules",
   "Appearance of the day (no face)", and the site type are all set in the
   System page's "Site" section. "Manager rules" is off by default.
2. Set the site type. Presets pre-select "Manager rules": on for retail,
   storage, and carwash; off for home and other.
3. Or tick a switch directly, under "Features", then click "Save".
4. Off: the Rules, Reports and Alerts links are hidden, their pages answer 404
   `feature_off`, no occupancy is sampled, and the evaluator does not run.
5. "Appearance of the day" learns today's manager's clothing each morning
   from the desk camera, never the face, and forgets it nightly. Needs the
   desk area flagged in "Draw the areas" below, and the store's open hours
   set in "Set the store's open hours" below.

## 2. Set the store's open hours

1. On the Rules page's "Open hours" panel: tick each open day, set its
   "from"/"to" times, click "Save open hours". Kept in the site's time
   zone; the installer or a manager can edit them later.
2. A rule using open or closed hours is refused until hours are set: "set
   the store's open hours first". It never guesses.

## 3. Draw the areas

1. On the Cameras page, draw, name, and delete areas (installer only,
   audited). Each polygon belongs to one camera, up to 12 per camera; a
   rule can also use the whole camera, with no area.
2. Typical areas: "Manager's desk", "Manager parking spot", "Back door",
   "Register 1". One area can be flagged "Manager's desk" (one per site)
   for the last two templates below.
3. Managers see area names and a still with the area outlined; they never
   draw or edit areas. A detection hidden by the camera's own AI settings
   is not evidence.

## 4. Create the manager login

1. On the Accounts page, under "Sign-in accounts", enter a "Username",
   pick "Manager" under "Role", set and confirm a password (12+
   characters), then click "Add account".
2. A manager can manage rules, view events/live/playback, edit layouts,
   and edit open hours — not cameras, storage, system, accounts, network,
   or areas.

## 5. Create the rules

1. On the Rules page, pick a template under "Start from a template" —
   "Manager's desk unattended" is first. A template only pre-fills the
   rule; change anything you like.
2. The form reads in plain words, e.g. "When [a person] [is missing for
   more than] [20] minutes from [Manager's desk on Office] during [open
   hours], [alert me] and [add to the daily report]." While you edit, the
   form shows the camera still with the area outlined. Each saved rule is
   listed under "Existing rules" with an on/off switch and an Edit button.

Templates:

|Template|Watches|Fires when|During|Alert|Report|
|---|---|---|---|---|---|
|Manager's desk unattended|person|absent longer than 20 min|open hours|on|on|
|Manager away and back (desk)|person|away 5+ min, then back|open hours|off|on|
|Manager's car away and back|vehicle|away 10+ min, then back|open hours|off|on|
|Person after hours|person, whole camera|enters|closed hours|on|on|
|Lingering|person|present longer than 10 min|always|on|on|
|Vehicle arrives|vehicle|enters|always|on|on|
|Vehicle leaves|vehicle|leaves|always|on|on|
|Door used|person|enters|always|off|on|
|Manager leaves|person|seen at a door/exit; no desk match for 5+ min|open hours|on|on|
|Manager returns|person|desk match, after such a leave|open hours|off|on|

3. The last two need "Appearance of the day" on and today's manager
   learned, or they never fire. Each reports a line with a percentage,
   never a name — e.g. "Person matching today's manager (86%) left
   through Back door 2:10".

## 6. Check the first daily report

1. Open the Reports page. One local day, newest first: each firing is a
   line with its times and duration, grouped by rule — e.g. "Manager's
   desk unattended 2:10-2:55 (45 min)" — linking to Review at that camera
   and time.
2. It shows "Reports go back to <date>, as far as this NVR keeps video."
3. Renaming a rule later does not change old lines: a firing keeps the
   name it had.

## 7. Turn on phone alerts

1. Open the Alerts page. Choose "All my rules" or "Pick rules", then click
   "Get alerts on this phone".
2. Needs https (or localhost) — otherwise the button is hidden and the
   page asks for a secure link. On an iPhone, add the page to the home
   screen first (Share, then "Add to Home Screen").
3. "Send a test alert" checks it works. Each device shows under "My
   devices" with its own Remove button. Nobody is subscribed
   automatically — each person turns alerts on for their own phone.

## How the counting works

- Present needs 10+ seconds of presence evidence (a passer-by does not
  count); absent needs 30+ seconds without the person, 60+ for a vehicle.
- No frames for 120 seconds means "not watching", never "absent" (a still
  scene sends no frames at all).
- A parked car that is a known object still shows present in its spot.
- A not-watching gap never produces enters, leaves, or a completed away
  stretch — a stretch running into it reads "away from 2:10, then not
  watching from 2:40", never a guessed return.
- A rule fires once per stretch and respects its cooldown minutes.
  Transitions and firings are kept as long as the video.
