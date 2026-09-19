/** The live transport. The fears pinned here, in order: a masked client frame
 *  handled unmasked corrupts silently; a frame split across TCP chunks gets
 *  misread with a short payload; a refusal without an envelope hides the bug
 *  behind a bare close; a dead ffmpeg child never tells the client; and the
 *  credential-bearing URL riding along in ANY failure message. The WS
 *  integration runs against a FAKE spawnFn producing deterministic
 *  pseudo-random bytes — the zero-filled-fixture lesson: zero bytes would
 *  make a corrupted-frame bug pass vacuously. */
import { createServer } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import {
  wsAcceptKey, parseClientFrame, encodeServerFrame, deadStreams,
  attachLive, liveRegistry, closeAll,
} from "../agent/live.mjs";
import { check, same, report } from "./_assert.mjs";

console.log("live");

// ---------- pure helpers (no sockets) ----------

await check("wsAcceptKey matches the RFC 6455 worked example", () => {
  same(wsAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "RFC 6455 example");
});

await check("parseClientFrame unmasks a masked client frame — THE FEARED ONE", () => {
  const payload = Buffer.from("close-please");
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.alloc(2 + 4 + payload.length);
  masked[0] = 0x80 | 8; // fin + close
  masked[1] = 0x80 | payload.length; // MASKED
  mask.copy(masked, 2);
  for (let i = 0; i < payload.length; i++) masked[6 + i] = payload[i] ^ mask[i % 4];
  const f = parseClientFrame(masked);
  same([f.opcode, f.payload.toString()], [8, "close-please"], "unmasked correctly");
  same(f.frameLength, masked.length, "full frame consumed");
});

await check("parseClientFrame returns null on a frame split across TCP chunks", () => {
  const big = Buffer.alloc(70000, 7);
  const header = Buffer.alloc(10);
  header[0] = 0x80 | 2;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(big.length), 2);
  const partial = Buffer.concat([header, big.subarray(0, 100)]); // header says 70000, only 100 here
  same(parseClientFrame(partial), null, "short 64-bit frame waits");
  const shortHeader = Buffer.from([0x80 | 1, 126]); // 16-bit length header not yet complete
  same(parseClientFrame(shortHeader), null, "truncated header waits");
  same(parseClientFrame(Buffer.from([0x80 | 8])), null, "one byte waits");
});

await check("parseClientFrame handles a plain (unmasked) 64-bit-length frame", () => {
  const big = Buffer.alloc(70000, 0xab);
  const header = Buffer.alloc(10);
  header[0] = 0x80 | 2;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(big.length), 2);
  const f = parseClientFrame(Buffer.concat([header, big]));
  same([f.opcode, f.payload.length], [2, 70000], "big frame read whole");
  same(f.payload[12345], 0xab, "payload intact");
});

await check("encodeServerFrame never masks and round-trips through parseClientFrame at all three length widths", () => {
  for (const size of [5, 126, 65536]) {
    const payload = Buffer.alloc(size, 0x5a);
    const enc = encodeServerFrame(2, payload);
    same((enc[1] & 0x80) !== 0, false, `size ${size}: server frames are NEVER masked`);
    const dec = parseClientFrame(enc);
    same([dec.opcode, dec.payload.length, dec.payload[0]], [2, size, 0x5a], `size ${size} round-trip`);
    same(dec.frameLength, enc.length, `size ${size} consumed exactly`);
  }
});

await check("deadStreams runs on fake time; a stream that never emitted a byte stalls off startedAt", () => {
  const reg = new Map([
    ["fresh", { startedAt: 1000, lastBytesAt: 9000 }],
    ["stale", { startedAt: 1000, lastBytesAt: 2000 }],
    ["never-started", { startedAt: 1000, lastBytesAt: null }],
  ]);
  same(deadStreams(reg, 10000, 15000), [], "nothing dead under 15s");
  same(deadStreams(reg, 17001, 15000), ["stale", "never-started"], "stale + never-started flagged");
});

// ---------- WS integration against a fake spawnFn ----------

const SECRET_URL = "rtsp://admin:s3cret-pw@10.9.9.9:554/ch1";
const SUB_URL = "rtsp://admin:s3cret-pw@10.9.9.9:554/ch0";

/** Deterministic pseudo-random byte generator — never zeros, so a frame
 *  corruption bug cannot pass vacuously. */
function pseudoRandomBytes(len, seed) {
  const buf = Buffer.alloc(len);
  let s = seed;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (s >>> 16) & 0xff;
  }
  return buf;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit"));
  };
  return child;
}

const spawnCalls = [];
let pendingChild = null;
const spawnFn = (cmd, args) => {
  const child = fakeChild();
  child.args = args;
  spawnCalls.push(child);
  return child;
};

const config = {
  siteId: "test-site",
  credentials: { username: "admin", password: "s3cret-pw" },
  cameras: [
    { cameraId: "cam-1", url: SECRET_URL }, // manual url, credentials embedded
    { cameraId: "cam-2" },                  // hostless: cannot resolve, cannot derive
    { cameraId: "cam-3", host: "10.9.9.9", vendor: "hikvision", channel: 1,
      substreamUrl: SUB_URL },              // manual substream override wins
  ],
};

const server = createServer(() => {});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
// One source per camera here, so camera_busy is reachable (main + sub of one
// camera); sharing itself is pinned in liveShare.harness.mjs.
attachLive(server, { config, spawnFn, maxSourcesPerCamera: 1, maxSources: 16, maxViewers: 64, authorize: () => ({ kind: "allow" }) });

/** A top-level MP4 box with a never-zero pseudo-random payload. */
const mp4Box = (type, len, seed) => {
  const b = Buffer.concat([Buffer.alloc(8), pseudoRandomBytes(len, seed)]);
  b.writeUInt32BE(8 + len, 0);
  b.write(type, 4, "latin1");
  return b;
};

const wsOpen = (path) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.binaryType = "arraybuffer"; // native client delivers binary as ArrayBuffer, not Buffer
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 3000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error("ws error: " + (e.error?.message ?? e.message ?? "unknown"))); });
  });
const nextMessage = (ws, ms = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), ms);
    ws.addEventListener("message", (ev) => {
      clearTimeout(timer);
      resolve(ev.data instanceof Buffer ? ev.data : Buffer.from(ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data));
    }, { once: true });
  });
const nextClose = (ws, ms = 3000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    ws.addEventListener("close", () => { clearTimeout(timer); resolve("closed"); }, { once: true });
  });

await check("happy path: binary frames arrive byte-exact; the negotiated stream is in the registry", async () => {
  const ws = await wsOpen("/live/cam-1");
  const child = spawnCalls[spawnCalls.length - 1];
  // The source is split into whole boxes (init, then moof+mdat fragments) so
  // it can be shared; the bytes of each must still arrive exact.
  const init = Buffer.concat([mp4Box("ftyp", 20, 41), mp4Box("moov", 480, 42)]);
  const frag = Buffer.concat([mp4Box("moof", 90, 76), mp4Box("mdat", 70000, 77)]); // > 65535: the 64-bit path
  const all = Buffer.concat([init, frag]);
  child.stdout.emit("data", all.subarray(0, 300));
  child.stdout.emit("data", all.subarray(300));
  const mA = await nextMessage(ws);
  same(mA.equals(init), true, "init segment byte-exact");
  const mB = await nextMessage(ws);
  same(mB.equals(frag), true, "fragment byte-exact (64-bit length path)");
  const reg = liveRegistry();
  same(reg.size, 1, "one live stream");
  const entry = [...reg.values()][0];
  same([entry.cameraId, entry.quality], ["cam-1", "mainstream"], "registry entry");
  same(entry.bytesSent, true, "bytes flagged");
  ws.close();
  await nextClose(ws);
});

await check("client close kills the child and frees the slot — the manual path is never second-class", async () => {
  const ws = await wsOpen("/live/cam-1");
  const child = spawnCalls[spawnCalls.length - 1];
  same(liveRegistry().size, 1, "stream held");
  ws.close(); // native client sends a MASKED close frame — this is the unmasking path live
  await nextClose(ws);
  await new Promise((r) => setTimeout(r, 100)); // let the exit handler land
  same(child.killed, true, "fake child killed");
  same(liveRegistry().size, 0, "slot freed");
  // the freed slot renegotiates cleanly
  const again = await wsOpen("/live/cam-1");
  same(liveRegistry().size, 1, "renegotiation ok after close");
  again.close();
  await nextClose(again);
  await new Promise((r) => setTimeout(r, 100));
});

await check("unknown camera: JSON refusal THEN close — never a bare close, and no busy leak", async () => {
  const ws = await wsOpen("/live/nope");
  const msg = await nextMessage(ws);
  const env = JSON.parse(msg.toString());
  same([env.ok, env.code], [false, "unknown_camera"], "refusal envelope");
  same(env.message.includes("nope"), false, "no id echo needed either way");
  same(await nextClose(ws), "closed", "closed after refusal");
  same(liveRegistry().size, 0, "refused client holds no slot");
});

await check("bad_quality refused before negotiation", async () => {
  const ws = await wsOpen("/live/cam-1?quality=ultra");
  const env = JSON.parse((await nextMessage(ws)).toString());
  same([env.ok, env.code], [false, "bad_quality"], "bad_quality envelope");
  await nextClose(ws);
});

await check("child exit with no bytes -> live_source_failed carrying stderr tail, NEVER the url", async () => {
  const ws = await wsOpen("/live/cam-1");
  const child = spawnCalls[spawnCalls.length - 1];
  child.stderr.emit("data", Buffer.from("rtsp demuxer: connection refused\nlast line here\n"));
  child.emit("exit");
  const env = JSON.parse((await nextMessage(ws)).toString());
  same([env.ok, env.code], [false, "live_source_failed"], "no-bytes exit code");
  same(env.message.includes("last line here"), true, "stderr tail carried");
  same(
    [env.message.includes("s3cret-pw"), env.message.includes("10.9.9.9"), env.message.includes("rtsp://")],
    [false, false, false],
    "THE FEARED ONE: no credential, host, or scheme in the message",
  );
  await nextClose(ws);
  same(liveRegistry().size, 0, "entry released");
});

await check("child exit after bytes -> live_ended with the last stderr line", async () => {
  const ws = await wsOpen("/live/cam-1");
  const child = spawnCalls[spawnCalls.length - 1];
  // Bytes flowed: a whole init segment (the source forwards whole boxes only).
  child.stdout.emit("data", Buffer.concat([mp4Box("ftyp", 20, 5), mp4Box("moov", 200, 6)]));
  await nextMessage(ws); // drain the init frame
  child.stderr.emit("data", Buffer.from("warning: something\nfatal: source closed on us\n"));
  child.emit("exit");
  const env = JSON.parse((await nextMessage(ws)).toString());
  same([env.ok, env.code], [false, "live_ended"], "after-bytes exit code");
  same(env.message, "fatal: source closed on us", "last stderr line");
  same(env.message.includes("s3cret-pw"), false, "no credential");
  await nextClose(ws);
});

await check("camera_busy when a camera would need a session past its cap; a second viewer never does", async () => {
  const before = spawnCalls.length;
  const w1 = await wsOpen("/live/cam-1");
  const w2 = await wsOpen("/live/cam-1");
  same(liveRegistry().size, 2, "two viewers held");
  same(spawnCalls.length - before, 1, "sharing one source");
  const m = await wsOpen("/live/cam-3?quality=mainstream");
  const s = await wsOpen("/live/cam-3?quality=substream");
  const env = JSON.parse((await nextMessage(s)).toString());
  same([env.ok, env.code], [false, "camera_busy"], "cam-3's second session refused (maxSourcesPerCamera 1)");
  await nextClose(s);
  for (const w of [w1, w2, m]) { w.close(); await nextClose(w); }
  await new Promise((r) => setTimeout(r, 100));
});

await check("manual substreamUrl used VERBATIM in the spawn argv", async () => {
  const before = spawnCalls.length;
  const ws = await wsOpen("/live/cam-3?quality=substream");
  same(spawnCalls.length, before + 1, "spawned once");
  const args = spawnCalls[spawnCalls.length - 1].args;
  same(args[args.indexOf("-i") + 1], SUB_URL, "the manual substream URL, verbatim, right after -i");
  const entry = [...liveRegistry().values()].find((e) => e.cameraId === "cam-3");
  same(entry?.quality, "substream", "negotiated as the substream");
  ws.close();
  await nextClose(ws);
  await new Promise((r) => setTimeout(r, 100));
});

await check("substream with no source: resolves on main but cannot derive, no manual url -> substream_unavailable; unresolved still outranks it", async () => {
  // cam-1 resolves fine (manual url) but has no host: no manual substreamUrl, no vendor rule
  const ws = await wsOpen("/live/cam-1?quality=substream");
  const env = JSON.parse((await nextMessage(ws)).toString());
  same([env.ok, env.code], [false, "substream_unavailable"], "no substream source for a resolvable camera");
  await nextClose(ws);
  // a camera that cannot resolve at all never gets to the substream question: order 2 beats order 3
  const ws2 = await wsOpen("/live/cam-2?quality=substream");
  const env2 = JSON.parse((await nextMessage(ws2)).toString());
  same([env2.ok, env2.code], [false, "unresolved_camera"], "unresolved_camera wins before substream_unavailable");
  await nextClose(ws2);
  const ws3 = await wsOpen("/live/cam-2");
  const env3 = JSON.parse((await nextMessage(ws3)).toString());
  same([env3.ok, env3.code], [false, "unresolved_camera"], "no url, no host");
  await nextClose(ws3);
});

await check("closeAll kills every child and empties the registry", async () => {
  const w1 = await wsOpen("/live/cam-1");
  const w2 = await wsOpen("/live/cam-1");
  const kids = spawnCalls.slice(-2);
  closeAll();
  same(liveRegistry().size, 0, "registry empty");
  await new Promise((r) => setTimeout(r, 100));
  same(kids.every((k) => k.killed), true, "children killed");
  for (const w of [w1, w2]) await nextClose(w);
});

server.close();

report("live");