/** Shared live sources: one ffmpeg (one camera session) per camera and
 *  quality, fanned out to every viewer.
 *
 *  THE FEARED FAILURES: every tile opening its own camera session, so a
 *  3-TV site (27 tiles) runs into the cameras' RTSP session limits and the
 *  appliance cap (FIELD-NOTES 2026-09-18, finding 2); a viewer that joins
 *  late getting the middle of a box, or a fragment with no init segment, and
 *  freezing; one slow viewer (a Mac Mini on Wi-Fi) stalling the camera for
 *  every TV; the source outliving its last viewer, or dying with its first;
 *  a source failure reaching some viewers and not others. */
import { createServer } from "node:http";
import { once, EventEmitter } from "node:events";
import { attachLive, liveRegistry, liveSources, closeAll, nextDelivery } from "../agent/live.mjs";
import { check, same, report } from "./_assert.mjs";

console.log("liveShare");

// ---------- the per-viewer delivery rule (pure) ----------

const LIM = { highWater: 1000, lowWater: 100 };

await check("THE FEARED ONE: a new viewer gets the init segment, then starts on a fragment, never mid-stream", () => {
  same(nextDelivery("awaiting_init", "fragment", 0, LIM), { send: false, next: "awaiting_init" }, "no fragment before init");
  same(nextDelivery("awaiting_init", "other", 0, LIM), { send: false, next: "awaiting_init" }, "no stray box before init");
  same(nextDelivery("awaiting_init", "init", 0, LIM), { send: true, next: "awaiting_keyframe" }, "init first");
  same(nextDelivery("awaiting_keyframe", "other", 0, LIM), { send: false, next: "awaiting_keyframe" }, "a stray box is not a start");
  same(nextDelivery("awaiting_keyframe", "fragment", 0, LIM), { send: true, next: "live" }, "joins on a fragment (frag_keyframe: it starts with a keyframe)");
  same(nextDelivery("live", "init", 0, LIM), { send: false, next: "live" }, "init is sent once");
});

await check("THE FEARED ONE: a slow viewer skips whole fragments and resumes on one; it never gets a partial", () => {
  same(nextDelivery("live", "fragment", 1000, LIM), { send: true, next: "live" }, "at the high-water mark: still sent");
  same(nextDelivery("live", "fragment", 1001, LIM), { send: false, next: "lagging" }, "over it: skipped, lagging");
  same(nextDelivery("lagging", "fragment", 101, LIM), { send: false, next: "lagging" }, "still draining: skipped");
  same(nextDelivery("lagging", "other", 0, LIM), { send: false, next: "lagging" }, "drained, but a stray box is not a place to resume");
  same(nextDelivery("lagging", "fragment", 100, LIM), { send: true, next: "live" }, "drained to low water: resumes on a fragment");
  same(nextDelivery("live", "other", 0, LIM), { send: true, next: "live" }, "a live viewer gets stray boxes in order");
  same(nextDelivery("live", "other", 1001, LIM), { send: false, next: "lagging" }, "but not while over the mark");
});

// ---------- WS integration: fake ffmpeg speaking fragmented MP4 ----------

function pseudoRandomBytes(len, seed) {
  const buf = Buffer.alloc(len);
  let s = seed;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = ((s >>> 16) & 0xff) | 1; // never zero
  }
  return buf;
}
const box = (type, len, seed) => {
  const b = Buffer.concat([Buffer.alloc(8), pseudoRandomBytes(len, seed)]);
  b.writeUInt32BE(8 + len, 0);
  b.write(type, 4, "latin1");
  return b;
};
const INIT = Buffer.concat([box("ftyp", 20, 1), box("moov", 700, 2)]);
const fragment = (n, mdatLen = 3000) => Buffer.concat([box("moof", 90, 100 + n), box("mdat", mdatLen, 200 + n)]);

let deferExit = false;
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  // deferExit: a real ffmpeg takes a moment to exit after SIGTERM.
  child.kill = () => { child.killed = true; if (!deferExit) queueMicrotask(() => child.emit("exit")); };
  return child;
}
const spawns = [];
const spawnFn = (cmd, args) => {
  const child = fakeChild();
  child.args = args;
  spawns.push(child);
  return child;
};
/** Emit `bytes` in awkward pieces: box boundaries never line up with chunks. */
const emitSplit = (child, bytes, cuts = [7, 333, 1201]) => {
  let at = 0;
  for (const c of cuts) {
    if (c > at && c < bytes.length) { child.stdout.emit("data", bytes.subarray(at, c)); at = c; }
  }
  child.stdout.emit("data", bytes.subarray(at));
};

const SUB = "rtsp://admin:pw@10.9.9.9:554/sub";
const config = {
  siteId: "t",
  credentials: { username: "admin", password: "pw" },
  cameras: [
    { cameraId: "cam-1", url: "rtsp://admin:pw@10.9.9.1:554/main" },
    { cameraId: "cam-2", url: "rtsp://admin:pw@10.9.9.2:554/main" },
    { cameraId: "cam-3", url: "rtsp://admin:pw@10.9.9.3:554/main", substreamUrl: SUB },
  ],
};

const server = createServer(() => {});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
attachLive(server, {
  config, spawnFn, authorize: () => ({ kind: "allow" }),
  maxSourcesPerCamera: 2, maxSources: 2, maxViewers: 5,
});

const inbox = new WeakMap();
const wsOpen = (path) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.binaryType = "arraybuffer";
    const q = { msgs: [], waiters: [] };
    inbox.set(ws, q);
    ws.addEventListener("message", (ev) => {
      const b = typeof ev.data === "string" ? Buffer.from(ev.data) : Buffer.from(new Uint8Array(ev.data));
      const w = q.waiters.shift();
      if (w) w(b); else q.msgs.push(b);
    });
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 3000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); });
  });
const next = (ws, ms = 3000) => {
  const q = inbox.get(ws);
  if (q.msgs.length) return Promise.resolve(q.msgs.shift());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("message timeout")), ms);
    q.waiters.push((b) => { clearTimeout(t); resolve(b); });
  });
};
const closed = (ws, ms = 3000) =>
  new Promise((resolve) => {
    if (ws.readyState === 3) return resolve("closed");
    const t = setTimeout(() => resolve("timeout"), ms);
    ws.addEventListener("close", () => { clearTimeout(t); resolve("closed"); }, { once: true });
  });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, what, ms = 2000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await settle(10); }
};
const shutAll = async (...sockets) => { for (const w of sockets) { w.close(); await closed(w); } await settle(); };

await check("THE FEARED ONE: two viewers of one camera share ONE ffmpeg, and both get the same bytes, box-exact", async () => {
  const before = spawns.length;
  const a = await wsOpen("/live/cam-1");
  const b = await wsOpen("/live/cam-1");
  await until(() => liveRegistry().size === 2, "two viewers");
  same(spawns.length - before, 1, "one camera session for two viewers");
  const child = spawns[spawns.length - 1];
  const f1 = fragment(1, 70000); // > 65535: the 64-bit frame path
  emitSplit(child, Buffer.concat([INIT, f1]));
  for (const [name, ws] of [["a", a], ["b", b]]) {
    same((await next(ws)).equals(INIT), true, `${name}: init segment, whole and exact`);
    same((await next(ws)).equals(f1), true, `${name}: first fragment, whole and exact`);
  }
  same(liveSources().size, 1, "one source");
  await shutAll(a, b);
});

await check("THE FEARED ONE: a late joiner gets the stored init, then the NEXT fragment, never a tail", async () => {
  const a = await wsOpen("/live/cam-1");
  await until(() => liveSources().size === 1, "source");
  const child = spawns[spawns.length - 1];
  const f1 = fragment(1), f2 = fragment(2), f3 = fragment(3);
  emitSplit(child, Buffer.concat([INIT, f1]));
  await next(a); await next(a);
  // Half of f2 has arrived when the second viewer joins.
  child.stdout.emit("data", f2.subarray(0, 500));
  const late = await wsOpen("/live/cam-1");
  await until(() => liveRegistry().size === 2, "late viewer registered");
  child.stdout.emit("data", f2.subarray(500));
  child.stdout.emit("data", f3);
  same((await next(late)).equals(INIT), true, "late: the stored init first");
  const first = await next(late);
  same(first.equals(f2) || first.equals(f3), true, "late: starts on a whole fragment");
  same(first.subarray(4, 8).toString("latin1"), "moof", "which begins with a moof");
  same((await next(a)).equals(f2), true, "the first viewer is unaffected");
  same((await next(a)).equals(f3), true, "and keeps its order");
  await shutAll(a, late);
});

await check("THE FEARED ONE: the source outlives a leaving viewer, and stops with the last one", async () => {
  const a = await wsOpen("/live/cam-2");
  const b = await wsOpen("/live/cam-2");
  await until(() => liveRegistry().size === 2, "two viewers");
  const child = spawns[spawns.length - 1];
  a.close(); await closed(a); await settle();
  same(child.killed, false, "still running for the other viewer");
  same(liveSources().size, 1, "source kept");
  b.close(); await closed(b); await settle(100);
  same(child.killed, true, "stopped with the last viewer");
  same(liveSources().size, 0, "source released");
  same(liveRegistry().size, 0, "no viewers left");
});

await check("THE FEARED ONE: a source that dies tells EVERY viewer why, and frees its slot", async () => {
  const a = await wsOpen("/live/cam-1");
  const b = await wsOpen("/live/cam-1");
  await until(() => liveRegistry().size === 2, "two viewers");
  const child = spawns[spawns.length - 1];
  emitSplit(child, Buffer.concat([INIT, fragment(1)]));
  await next(a); await next(a); await next(b); await next(b);
  child.stderr.emit("data", Buffer.from("rtsp://admin:pw@10.9.9.1 connection reset\nfatal: source closed on us\n"));
  child.emit("exit");
  for (const [name, ws] of [["a", a], ["b", b]]) {
    const env = JSON.parse((await next(ws)).toString());
    same([env.ok, env.code], [false, "live_ended"], `${name}: told the source ended`);
    same(env.message.includes("pw@"), false, `${name}: no credential in the reason`);
    same(await closed(ws), "closed", `${name}: closed`);
  }
  await settle();
  same(liveSources().size, 0, "source freed");
  same(liveRegistry().size, 0, "viewers freed");
});

await check("main and sub of one camera are separate sources; the sub uses its own URL", async () => {
  const before = spawns.length;
  const m = await wsOpen("/live/cam-3?quality=mainstream");
  const s = await wsOpen("/live/cam-3?quality=substream");
  await until(() => liveSources().size === 2, "two sources");
  same(spawns.length - before, 2, "two camera sessions");
  same(spawns[spawns.length - 1].args.includes(SUB), true, "substream URL used verbatim");
  await shutAll(m, s);
});

await check("THE FEARED ONE: the caps count camera sessions and viewers separately", async () => {
  // maxSources 2, maxViewers 5. Two cameras streaming, five tiles watching.
  const tiles = [];
  for (let i = 0; i < 3; i++) tiles.push(await wsOpen("/live/cam-1"));
  tiles.push(await wsOpen("/live/cam-2"));
  await until(() => liveRegistry().size === 4 && liveSources().size === 2, "4 viewers on 2 sources");
  // A third camera needs a third session: refused as stream_limit.
  const third = await wsOpen("/live/cam-3");
  const env = JSON.parse((await next(third)).toString());
  same(env.code, "stream_limit", "a new source past maxSources");
  await closed(third);
  // Another tile of a streaming camera needs no session: accepted.
  tiles.push(await wsOpen("/live/cam-2"));
  await until(() => liveRegistry().size === 5, "fifth viewer shares");
  same(liveSources().size, 2, "still two sessions");
  // The sixth viewer is past maxViewers, even though it would share.
  const sixth = await wsOpen("/live/cam-1");
  same(JSON.parse((await next(sixth)).toString()).code, "viewer_limit", "past maxViewers");
  await closed(sixth);
  await shutAll(...tiles);
  same(liveSources().size, 0, "all released");
});

await check("THE FEARED ONE: reopening a camera while its old ffmpeg is still exiting gets a fresh source the old exit never touches", async () => {
  // A wall redraw closes a tile and reopens the same camera at once.
  deferExit = true;
  const a = await wsOpen("/live/cam-2");
  await until(() => liveSources().size === 1, "source");
  const old = spawns[spawns.length - 1];
  a.close(); await closed(a); await settle();
  same(old.killed, true, "the old ffmpeg was told to stop");
  same(liveSources().size, 0, "a dying source is no longer joinable");
  const b = await wsOpen("/live/cam-2");
  await until(() => liveSources().size === 1, "a fresh source");
  const fresh = spawns[spawns.length - 1];
  same(fresh !== old, true, "a new ffmpeg, not the dying one");
  deferExit = false;
  old.emit("exit"); // the old one finally exits
  await settle();
  same(liveSources().size, 1, "the fresh source survives the old exit");
  same(liveRegistry().size, 1, "and so does its viewer");
  emitSplit(fresh, Buffer.concat([INIT, fragment(1)]));
  same((await next(b)).equals(INIT), true, "which still streams");
  await shutAll(b);
});

await check("closeAll stops every source and drops every viewer", async () => {
  const a = await wsOpen("/live/cam-1");
  const b = await wsOpen("/live/cam-2");
  await until(() => liveSources().size === 2, "two sources");
  const kids = spawns.slice(-2);
  closeAll();
  await settle(100);
  same(kids.every((k) => k.killed), true, "both ffmpegs stopped");
  same([liveSources().size, liveRegistry().size], [0, 0], "nothing left");
  await closed(a); await closed(b);
});

server.close();
report("liveShare");
