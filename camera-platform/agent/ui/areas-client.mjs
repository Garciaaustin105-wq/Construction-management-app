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
      const del = el(doc, "button", { type: "button", class: "danger", text: "Delete" });
      del.addEventListener("click", () => { void removeArea(a.id); });
      list.append(el(doc, "li", {}, [label, del]));
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
      const res = await fetchFn("/areas", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraId, name: nameInput.value.trim(), points: draft.points }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        if (data && Array.isArray(data.errors)) renderErrors(data.errors);
        else { saveErrorText = (data && data.message) || "Something went wrong."; renderErrors(null); }
        return;
      }
      areas = [...areas, data.area];
      draft = null;
      nameInput.value = "";
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
     *  caller, since that route returns every camera's areas at once). */
    applyLoaded(camerasAreas) {
      areas = Array.isArray(camerasAreas) ? camerasAreas : [];
      renderList();
      renderOverlay();
      updateButtons();
      loadStill();
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
    for (const camera of cameras) {
      if (!camera || typeof camera.cameraId !== "string") continue;
      const panel = createCameraAreasPanel(doc, { fetchFn, now, log }, camera);
      panels.set(camera.cameraId, panel);
      panel.applyLoaded(allAreas.filter((a) => a.cameraId === camera.cameraId));
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
