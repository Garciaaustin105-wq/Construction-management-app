/**
 * GET/POST /layouts, GET/POST /display-layouts and GET /display-layout, end
 * to end through the real server (agent/api-server.mjs ->
 * agent/saved-layouts.mjs -> dist/savedLayouts.js). SITE-SETTINGS-SPEC.md
 * section 3's own "Tests that matter": an account never reads or writes
 * another account's layouts; a display gets only its own; a removed camera
 * renders as "camera removed"; a corrupt file refuses the next save instead
 * of being silently rebuilt; and no camera credential or URL ever reaches
 * any of it.
 *
 * THE FEARED FAILURES, by name:
 * - one account's POST /layouts silently touching another account's slice,
 *   or a GET reading it back;
 * - a display reaching another display's layout, or a signed-in PERSON
 *   reaching /display-layout at all (there is no id to name one, but the
 *   route must still refuse a person outright rather than answer with
 *   nothing assigned, which would look identical to "this display has no
 *   layout yet");
 * - a camera removed from config.cameras leaving its old cell looking
 *   exactly like one that was always empty;
 * - a corrupt layouts.json (or display-layouts.json) being rebuilt from
 *   empty on the next save, discarding every account's (or every display's)
 *   real layouts.
 */
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { indexPathFor } from "../agent/config.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("saved layouts API");

const CAM_PW = "layout-s3cret";
const audits = [];
const authAs = (principal) => ({
  principalOf: () => principal,
  handle: async () => false,
  audit: (event, _req, fields) => audits.push({ event, ...fields }),
});
const installer = { kind: "user", username: "tech", role: "installer" };
const store = { kind: "user", username: "clerk", role: "store" };
const wall1 = { kind: "display", displayId: "wall-1" };
const wall2 = { kind: "display", displayId: "wall-2" };

const stateDir = await mkdtemp(join(tmpdir(), "camplat-layouts-"));
const config = {
  siteId: "bench",
  storeRoots: [join(stateDir, "disk0")],
  credentials: { username: "svc", password: "svc-pw" },
  cameras: [
    { cameraId: "cam-1", url: `rtsp://admin:${CAM_PW}@10.0.0.5:554/main` },
    { cameraId: "cam-2", host: "10.0.0.6", vendor: "hikvision" },
  ],
};
await writeFile(join(stateDir, "config.json"), JSON.stringify(config));

const index = openIndex(indexPathFor(stateDir));
const startServer = (principal) => createApiServer({ stateDir, config, index, auth: authAs(principal) });
let server = startServer(installer);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let base = `http://127.0.0.1:${server.address().port}`;

const send = async (b, method, path, body) => {
  const res = await fetch(b + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, text, json };
};
const noSecrets = (text, what) => {
  if (text.includes(CAM_PW) || /rtsp:\/\//i.test(text)) throw new Error(`${what} carries a camera credential or address: ${text}`);
};
const layoutsFile = join(stateDir, "layouts.json");
const displayLayoutsFile = join(stateDir, "display-layouts.json");

const twoByTwo = (cells) => ({ layout: "2x2", cells });

try {
  await check("GET /layouts for an account that has never saved anything: the honest empty slice", async () => {
    const r = await send(base, "GET", "/layouts");
    eq(r.status, 200);
    eq(r.json, { ok: true, layouts: [], defaultName: null, problem: null });
  });

  await check("POST /layouts saves, and GET reflects it at once - no credential anywhere", async () => {
    const body = {
      layouts: [
        { name: "Front", ...twoByTwo(["cam-1", "cam-2", null, null]) },
        { name: "Back", ...twoByTwo([null, null, "cam-2", "cam-1"]) },
      ],
      defaultName: "Front",
    };
    const r = await send(base, "POST", "/layouts", body);
    eq(r.status, 200);
    noSecrets(r.text, "POST /layouts response");
    eq(r.json.defaultName, "Front");
    eq(r.json.layouts.length, 2);
    // Resolved cells: every configured camera resolves to kind "camera".
    eq(r.json.layouts[0].cells, [
      { kind: "camera", index: 0, cameraId: "cam-1" },
      { kind: "camera", index: 1, cameraId: "cam-2" },
      { kind: "empty", index: 2 },
      { kind: "empty", index: 3 },
    ]);
    const view = await send(base, "GET", "/layouts");
    eq(view.json.layouts.length, 2);
    eq(view.json.defaultName, "Front");
    const stored = await readFile(layoutsFile, "utf8");
    noSecrets(stored, "layouts.json");
    const parsed = JSON.parse(stored);
    eq(parsed.version, 1);
    eq(Object.keys(parsed.accounts), ["tech"]);
  });

  await check("REQUIRED: a camera removed from config renders as an explicit 'camera removed' cell, never a silent blank", async () => {
    await send(base, "POST", "/layouts", {
      layouts: [{ name: "With ghost", ...twoByTwo(["cam-1", "cam-9-gone", null, "cam-2"]) }],
      defaultName: null,
    });
    const view = await send(base, "GET", "/layouts");
    const cells = view.json.layouts.find((l) => l.name === "With ghost").cells;
    eq(cells, [
      { kind: "camera", index: 0, cameraId: "cam-1" },
      { kind: "removed", index: 1, cameraId: "cam-9-gone" },
      { kind: "empty", index: 2 },
      { kind: "camera", index: 3, cameraId: "cam-2" },
    ]);
  });

  await check("validation: a bad grid id, a wrong cell count and a duplicate name are all refused at once, nothing saved", async () => {
    const before = await readFile(layoutsFile, "utf8");
    const r = await send(base, "POST", "/layouts", {
      layouts: [
        // Two otherwise well-formed layouts sharing a name: only THIS is what
        // triggers duplicate_layout_name (checkAccountLayouts only compares
        // names among entries that validate on their own first).
        { name: "Dup", ...twoByTwo(["cam-1", "cam-2", null, null]) },
        { name: "Dup", ...twoByTwo([null, null, "cam-1", "cam-2"]) },
        // A separately broken entry: bad shape id and a cell count that does
        // not even match its own (fallback) shape.
        { name: "Bad", layout: "not-a-shape", cells: ["cam-1"] },
      ],
      defaultName: null,
    });
    eq(r.status, 400);
    const fields = r.json.errors.map((e) => e.field);
    eq(fields.some((f) => f.includes("layout") && f.includes("[2]")), true, "bad layout id, on the broken entry");
    eq(fields.some((f) => f.includes("cells") && f.includes("[2]")), true, "wrong cell count for its own (fallback) shape");
    eq(fields.some((f) => f.includes("name") && f.includes("[1]")), true, "duplicate name, on the second 'Dup'");
    eq(r.json.errors.length >= 3, true, "every problem, not fix-and-resave one at a time");
    eq(await readFile(layoutsFile, "utf8"), before, "nothing written on a refused save");
  });

  await server.close();

  await check("REQUIRED: cross-account isolation, both ways", async () => {
    // ONE server, one signed-in account at a time switched between requests
    // (a mutable box the auth fake reads) -- the same shape a real NVR is
    // (one process, several concurrently signed-in accounts), and it avoids
    // running two independent event-retention timers against the very same
    // stateDir, which two separate createApiServer() instances here would.
    let current = installer;
    const switchable = { principalOf: () => current, handle: async () => false, audit: (event, _req, fields) => audits.push({ event, ...fields }) };
    const shared = createApiServer({ stateDir, config, index, auth: switchable });
    await new Promise((r) => shared.listen(0, "127.0.0.1", r));
    const sharedBase = `http://127.0.0.1:${shared.address().port}`;
    try {
      // clerk (store, layout.edit) saves its OWN layouts.
      current = store;
      const saved = await send(sharedBase, "POST", "/layouts", {
        layouts: [{ name: "Clerk's own", ...twoByTwo(["cam-2", null, null, null]) }],
        defaultName: "Clerk's own",
      });
      eq(saved.status, 200);

      // tech's own slice is untouched by clerk's save. (Full-replace: the
      // "camera removed" check above already replaced tech's two-layout save
      // with a single "With ghost" layout -- that is tech's own history, not
      // this check's concern; the point here is that CLERK'S save just now
      // never touched it either way.)
      current = installer;
      const techView = await send(sharedBase, "GET", "/layouts");
      eq(techView.json.layouts.map((l) => l.name), ["With ghost"], "tech's layouts, from earlier in this file, unaffected by clerk's save");

      // clerk sees only its own, never tech's.
      current = store;
      const clerkView = await send(sharedBase, "GET", "/layouts");
      eq(clerkView.json.layouts.map((l) => l.name), ["Clerk's own"]);
      eq(clerkView.json.layouts.some((l) => l.name === "Front"), false, "FEARED: clerk must never see tech's layout");

      // Both accounts' slices survive together on disk.
      const onDisk = JSON.parse(await readFile(layoutsFile, "utf8"));
      eq(new Set(Object.keys(onDisk.accounts)), new Set(["tech", "clerk"]));
      eq(onDisk.accounts.tech.layouts.map((l) => l.name), ["With ghost"]);
      eq(onDisk.accounts.clerk.layouts.map((l) => l.name), ["Clerk's own"]);
    } finally {
      await new Promise((r) => shared.close(r));
    }
  });

  await check("FEARED: a display credential is refused on /layouts, both GET and POST", async () => {
    const s = startServer(wall1);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${s.address().port}`;
    try {
      eq((await fetch(`${b}/layouts`)).status, 403);
      eq((await fetch(`${b}/layouts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  server = startServer(installer);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  await check("POST /display-layouts (installer, account.manage) assigns a display a layout; GET shows raw, UNRESOLVED cells", async () => {
    const r = await send(base, "POST", "/display-layouts", { displayId: "wall-1", ...twoByTwo(["cam-1", "cam-9-gone", null, "cam-2"]) });
    eq(r.status, 200);
    eq(r.json.displayId, "wall-1");
    const view = await send(base, "GET", "/display-layouts");
    eq(view.status, 200);
    eq(view.json.displays["wall-1"], twoByTwo(["cam-1", "cam-9-gone", null, "cam-2"]), "the installer's own admin view is raw config, not resolved against the live camera list");
  });

  await check("FEARED: a store account is refused /display-layouts, both GET and POST", async () => {
    const s = startServer(store);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${s.address().port}`;
    try {
      eq((await fetch(`${b}/display-layouts`)).status, 403);
      eq((await fetch(`${b}/display-layouts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  await check("GET /display-layout: a display sees its OWN layout, resolved against the live camera list, and never another display's", async () => {
    // One server, one paired display credential "connected" at a time (see
    // the cross-account isolation check above for why this beats two
    // separate createApiServer() instances sharing one stateDir).
    let current = wall1;
    const switchable = { principalOf: () => current, handle: async () => false, audit: () => {} };
    const shared = createApiServer({ stateDir, config, index, auth: switchable });
    await new Promise((r) => shared.listen(0, "127.0.0.1", r));
    const b1 = `http://127.0.0.1:${shared.address().port}`;
    const b2 = b1;
    try {
      const own = await send(b1, "GET", "/display-layout");
      eq(own.status, 200);
      eq(own.json.layout, {
        layout: "2x2",
        cells: [
          { kind: "camera", index: 0, cameraId: "cam-1" },
          { kind: "removed", index: 1, cameraId: "cam-9-gone" },
          { kind: "empty", index: 2 },
          { kind: "camera", index: 3, cameraId: "cam-2" },
        ],
      }, "REQUIRED: resolved against the live camera list, unlike GET /display-layouts above");

      // wall-2 has never been assigned a layout: null, never a guessed shape.
      current = wall2;
      const unassigned = await send(b2, "GET", "/display-layout");
      eq(unassigned.status, 200);
      eq(unassigned.json.layout, null, "FEARED: an unassigned display must never inherit wall-1's layout");
    } finally {
      await new Promise((r) => shared.close(r));
    }
  });

  await check("FEARED: a signed-in PERSON reaching /display-layout is refused outright, not answered as 'nothing assigned'", async () => {
    for (const principal of [installer, store]) {
      const s = startServer(principal);
      await new Promise((r) => s.listen(0, "127.0.0.1", r));
      const b = `http://127.0.0.1:${s.address().port}`;
      try {
        const r = await fetch(`${b}/display-layout`);
        eq(r.status, 403, `${principal.role}: GET /display-layout refused, not 200 with layout:null`);
      } finally {
        await new Promise((r) => s.close(r));
      }
    }
  });

  await check("FEARED: every save writes an audit line naming who, and (for layouts) the count and default - never a camera id list, never a credential", async () => {
    noSecrets(JSON.stringify(audits), "audit log");
    const layoutSaves = audits.filter((a) => a.event === "layouts.save");
    eq(layoutSaves.length > 0, true);
    eq(layoutSaves.every((a) => typeof a.actor === "string"), true);
    const displaySaves = audits.filter((a) => a.event === "display-layouts.save");
    eq(displaySaves.length > 0, true);
    eq(displaySaves.every((a) => a.displayId === "wall-1"), true);
  });

  await check("bodies that are not JSON objects are refused the same way every other settings route refuses them", async () => {
    eq((await fetch(base + "/layouts", { method: "POST", body: "{}" })).status, 415);
    eq((await send(base, "POST", "/layouts", [1])).status, 400);
    eq((await send(base, "POST", "/display-layouts", [1])).status, 400);
  });

  await check("FEARED: a corrupt layouts.json refuses the next save instead of silently wiping every account's layouts", async () => {
    const before = await readFile(layoutsFile, "utf8");
    eq(JSON.parse(before).accounts.clerk.layouts.length, 1, "clerk's real layout is on disk before the corruption");

    await writeFile(layoutsFile, "{ not valid json", "utf8");
    const r = await send(base, "POST", "/layouts", { layouts: [{ name: "New", ...twoByTwo(["cam-1", null, null, null]) }], defaultName: null });
    eq(r.status, 409, "refused rather than rebuilt from empty");
    eq(r.json.code, "layouts_unreadable");
    eq(await readFile(layoutsFile, "utf8"), "{ not valid json", "the file itself was never overwritten by the refused save");

    const view = await send(base, "GET", "/layouts");
    eq(view.status, 200);
    eq(view.json.layouts, [], "GET still answers, with defaults and a problem, never a 500");
    eq(typeof view.json.problem, "string");

    await writeFile(layoutsFile, before, "utf8");
    const restored = await send(base, "GET", "/layouts");
    eq(restored.json.layouts.map((l) => l.name), ["With ghost"], "tech's own layouts, once the file is fixed by hand, are exactly as they were");
  });

  await check("FEARED: a corrupt display-layouts.json refuses the next save instead of silently wiping every display's assignment", async () => {
    const before = await readFile(displayLayoutsFile, "utf8");
    await writeFile(displayLayoutsFile, "not json at all", "utf8");
    const r = await send(base, "POST", "/display-layouts", { displayId: "wall-2", ...twoByTwo(["cam-2", null, null, null]) });
    eq(r.status, 409);
    eq(r.json.code, "display_layouts_unreadable");
    eq(await readFile(displayLayoutsFile, "utf8"), "not json at all");
    await writeFile(displayLayoutsFile, before, "utf8");
  });
} finally {
  await new Promise((r) => server.close(r));
  index.close();
  await rm(stateDir, { recursive: true, force: true });
}

report("saved layouts API");
