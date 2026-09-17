/*
 * Live wall client for the NVR appliance's wall TV page.
 *
 * Owns: the camera grid (cells, layout shapes, paging), the control bar, and
 * the bookkeeping of which cameraIds should be live; cell bodies go to openStream.
 *
 * Does NOT own: WebSockets, MediaSource or <video> playback -- the host page
 * owns all streaming and playback. It imports nothing, and never touches a
 * global document, window or localStorage: everything arrives via options.
 */

const LAYOUT_KEY = "camplat.wall.layout";
const TOUR = "tour";
const QUALITY_KEY = "camplat.wall.quality";

export function createWall(options) {
  const doc = options.doc;
  const gridRoot = options.gridRoot;
  const controlsRoot = options.controlsRoot;
  const grid = options.grid;
  const openStream = options.openStream;
  const closeStream = options.closeStream;
  // Optional: a stream that stays on screen across a redraw is handed its new
  // cell, or it keeps playing into a cell that was just removed.
  const moveStream = options.moveStream || null;
  const storage = options.storage || null;
  // Injectable so the harness can turn the rotation by hand.
  const timers = options.timers || globalThis;
  const tourMs = options.tourMs || 10000;

  let devices = [];
  // Prototype-less, because these are keyed by installer-supplied ids: on a
  // plain {} the key "__proto__" sets the prototype instead of storing a value,
  // and "constructor" reads back a function.
  let deviceIndex = Object.create(null);
  const chosenStream = Object.create(null);
  let layout = options.layout || readStoredLayout() || "2x2";
  // "tour" is not a shape: it is 1x1 with the page turning itself, for a TV
  // nobody is standing at. It is remembered like a layout so it survives a
  // power cut.
  let touring = layout === TOUR;
  if (touring) layout = "1x1";
  let tourTimer = null;
  let quality = knownQuality(options.quality) || knownQuality(readStored(QUALITY_KEY)) || "auto";
  let pageIndex = 0;
  let pageCount = 1;
  let streaming = [];

  // Nodes are emptied by removal, never with innerHTML -- an installer can put
  // < and > in a camera name and innerHTML would turn the name into markup.
  function emptyEl(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function shapeFor(id) {
    const shapes = grid.GRID_SHAPES;
    for (let i = 0; i < shapes.length; i++) {
      if (shapes[i].id === id) return shapes[i];
    }
    return null;
  }

  function readStoredLayout() {
    return readStored(LAYOUT_KEY);
  }

  function readStored(key) {
    if (!storage) return null;
    try {
      return storage.getItem(key);
    } catch (err) {
      // a wall with no storage still has to show cameras
    }
    return null;
  }

  function knownQuality(id) {
    const choices = grid.LIVE_QUALITY_CHOICES;
    for (let i = 0; i < choices.length; i++) {
      if (choices[i].id === id) return id;
    }
    return null;
  }

  function rememberLayout() {
    if (!storage) return;
    try {
      storage.setItem(LAYOUT_KEY, touring ? TOUR : layout);
    } catch (err) {
      // a wall with no storage still has to show cameras
    }
  }

  // The shown stream is the operator's choice, else the FIRST stream entry.
  // Nothing in the data marks a "main" stream, so never guess from the id.
  function chosenStreamId(device) {
    const picked = chosenStream[device.deviceId];
    for (let i = 0; i < device.streams.length; i++) {
      if (device.streams[i].cameraId === picked) return picked;
    }
    return device.streams.length > 0 ? device.streams[0].cameraId : null;
  }

  function buildStreamPicker(device, chosenId) {
    // Labelled with the raw cameraId text -- "main"/"sub" in the ids are a
    // site naming habit, not a contract, so nothing here parses them.
    const select = doc.createElement("select");
    select.className = "cell-stream";
    for (let i = 0; i < device.streams.length; i++) {
      const option = doc.createElement("option");
      option.value = device.streams[i].cameraId;
      option.textContent = device.streams[i].cameraId;
      select.appendChild(option);
    }
    select.value = chosenId;
    select.addEventListener("change", () => setStream(device.deviceId, select.value));
    return select;
  }

  function buildCameraCell(device, shape) {
    const chosenId = chosenStreamId(device);
    const cell = doc.createElement("div");
    cell.className = "cell";
    cell.style.aspectRatio = grid.cellAspectRatio(shape);
    const head = doc.createElement("div");
    head.className = "cell-head";
    const label = doc.createElement("span");
    label.className = "cell-label";
    label.textContent = device.label;
    head.appendChild(label);
    // One physical camera is one cell -- a picker only when there is a choice.
    if (device.streams.length > 1) {
      head.appendChild(buildStreamPicker(device, chosenId));
    }
    if (device.unresolvedCount > 0) {
      const warn = doc.createElement("span");
      warn.className = "cell-warn";
      warn.textContent = device.unresolvedCount + " stream(s) not resolved";
      head.appendChild(warn);
    }
    cell.appendChild(head);
    const body = doc.createElement("div");
    body.className = "cell-body";
    cell.appendChild(body);
    return { cell: cell, chosenId: chosenId, body: body };
  }

  function buildEmptyCell(shape) {
    const cell = doc.createElement("div");
    cell.className = "cell cell-empty";
    cell.style.aspectRatio = grid.cellAspectRatio(shape);
    const label = doc.createElement("div");
    label.className = "cell-empty-label";
    // Exact wording matters: an unlabelled tile on a wall TV reads as a dead
    // camera and gets the installer called out for a fault that is not there.
    label.textContent = "Empty - no camera assigned";
    cell.appendChild(label);
    return cell;
  }

  function toggleFullscreen() {
    // Both halves guarded with typeof -- a TV browser without the fullscreen
    // API must still show cameras instead of throwing.
    if (doc.fullscreenElement) {
      if (typeof doc.exitFullscreen === "function") {
        doc.exitFullscreen();
      }
    } else if (typeof gridRoot.requestFullscreen === "function") {
      gridRoot.requestFullscreen();
    }
  }

  function barButton(id, text, onClick) {
    const button = doc.createElement("button");
    button.id = id;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function renderControls(page) {
    emptyEl(controlsRoot);
    // One dropdown, not a row of buttons. Options are generated from
    // GRID_SHAPES -- a hardcoded list would drift from gridPage.
    const select = doc.createElement("select");
    select.id = "layoutSelect";
    select.className = "layout-select";
    const shapes = grid.GRID_SHAPES;
    const addOption = (value, text) => {
      const option = doc.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = touring ? value === TOUR : value === layout;
      select.appendChild(option);
    };
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i];
      addOption(shape.id, shape.cells === 1 ? "1 camera" : shape.cells + " cameras (" + shape.id + ")");
    }
    addOption(TOUR, "Rotate cameras, one at a time");
    select.value = touring ? TOUR : layout;
    select.addEventListener("change", () => setLayout(select.value));
    controlsRoot.appendChild(select);
    const qualitySelect = doc.createElement("select");
    qualitySelect.id = "qualitySelect";
    qualitySelect.className = "quality-select";
    const choices = grid.LIVE_QUALITY_CHOICES;
    for (let i = 0; i < choices.length; i++) {
      const option = doc.createElement("option");
      option.value = choices[i].id;
      option.textContent = choices[i].label;
      option.selected = choices[i].id === quality;
      qualitySelect.appendChild(option);
    }
    qualitySelect.value = quality;
    qualitySelect.addEventListener("change", () => setQuality(qualitySelect.value));
    controlsRoot.appendChild(qualitySelect);
    const prev = barButton("prevPage", "Prev", () => prevPage());
    const next = barButton("nextPage", "Next", () => nextPage());
    // A wall with one page must not offer a page turn that does nothing.
    const singlePage = page.pageCount === 1;
    prev.disabled = singlePage;
    next.disabled = singlePage;
    controlsRoot.appendChild(prev);
    controlsRoot.appendChild(next);
    // One-based for the humans, and always drawn -- an operator who cannot
    // see "Page 1 of 3" does not know the other cameras exist.
    const pageLabel = doc.createElement("span");
    pageLabel.id = "pageLabel";
    pageLabel.textContent = "Page " + (pageIndex + 1) + " of " + page.pageCount;
    controlsRoot.appendChild(pageLabel);
    const fullscreen = barButton("fullscreen", "Full screen", () => toggleFullscreen());
    controlsRoot.appendChild(fullscreen);
  }

  function render() {
    const deviceIds = devices.map((d) => d.deviceId);
    let page = grid.gridPage({ cameraIds: deviceIds, layout, page: pageIndex });
    // gridPage clamps an out-of-range page; keep our index in step with it.
    if (pageIndex > page.pageCount - 1) {
      pageIndex = Math.max(0, page.pageCount - 1);
      page = grid.gridPage({ cameraIds: deviceIds, layout, page: pageIndex });
    }
    pageCount = page.pageCount;
    const shape = shapeFor(layout);
    gridRoot.style.display = "grid";
    gridRoot.style.gridTemplateColumns = "repeat(" + shape.columns + ", 1fr)";
    gridRoot.style.gap = "8px";
    emptyEl(gridRoot);
    // Every cell grid returns goes in, in order -- a dropped cell looks dead.
    const bodyForId = Object.create(null);
    const pageLike = { cells: [] };
    for (let i = 0; i < page.cells.length; i++) {
      const pageCell = page.cells[i];
      if (pageCell.kind !== "camera") {
        gridRoot.appendChild(buildEmptyCell(shape));
        pageLike.cells.push(pageCell);
        continue;
      }
      // gridPage lays out the ids we handed it, so cell.cameraId is a deviceId.
      const built = buildCameraCell(deviceIndex[pageCell.cameraId], shape);
      gridRoot.appendChild(built.cell);
      // A camera that resolved to no streams still gets its cell and warning,
      // but there is nothing to open. Leaving it out of the plan keeps a null
      // out of `streaming`, where the next redraw would try to close it.
      if (built.chosenId === null) continue;
      bodyForId[built.chosenId] = built.body;
      // pageLike re-expresses each camera cell with the CHOSEN stream id;
      // wallStreams only reads .kind and .cameraId.
      pageLike.cells.push({ kind: "camera", cameraId: built.chosenId });
    }
    const plan = grid.wallStreams(streaming, pageLike);
    // Close before open, always: opening first leaves both streams live at
    // once, and that is the moment a fully loaded wall stutters.
    for (let i = 0; i < plan.close.length; i++) {
      closeStream(plan.close[i]);
    }
    for (let i = 0; i < plan.open.length; i++) {
      openStream(plan.open[i], bodyForId[plan.open[i]], shape, quality);
    }
    if (moveStream) {
      for (let i = 0; i < plan.keep.length; i++) {
        moveStream(plan.keep[i], bodyForId[plan.keep[i]], shape, quality);
      }
    }
    // plan.keep streams never left the wall -- reopening one would cost a
    // black tile and a keyframe wait on every single page turn.
    streaming = plan.keep.concat(plan.open);
    renderControls(page);
  }

  function setDevices(nextDevices) {
    devices = nextDevices || [];
    deviceIndex = Object.create(null);
    for (let i = 0; i < devices.length; i++) {
      deviceIndex[devices[i].deviceId] = devices[i];
    }
    // The order the installer set IS the wall -- no sorting, no deduping.
    render();
  }

  function setLayout(id) {
    // An unknown id would desync the dropdown from the layout gridPage draws.
    if (id !== TOUR && !shapeFor(id)) return;
    touring = id === TOUR;
    layout = touring ? "1x1" : id;
    if (touring) pageIndex = 0;
    rememberLayout();
    syncTour();
    render();
  }

  function setQuality(id) {
    if (!knownQuality(id)) return;
    quality = id;
    if (storage) {
      try {
        storage.setItem(QUALITY_KEY, quality);
      } catch (err) {
        // a wall with no storage still has to show cameras
      }
    }
    render();
  }

  function syncTour() {
    if (tourTimer !== null) {
      timers.clearInterval(tourTimer);
      tourTimer = null;
    }
    if (touring) tourTimer = timers.setInterval(() => nextPage(), tourMs);
  }

  function setPage(n) {
    // No wrapping here -- gridPage clamps an out-of-range page.
    pageIndex = typeof n === "number" ? Math.max(0, n) : 0;
    render();
  }

  function nextPage() {
    // Wraps on the last page -- nobody is standing at this wall to see it stop.
    if (pageCount < 2) return;
    pageIndex = (pageIndex + 1) % pageCount;
    render();
  }

  function prevPage() {
    if (pageCount < 2) return;
    pageIndex = pageIndex === 0 ? pageCount - 1 : pageIndex - 1;
    render();
  }

  function setStream(deviceId, cameraId) {
    const device = deviceIndex[deviceId];
    if (!device) return;
    // An unknown cameraId would open a socket the grid never planned for.
    for (let i = 0; i < device.streams.length; i++) {
      if (device.streams[i].cameraId === cameraId) {
        chosenStream[deviceId] = cameraId;
        render();
        return;
      }
    }
  }

  function state() {
    // A copy, so a caller cannot mutate the wall's own bookkeeping.
    return {
      layout: layout,
      pageIndex: pageIndex,
      pageCount: pageCount,
      touring: touring,
      quality: quality,
      streaming: streaming.slice()
    };
  }

  function destroy() {
    touring = false;
    syncTour();
    for (let i = 0; i < streaming.length; i++) {
      closeStream(streaming[i]);
    }
    streaming = [];
    emptyEl(gridRoot);
    emptyEl(controlsRoot);
  }

  // A stale stored id must not stop the wall drawing.
  if (!shapeFor(layout)) {
    layout = "2x2";
  }

  syncTour();
  render();

  return {
    setDevices: setDevices,
    setLayout: setLayout,
    setQuality: setQuality,
    setPage: setPage,
    nextPage: nextPage,
    prevPage: prevPage,
    setStream: setStream,
    state: state,
    destroy: destroy
  };
}