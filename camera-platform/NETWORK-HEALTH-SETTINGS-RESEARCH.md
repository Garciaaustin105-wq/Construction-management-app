# Network view, health, analytics and settings: what competitors do, what we have

Research done 2026-09-23 for the owner's ask: "web analytics for the current
local network and whats on the local network". OpenEye does this. Every claim
below comes from the vendor's own pages; a URL is given for each key one.

## OpenEye (what the owner installs today)

**On the recorder itself**

- **Camera discovery.** Network Camera Manager finds OpenEye and ONVIF cameras
  on the LAN, with a MAC-address search. Recorders with a built-in PoE switch
  auto-detect cameras on that segment.
  https://answers.openeye.net/Install/Adding_Cameras_and_Camera_Settings/Network_Camera_Manager
- **Network diagnostics.** Pings the gateway and the internet, checks DNS, and
  tests the outbound ports to their cloud. It is connectivity troubleshooting,
  not a throughput view.
  https://answers.openeye.net/Troubleshooting/Troubleshooting_Guides/Troubleshooting_Network_Diagnostics
- **Built-in PoE port control.** Only on recorders with a built-in PoE switch:
  per-port power and diagnostics, and remote power-cycling of one camera's
  port. Their external accessory PoE switch is unmanaged.
  https://www.openeye.net/integrated-poe-switch-or-dual-nic-on-new-openeye-recorders-limit-the-impact-of-ip-cameras-on-the-primary-network/
- **Remote-viewing bandwidth cap.** A limit on outbound streaming, not a live
  monitor.

**In the OWS cloud portal**

- **Inventory Report.** The closest thing to "what's on my network".
  - Per camera: IP, MAC, make and model, firmware, serial, resolution, FPS,
    bitrate, retention.
  - Per recorder: status, software version, CPU and memory, license, last
    connection.
  https://answers.openeye.net/Configure/Reports/Inventory_Reports
- **Health alerts.** Abnormal restart, drive error, device not reporting,
  camera connection lost, no recorded video, offline after update, and low
  retention. The dealer can be told before the customer.
  https://answers.openeye.net/Configure/Alerts/Creating_an_Alert_Rule/Health_and_Storage_Retention_Alerts
- **Scheduled reports.** Weekly and monthly health reports, plus a dealer
  portal across all customer accounts.
- **Activity analytics.** "Operational Analytics", in beta: walk-in counting,
  occupancy, heatmaps and dwell. Needs analytics cameras and the higher
  license tiers.
- **Roles.** Administrator, Super User and User inside an organization; the
  dealer tier sits outside it.
- **Saved layouts.** Shared per group, on the higher tiers.

**Not found in any OpenEye documentation**

- a live network topology map;
- IP-conflict detection;
- a WAN speed test;
- security or port scanning;
- live bandwidth-over-time graphs;
- one unified network screen.

## Others, briefly

- **Axis.** Device Manager lists every device with address, status, serial and
  firmware, and does bulk firmware updates. Health monitoring is a separate
  cloud add-on with email rules.
- **Hanwha WAVE.** Auto-discovers cameras and servers on the subnet. Live CPU,
  RAM, disk and network graphs appear when a server is dropped onto the grid.
- **Eagle Eye.** Its managed PoE switches report per-port status, traffic and
  power, and allow remote port power-cycling from the cloud UI.
- **None of them** publicly documents an automatic topology map.

## What our NVR already has (camera-platform, 2026-09-23)

- **Discovery.** WS-Discovery (agent/wsdiscovery.mjs) and SADP
  (agent/sadp.mjs), with CIDR-bounded sweeps and interface choice
  (contracts/net.ts).
- **Health.** Per-camera measured bitrate, and a System page built on measured
  facts only (contracts/siteHealth.ts, agent/healthfacts.mjs). camctl alerts
  writes alerts.json.
- **Screens.** Grid layouts and the wall display are mature
  (contracts/gridLayout.mts, agent/ui/wall-client.mjs). Layouts are stored
  per browser only.
- **Roles.** Two on-box roles (installer, store) plus a display credential,
  with default-deny routes (contracts/routeAccess.ts).

**Gaps**

- no per-camera online/offline;
- no inventory (MAC, model, firmware);
- no activity charts;
- zones and the per-camera detection schedule exist as contracts only, with
  no UI or route;
- alert rules and Web Push are both built but not wired together;
- no site name or time-zone setting;
- no tenancy or manager roles (CLOUD-B1-SPEC.md section 8 plans them).
