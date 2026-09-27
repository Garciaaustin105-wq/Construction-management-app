# Reading Health Graphs on the System Page

1. **Open the System page.** It now has a "History" section that shows health
   data over time, below the existing "now" view (cameras, storage, recorder
   status).

2. **Pick a time range.** Above the charts are two buttons, **24h** and
   **7d**. If the box hasn't been recording for the whole range yet, a note
   reads "history from HH:MM".

3. **Know what each chart shows.**

   | Chart | What it shows | Unit |
   |---|---|---|
   | CPU | Busy share of the NVR's CPU | % |
   | Temperature | CPU package temperature | °C |
   | Memory used | Memory in use | GiB |
   | Drives (used %) | Used space, one line per drive | % |
   | Camera bitrate | Recorded bitrate per camera | kbps |
   | Network | rx and tx rate, one chart per network interface | Mbps |
   | Recording | on / off / no-samples state, one strip per camera | state |
   | Recorder running | on / off / no-samples state | state |

   Each chart has its own y-axis with the unit shown on it — never two
   scales on one chart. With up to 4 cameras, bitrate is one chart with a
   legend; with more, each camera gets its own small chart on a shared
   scale. The Temperature chart also notes which sensor was used underneath
   it, or says temperature isn't measured on this box.

4. **Read the data points.** Samples are taken every 60 seconds. The page
   groups them into buckets — 5-minute buckets for 24h (288 of them),
   1-hour buckets for 7d (168). Each bucket holds the **median** of its
   samples and the sample count (**n**), never an average. A bucket with no
   samples shows as a **break** in the line, not a zero and never a line
   drawn across the gap.

5. **Hover a line chart for details.** A crosshair follows the pointer, and
   a tooltip shows the time, the median, the unit, and n for that point.

6. **Open the table view.** Every chart has a "Table view" you can expand
   for the same information as text:
   - Line charts (CPU, Temperature, Memory, Drives, Camera bitrate,
     Network) list time, median with its unit, and n — or "no data" for an
     empty bucket.
   - The Recording and Recorder running strips list From, To, and State
     instead.

7. **Read the status strips.** The Recording strip (one per camera) and the
   Recorder running strip each show three states — **on**, **off**, or **no
   samples** — as colored bars with a legend underneath. They sit in their
   own part of the History section, after the line charts. Hovering a bar
   shows its state and the time span it covers.

8. **Color and styling.** Multiple cameras or interfaces use a fixed set of
   colors that never cycle or repeat. Status strips use their own on/off/
   no-samples colors and always carry a legend — color is never the only
   way to tell a state apart. Chart lines are 2 px thick, and grid lines are
   muted so the data stands out.

9. **On a phone.** The page keeps a 16 px margin at any width and never
   scrolls sideways; charts resize to fit their container.

10. **Where the data lives.** Samples are stored on the box in
    `<stateDir>/health-history.db` and kept for 8 days before older rows are
    deleted. The page reads them from `GET /health/history?range=24h|7d`,
    which also reports how far back the stored data goes and each series'
    unit.

11. **Not available yet:**
    - Alert thresholds drawn on the graphs (coming later).
    - History older than 7 days (coming later).
    - Activity counts (coming later — a later phase, once video is in
      place).

12. **Key takeaway.** A break in a line means no sample was recorded for
    that stretch — never shown as a zero. Hover a chart or open its table
    view for the exact numbers behind any point.
