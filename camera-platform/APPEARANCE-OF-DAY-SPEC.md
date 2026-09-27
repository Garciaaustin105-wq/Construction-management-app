# Manager rules, build 3: today's manager, by appearance (no face)

Owner's decisions (memory manager-ai-rules, bus note
camera-manager-appearance):
- "just need to learn what managers look like daily without learning the
  face".
- Learned FULLY AUTOMATICALLY each morning from the manager's desk.
- WIPED NIGHTLY.
- One manager per store, very rarely two.
- A PER-SITE switch, because some stores use uniforms.
- NO face recognition, ever.
- Every match reports a similarity %, never a flat yes.

## What is measured

**The clothing signature.** Computed by the Python worker
(detector/yolox_worker.py) for each person detection, only when the site's
`appearanceOfDay` switch is on (a new worker flag; off means nothing is
computed and nothing is sent).
- **The head is excluded:** the crop starts 20% down from the box's top
  edge. No face pixels are ever read into the signature.
- **Two regions:**
  - upper body: 20% to 55% of the box height;
  - lower body: 55% to 95% of it;
  - each trimmed 15% from the left and right edges, to drop background.
- **Per region:** an HSV histogram with 8 hue x 3 saturation x 3 value bins
  (72 values), L1-normalised. Pixels with very low saturation or value are
  binned by value only, so grey and black clothing still count.
- **Also:** the box aspect ratio (build).
- **Sent** as a compact array of 145 numbers at 3 decimal places in the
  frame line's detection (`appearance`). It is never written to events.db
  or anywhere durable except today's signature file below.
- **Too small:** a box under 48 px tall on the source frame gets no
  signature (`appearance: null`, with the reason in the worker's own
  counters), never a guess.

**Similarity.** Per region, a Bhattacharyya coefficient. The overall figure
is 0.6 x upper + 0.4 x lower, times an aspect agreement factor, shown as a
percentage.

## Learning today's manager (automatic)

- **The window:** the first hour of the site's `openHours`. It needs
  openHours; without them, today's manager is not learned and the page
  says why.
- **Who:** the person present longest inside the area named as the
  manager's desk. Areas gain an optional role `managerDesk`, set by the
  installer; the "Manager's desk" template sets it. Longest is judged by
  occupancy presence time, linked to that person's own detections through
  the detection fold's event id.
- **The signature:** the element-wise median of that person's signatures
  during the stretch. At least 20 signatures, or it is not learned yet and
  it keeps trying until the window ends.
- **A rare second manager:** a second person with at least 30 minutes of
  desk presence in the first two hours, and a signature under 60%
  similarity to the first, is learned as "second manager".
- **Storage:** `<stateDir>/appearance-today.json` (0600) holds the date in
  the site tz, the signature(s) and `learnedAtUtc`. It is DELETED at local
  midnight, and on any start where its date is not today. Nothing is kept
  for longer.

## Matching and reporting

- **Matching.** On each person detection on any camera, detect-service
  compares the signature with today's. At or above the match threshold,
  that detection is a "manager match" with its %.
  - The threshold is a per-site setting, default 80%.
  - It is uncalibrated until the owner records test walks, and the page
    says so.
- **New conditions and templates:** "Manager leaves" (a manager match in a
  door or exit area, then no manager match at the desk for 5 min) and
  "Manager returns".
- **Report lines:** "Person matching today's manager (86%) left through
  Back door 2:10; matched back at Manager's desk 2:55 (45 min)". Always
  "person matching", always the %, never a name.
- **Uniform sites:** switch it off. The desk and car-spot rules carry
  "manager away" there.

## Tests that matter

- The head region is never read. The crop is asserted, and a signature is
  identical when the top 20% of the image is replaced.
- The switch off means no signatures are computed or sent.
- A box that is too small gives null, not zeros.
- The file is deleted at local midnight and on a stale date.
- There is no learning without openHours or with too few signatures.
- The second manager needs the 30 minutes and dissimilarity.
- Similarity is symmetric and bounded 0..100.
- The same person with changed lighting stays above a looser bound than
  a different-coloured shirt. Test with synthetic images.
- Report wording always says "person matching" plus a %.
- No face-related code path exists: grep for face or landmark libraries
  and fail if any are imported.

## Known limits (say them on the page)

- Clothing-colour matching is weak across cameras with very different
  lighting, and useless under uniforms.
- The bench laptop has one camera, so cross-camera matching cannot be
  measured there. Same-camera leave and return can.
