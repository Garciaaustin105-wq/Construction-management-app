// agent/ui/areas-client.mjs
//
// Client logic for the Cameras page's "Areas" panel (MANAGER-RULES-SPEC.md
// section 1): draw, name and delete a named polygon per camera, up to 12.
// Installer only (camera.manage), reusing the pointer-to-fraction and
// polygon-drawing pieces already proven for the AI settings zone editor
// (agent/ui/camera-ai-client.mjs) rather than re-deriving them -- "reuse the
// existing zone-editor code" is the task's own instruction.
//
// Same discipline as camera-ai-client.mjs: every dependency (the document,
// fetch, the clock) arrives through `opts`, never read off a bare global
// inside an exported function, so a harness can drive this without a
// browser. Nothing here ever sets innerHTML -- every node is built with
// createElement/createElementNS, and every piece of untrusted text (an
// area's own name, typed by the installer) is set with .textContent.
//
// Deliberately its OWN file, not folded into camera-ai-client.mjs or
// cameras-client.mjs (AGENTS.md build rule 3, one owner per file): areas.json
// is a different store than camera-ai.json, with its own routes
// (agent/areas.mjs) and its own 12-per-camera limit (contracts/areas.ts).
//
// THE FEARED FAILURES:
// - a twelfth area on a busy camera silently offered on this page even
//   though the server would refuse it -- MAX_AREAS_PER_CAMERA is mirrored
//   here (see the comment below) so the "Draw an area" control disables
//   itself at the same limit the server enforces, never a save that always
//   fails once a camera is full;
// - camera-page-bootstrap-lesson (agent bus, 2026-09-26): a client with no
//   browser bootstrap block passes every harness check that drives its
//   exported functions directly while the real page never fetches anything.
//   See the bottom of this file.

import { roundFraction, pointerFraction } from "./camera-ai-client.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

/* Mirrored from contracts/areas.ts (that file compiles to CommonJS, so a
   browser cannot import it directly -- same reason camera-ai-client.mjs
   mirrors its own AI_MIN_ZONE_POINTS/AI_MAX_ZONE_POINTS). These are the
   contract's own source of truth; harness/areasPage.harness.mjs checks these
   copies still match it. */
export const MIN_AREA_POINTS = 3;
export const MAX_AREA_POINTS = 32;
export const MAX_AREAS_PER_CAMERA = 12;

function el(doc, tag, attrs, kids) {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids || []) {
    if (kid !== null && kid !== undefined) node.append(kid);
  }
  return node;
}

function svgEl(doc, tag, attrs) {
  const node = doc.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  }
  return node;
}

function clearChildren(node) {
  if (!node) return;
  if (typeof node.replaceChildren === "function") node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

/* ── one camera's Areas panel ────────────────────────────────────────── */

/**
 * One camera's whole Areas panel: the still, the polygon overlay, the
 * existing-areas list (each with Delete), and the draw controls (Start/
 * Close/Cancel + a name field). `fetchFn`/`now` are injected so a harness
 * never touches a network or a real image. Exported so a harness can build
 * one panel against a minimal fake `doc` without a real browser.
 */
export function createCameraAreasPanel(doc, opts, camera) {
  const { fetchFn, now, log } = opts;
  const cameraId = camera.cameraId;

  let areas = []; // this camera's own areas only, as loaded from GET /areas
  let draft = null; // { points: [] } while drawing
  let saveErrorText = "";
  // The SITE-wide manager's-desk area id (APPEARANCE-OF-DAY-SPEC.md: "one
  // manager per store", so at most one area anywhere on the site can carry
  // the role) -- never just this camera's own areas, since the desk could be
  // drawn on a different camera than the one this panel is showing.
  // contracts/areas.ts's checkArea already refuses a second `managerDesk`
  // server-side; this is only ever the CLIENT's own mirror of that fact, so
  // the checkbox below can disable itself rather than let an installer draw
  // a save that is certain to be refused.
  let deskAreaId = null;

  const root = el(doc, "details", { class: "areas-panel panel" }, []);
  const summary = el(doc, "summary", {}, []);
  const summaryName = el(doc, "strong", {});
  summaryName.textContent = typeof camera.name === "string" && camera.name !== "" ? camera.name : cameraId;
  summary.append(summaryName, el(doc, "span", { class: "dim", text: " — areas" }));
  root.append(summary);

  const body = el(doc, "div", { class: "areas-body" }, []);
  root.append(body);

  const stillStatus = el(doc, "p", { class: "dim areas-still-status", text: "Loading a still…" });
  const stillWrap = el(doc, "div", { class: "areas-still-wrap" }, []);
  const stillImg = el(doc, "img", { class: "areas-still", alt: "" });
  const overlay = svgEl(doc, "svg", { class: "areas-overlay", viewBox: "0 0 1 1", preserveAspectRatio: "none" });
  stillWrap.append(stillImg, overlay);
  body.append(stillWrap, stillStatus);

  if (typeof stillImg.addEventListener === "function") {
    stillImg.addEventListener("load", () => { stillStatus.textContent = ""; });
    stillImg.addEventListener("error", () => {
      stillStatus.textContent = "No recent still is available yet for this camera.";
    });
  }

  const nameInput = el(doc, "input", { type: "text", class: "areas-name", placeholder: "Area name, e.g. \"Manager's desk\"", maxlength: 60 });
  const startBtn = el(doc, "button", { type: "button", class: "areas-start", text: "Draw an area" });
  const closeBtn = el(doc, "button", { type: "button", class: "areas-close", text: "Save area", disabled: true });
  const cancelBtn = el(doc, "button", { type: "button", class: "areas-cancel", text: "Cancel", disabled: true });
  const hint = el(doc, "span", { class: "dim areas-hint", text: "" });
  const controls = el(doc, "div", { class: "row" }, [nameInput, startBtn, closeBtn, cancelBtn, hint]);
  body.append(controls);

  // "Areas gain an optional role managerDesk, set by the installer" (MANAGER-
  // RULES-SPEC.md section 1 / APPEARANCE-OF-DAY-SPEC.md) -- a checkbox on the
  // area being drawn, at most one per SITE (not per camera): see deskAreaId
  // above and updateButtons() below for the disabling logic.
  const deskCheckbox = el(doc, "input", { type: "checkbox", class: "areas-desk-checkbox" });
  const deskLabel = el(doc, "label", { class: "row areas-desk-label" }, [
    deskCheckbox, el(doc, "span", { text: "This is the manager's desk" }),
  ]);
  const deskNote = el(doc, "p", { class: "dim areas-desk-note", text: "" });
  body.append(deskLabel, deskNote);

  const errorsEl = el(doc, "div", { class: "areas-errors error", role: "alert" }, []);
  body.append(errorsEl);

  const list = el(doc, "ul", { class: "areas-list" }, []);
  body.append(list);

  function renderOverlay() {
    clearChildren(overlay);
    for (const a of areas) {
      const pointsAttr = a.points.map(([x, y]) => `${x},${y}`).join(" ");
      overlay.append(svgEl(doc, "polygon", {
        points: pointsAttr, fill: "rgba(76,139,245,0.28)", stroke: "#4c8bf5", "stroke-width": 0.004,
      }));
    }
    if (draft && draft.points.length > 0) {
      const pts = draft.points.map(([x, y]) => `${x},${y}`).join(" ");
      overlay.append(svgEl(doc, "polyline", {
        points: pts, fill: "none", stroke: "#7ddc9a", "stroke-width": 0.004, "stroke-dasharray": "0.008 0.006",
      }));
      for (const [x, y] of draft.points) {
        overlay.append(svgEl(doc, "circle", { cx: x, cy: y, r: 0.006, fill: "#fff" }));
      }
    }
  }

  function renderList() {
    clearChildren(list);
    if (areas.length === 0) {
      list.append(el(doc, "li", { class: "dim", text: "No areas on this camera yet." }));
    }
    for (const a of areas) {
      const label = el(doc, "span", {});
      // Untrusted text (the installer's own area name): .textContent, never innerHTML.
      label.textContent = `${a.name} (${a.points.length} points)`;
      const isDesk = a.role === "managerDesk";
      const toggle = el(doc, "input", { type: "checkbox", class: "areas-desk-toggle" });
      toggle.checked = isDesk;
      // Disabled only when SOME OTHER area already holds the role -- turning
      // this one's OWN checkbox off (to clear it) always stays available.
      toggle.disabled = !isDesk && deskAreaId !== null;
      toggle.addEventListener("change", () => { void setAreaRole(a, toggle.checked); });
      const toggleLabel = el(doc, "label", { class: "row areas-desk-toggle-label" }, [
        toggle, el(doc, "span", { class: "dim", text: "Manager's desk" }),
      ]);
      const del = el(doc, "button", { type: "button", class: "danger", text: "Delete" });
      del.addEventListener("click", () => { void removeArea(a.id); });
      list.append(el(doc, "li", {}, [label, toggleLabel, del]));
    }
  }

  function updateButtons() {
    const atLimit = areas.length >= MAX_AREAS_PER_CAMERA;
    startBtn.disabled = draft !== null || atLimit;
    closeBtn.disabled = draft === null || draft.points.length < MIN_AREA_POINTS || nameInput.value.trim() === "";
    cancelBtn.disabled = draft === null;
    if (draft === null && atLimit) {
      hint.textContent = `Up to ${MAX_AREAS_PER_CAMERA} areas on one camera.`;
    } else if (draft) {
      hint.textContent = `${draft.points.length}/${MAX_AREA_POINTS} points — tap the still to add more, then Save area.`;
    } else {
      hint.textContent = "";
    }
    // "At most one per site" (APPEARANCE-OF-DAY-SPEC.md): a NEW area being
    // drawn can only offer to become the desk when the site does not already
    // have one -- clearing an existing one is done from its own row above,
    // never from here.
    const deskAlreadySet = deskAreaId !== null;
    deskCheckbox.disabled = draft === null || deskAlreadySet;
    if (deskAlreadySet && draft !== null) deskCheckbox.checked = false;
    deskNote.textContent = deskAlreadySet
      ? "The manager's desk is already set for this site — clear it on its own area first to move it."
      : "";
  }

  startBtn.addEventListener("click", () => {
    if (areas.length >= MAX_AREAS_PER_CAMERA) return;
    draft = { points: [] };
    updateButtons();
    renderOverlay();
  });
  cancelBtn.addEventListener("click", () => {
    draft = null;
    updateButtons();
    renderOverlay();
  });
  nameInput.addEventListener("input", updateButtons);

  stillWrap.addEventListener("pointerdown", (ev) => {
    if (!draft || draft.points.length >= MAX_AREA_POINTS) return;
    const rect = typeof stillWrap.getBoundingClientRect === "function" ? stillWrap.getBoundingClientRect() : null;
    const frac = pointerFraction(ev.clientX, ev.clientY, rect);
    draft.points.push([roundFraction(frac.x), roundFraction(frac.y)]);
    updateButtons();
    renderOverlay();
  });

  function renderErrors(errors) {
    clearChildren(errorsEl);
    if (!Array.isArray(errors) || errors.length === 0) {
      if (saveErrorText) errorsEl.append(el(doc, "p", { text: saveErrorText }));
      return;
    }
    const ul = el(doc, "ul", {}, []);
    for (const e of errors) ul.append(el(doc, "li", { text: `${e.field}: ${e.reason}` }));
    errorsEl.append(el(doc, "p", { text: "This area could not be saved:" }), ul);
  }

  async function saveArea() {
    if (!draft || draft.points.length < MIN_AREA_POINTS || nameInput.value.trim() === "") return;
    closeBtn.disabled = true;
    saveErrorText = "";
    clearChildren(errorsEl);
    try {
      const body = { cameraId, name: nameInput.value.trim(), points: draft.points };
      // Only ever sent when actually checked AND not disabled -- a disabled,
      // still-checked box (a race against another install saving the desk
      // elsewhere) never smuggles a role through that updateButtons() would
      // otherwise have blocked; checkArea would refuse it anyway
      // (duplicate_role), but this page never relies on the server to catch
      // what its own UI already knows not to offer.
      if (deskCheckbox.checked && !deskCheckbox.disabled) body.role = "managerDesk";
      const res = await fetchFn("/areas", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        if (data && Array.isArray(data.errors)) renderErrors(data.errors);
        else { saveErrorText = (data && data.message) || "Something went wrong."; renderErrors(null); }
        return;
      }
      areas = [...areas, data.area];
      if (data.area.role === "managerDesk") setSiteDeskAreaId(data.area.id);
      draft = null;
      nameInput.value = "";
      deskCheckbox.checked = false;
      renderList();
      renderOverlay();
    } catch (err) {
      if (typeof log === "function") log("error", "area save failed", { cameraId, message: err && err.message });
      saveErrorText = "Could not reach the recorder.";
      renderErrors(null);
    } finally {
      updateButtons();
    }
  }
  closeBtn.addEventListener("click", () => { void saveArea(); });

  /** Toggle an EXISTING area's own managerDesk role on or off, re-posting the
   *  same area unchanged apart from `role` (POST /areas edits by id --
   *  agent/areas.mjs). Never optimistic: the checkbox's own visible state is
   *  only ever set from what the server actually accepted, in renderList(),
   *  so a refused toggle (another area already holds the role) snaps back
   *  rather than lying about what was saved. */
  async function setAreaRole(area, makeDesk) {
    saveErrorText = "";
    clearChildren(errorsEl);
    try {
      const body = { id: area.id, cameraId: area.cameraId, name: area.name, points: area.points };
      if (makeDesk) body.role = "managerDesk";
      const res = await fetchFn("/areas", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        if (data && Array.isArray(data.errors)) renderErrors(data.errors);
        else { saveErrorText = (data && data.message) || "Could not change the manager's desk."; renderErrors(null); }
        renderList(); // snap the checkbox back to what is actually on file
        return;
      }
      areas = areas.map((a) => (a.id === area.id ? data.area : a));
      setSiteDeskAreaId(data.area.role === "managerDesk" ? data.area.id : (deskAreaId === area.id ? null : deskAreaId));
      renderList();
      updateButtons();
    } catch (err) {
      if (typeof log === "function") log("error", "area role save failed", { cameraId, id: area.id, message: err && err.message });
      saveErrorText = "Could not reach the recorder.";
      renderErrors(null);
      renderList();
    }
  }

  /** Update this panel's own knowledge of the SITE-wide desk area id, and
   *  tell the page driver (if any) so every OTHER camera's panel re-renders
   *  its own checkboxes too -- the role is site-wide, so a change on one
   *  camera must disable/enable the option everywhere else immediately, not
   *  just on the next full page load. */
  function setSiteDeskAreaId(id) {
    deskAreaId = id;
    if (typeof opts.onDeskChanged === "function") opts.onDeskChanged(id);
  }

  async function removeArea(id) {
    try {
      const res = await fetchFn(`/areas/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        saveErrorText = (data && data.message) || "Could not delete that area.";
        renderErrors(null);
        return;
      }
      areas = areas.filter((a) => a.id !== id);
      renderList();
      renderOverlay();
      updateButtons();
    } catch (err) {
      if (typeof log === "function") log("error", "area delete failed", { cameraId, id, message: err && err.message });
      saveErrorText = "Could not reach the recorder.";
      renderErrors(null);
    }
  }

  function loadStill() {
    const atIso = new Date(now() - 90_000).toISOString();
    stillStatus.textContent = "Loading a still…";
    stillImg.src = `/still?camera=${encodeURIComponent(cameraId)}&at=${encodeURIComponent(atIso)}`;
  }

  return {
    root,
    /** Apply this camera's own areas from GET /areas (filtered by the
     *  caller, since that route returns every camera's areas at once), and
     *  the site-wide manager's-desk area id (found across EVERY camera's
     *  areas, by the page driver below -- never just this one's). */
    applyLoaded(camerasAreas, siteDeskAreaId) {
      areas = Array.isArray(camerasAreas) ? camerasAreas : [];
      deskAreaId = siteDeskAreaId ?? null;
      renderList();
      renderOverlay();
      updateButtons();
      loadStill();
    },
    /** The page driver's own push, after ANY panel (this one or another
     *  camera's) changes which area holds the role -- re-renders this
     *  panel's checkboxes with the new site-wide state, without re-fetching
     *  or re-notifying (setSiteDeskAreaId is the notifying path; this is the
     *  receiving one, so the two can never loop into each other). */
    setDeskAreaId(id) {
      deskAreaId = id;
      renderList();
      updateButtons();
    },
  };
}

/* ── page driver ──────────────────────────────────────────────────────── */

/**
 * Wires up the whole Areas section on the Cameras page: fetches GET
 * /camera-settings (camera ids and names) and GET /areas (every area on
 * file), builds one panel per camera, and reports a file-level problem (if
 * any) in a top-level notice.
 */
export function startAreasPage(opts) {
  const doc = opts.doc;
  const fetchFn = opts.fetchFn;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const containerId = opts.containerId || "areasList";
  const noticeId = opts.noticeId || "areasNotice";

  const container = typeof doc.getElementById === "function" ? doc.getElementById(containerId) : null;
  const notice = typeof doc.getElementById === "function" ? doc.getElementById(noticeId) : null;

  const panels = new Map();

  function showNotice(text) {
    if (!notice) return;
    if (!text) { notice.textContent = ""; notice.hidden = true; return; }
    notice.textContent = text;
    notice.hidden = false;
  }

  async function load() {
    let cameraList;
    let areasData;
    try {
      const [camerasRes, areasRes] = await Promise.all([
        fetchFn("/camera-settings", { credentials: "same-origin" }),
        fetchFn("/areas", { credentials: "same-origin" }),
      ]);
      if ((camerasRes && camerasRes.status === 401) || (areasRes && areasRes.status === 401)) {
        if (typeof opts.navigate === "function") opts.navigate("/login?next=%2Fcameras-page");
        return;
      }
      cameraList = (await camerasRes.json().catch(() => null)) || { cameras: [] };
      areasData = (await areasRes.json().catch(() => null)) || { areas: [], problem: null };
    } catch (err) {
      log("error", "areas panel could not load", { message: err && err.message });
      showNotice("Could not reach the recorder.");
      return;
    }
    showNotice(areasData.problem || null);
    const cameras = Array.isArray(cameraList.cameras) ? cameraList.cameras : [];
    const allAreas = Array.isArray(areasData.areas) ? areasData.areas : [];
    if (container) clearChildren(container);
    panels.clear();
    if (cameras.length === 0 && container) {
      container.append(el(doc, "p", { class: "dim", text: "No cameras yet." }));
    }
    // "One manager per store" (APPEARANCE-OF-DAY-SPEC.md): at most one area,
    // on any camera, ever holds this role -- found once, across every
    // camera's own areas, and handed to EVERY panel so each one's checkbox
    // knows whether some OTHER camera already has it.
    let deskAreaId = allAreas.find((a) => a.role === "managerDesk")?.id ?? null;
    for (const camera of cameras) {
      if (!camera || typeof camera.cameraId !== "string") continue;
      const panel = createCameraAreasPanel(doc, {
        fetchFn, now, log,
        // Any panel's own role change is site-wide: push it to every OTHER
        // panel immediately (setDeskAreaId, the receiving half -- see its own
        // comment), so a checkbox disables/enables without waiting for a
        // full page reload.
        onDeskChanged: (id) => {
          deskAreaId = id;
          for (const p of panels.values()) p.setDeskAreaId(id);
        },
      }, camera);
      panels.set(camera.cameraId, panel);
      panel.applyLoaded(allAreas.filter((a) => a.cameraId === camera.cameraId), deskAreaId);
      if (container) container.append(panel.root);
    }
  }

  const ready = load();
  return { ready, reload: load, panels };
}

// Browser bootstrap. Runs only when the real page has the panel's container
// in the DOM; a harness importing this module for its pure helpers has no
// side effects. Copies camera-page-bootstrap-lesson (agent bus,
// 2026-09-26): every new NVR page client needs this, and
// harness/areasPage.harness.mjs proves it the same way
// harness/activityPage.harness.mjs proves activity-client.mjs's own.
if (typeof document !== "undefined" &&
    typeof document.getElementById === "function" &&
    document.getElementById("areasList")) {
  startAreasPage({
    doc: document,
    fetchFn: function (url, init) {
      return fetch(url, init);
    },
    now: () => Date.now(),
    navigate: (url) => { window.location.assign(url); },
    log: () => {},
  });
}
