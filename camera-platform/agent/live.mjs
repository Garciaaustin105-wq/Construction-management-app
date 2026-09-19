// agent/live.mjs
//
// The live transport slice. Hand-rolled WebSocket (the repo has zero
// dependencies by rule) attached to the same http.Server api-server already
// runs. ffmpeg is the muxer and -c copy only: the appliance's CPU is not a
// transcode farm. A camera that cannot be copied is refused, not transcoded.
//
// The refusal path always SENDS the reason before closing. A bare socket
// close is how bugs hide — the client must see why it was refused.
//
// One ffmpeg (one camera session) per (cameraId, quality), fanned out to
// every viewer WebSocket. A source is created on demand and torn down when
// its last viewer leaves.

import { createHash, randomUUID } from "node:crypto";
import { negotiateLive, liveFfmpegArgs } from "../dist/liveNegotiation.js";
import { resolveCameraUrl } from "./recorder-service.mjs";
import { buildRtspUrl, redactRtspUrl } from "../dist/rtsp.js";

/** What a viewer is told. Fixed sentences: ffmpeg's own words carry the
 *  camera's URL, password included (bench 2026-09-19: a reconnecting tile
 *  showed it), so they never leave this box. They go to the log, scrubbed. */
const VIEWER_WORDS = Object.freeze({
  live_source_failed: "the camera did not answer",
  live_ended: "the camera stopped sending video",
});

/** Passwords that could appear in this source's ffmpeg output: the site's
 *  and the one inside the URL, as written and percent-encoded. */
function secretsFor(config, url) {
  const out = new Set();
  const add = (p) => {
    if (typeof p !== "string" || p.length < 3) return;
    out.add(p);
    out.add(encodeURIComponent(p));
  };
  add(config?.credentials?.password);
  try {
    const u = new URL(url);
    add(u.password);
    add(decodeURIComponent(u.password));
  } catch { /* not a URL: nothing inside it to hide */ }
  return [...out];
}

/** One ffmpeg line, safe to log: URLs lose their userinfo, and a password
 *  anywhere in the line, even percent-encoded, becomes ***. */
function scrubLine(line, secrets) {
  let text = redactRtspUrl(line);
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* a lone % is not an escape */ }
  if (secrets.some((s) => decoded.includes(s))) text = redactRtspUrl(decoded);
  for (const s of secrets) text = text.split(s).join("***");
  return text;
}
import { createBoxAccumulator } from "./ui/live-client.mjs";

/** Registry of live viewers, keyed by streamId:
 *  { streamId, cameraId, quality, sourceKey, socket, state, startedAt,
 *    lastPongAt, pingSentAt, bytesSent }
 *  state: "awaiting_init" | "awaiting_keyframe" | "live" | "lagging"
 */
const registry = new Map();

/** Sources keyed by `${cameraId}|${quality}`:
 *  { key, cameraId, quality, child, startedAt, lastBytesAt, stderrLines,
 *    bytesSent, init, accumulator, viewers }
 *  viewers is a Set of viewer objects from registry
 */
const sources = new Map();

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

/** RFC 6455 accept key, exported so the handshake is checkable without a socket. */
export function wsAcceptKey(key) {
  const magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  return createHash("sha1").update(key + magic).digest("base64");
}

/** Parse ONE client frame from the front of `buffer`. Client frames are always
 *  masked (RFC 6455) — a masked frame handled unmasked corrupts silently, so
 *  the unmask lives here and is testable without a socket. Returns null when
 *  the buffer does not yet hold the complete frame: a frame split across TCP
 *  chunks must wait, not be misread with a short payload. */
export function parseClientFrame(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const opcode = b0 & 0x0f;
  const b1 = buffer[1];
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < offset + 2) return null;
    len = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buffer.length < offset + 8) return null;
    len = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  if (buffer.length < offset + len + (masked ? 4 : 0)) return null;
  const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + len)); // copy: the shared buffer keeps flowing
  if (maskKey) {
    for (let i = 0; i < len; i++) payload[i] ^= maskKey[i % 4];
  }
  return { opcode, payload, frameLength: offset + len };
}

/** One server->client frame. Server frames are NEVER masked. Payloads from
 *  ffmpeg chunks routinely exceed 65535 — that is why the 64-bit length
 *  path exists. */
export function encodeServerFrame(opcode, payload) {
  const len = payload.length;
  let headerLen = 2;
  if (len > 125) headerLen += len <= 65535 ? 2 : 8;
  const out = Buffer.alloc(headerLen + len);
  out[0] = 0x80 | (opcode & 0x0f);
  if (len <= 125) {
    out[1] = len;
  } else if (len <= 65535) {
    out[1] = 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  payload.copy(out, headerLen);
  return out;
}

/** Pure watchdog logic — the interval calls this with real time; the harness
 *  calls it with fake time. A stream that never emitted a byte stalls off
 *  startedAt, not lastBytesAt: a source that never produced a byte is exactly
 *  the one worth flagging, and null lastBytesAt must not exempt it. */
export function deadStreams(reg, nowMs, stallMs) {
  const dead = [];
  for (const [key, entry] of reg) {
    const lastAt = entry.lastBytesAt ?? entry.startedAt;
    if (typeof lastAt === "number" && nowMs - lastAt > stallMs) dead.push(key);
  }
  return dead;
}

/** Per-viewer delivery rule — determines whether to send a frame and the new
 *  viewer state. Returns { send: boolean, next: state }.
 *
 *  States: "awaiting_init" | "awaiting_keyframe" | "live" | "lagging"
 *  Kinds: "init" | "fragment" | "other"
 *
 *  Rules:
 *  - init: awaiting_init -> send, awaiting_keyframe; any other -> no send, same
 *  - fragment: awaiting_init -> no send, same; awaiting_keyframe -> send, live;
 *             live -> over highWater: no send, lagging; else send, live;
 *             lagging -> at or under lowWater: send, live; else no send, lagging
 *  - other: live -> if writableLength > highWater no send lagging, else send live;
 *           every other -> no send, same
 */
export function nextDelivery(state, kind, writableLength, { highWater, lowWater }) {
  if (kind === "init") {
    if (state === "awaiting_init") return { send: true, next: "awaiting_keyframe" };
    return { send: false, next: state };
  }
  if (kind === "fragment") {
    if (state === "awaiting_init") return { send: false, next: state };
    if (state === "awaiting_keyframe") return { send: true, next: "live" };
    if (state === "live") {
      if (writableLength > highWater) return { send: false, next: "lagging" };
      return { send: true, next: "live" };
    }
    if (state === "lagging") {
      if (writableLength <= lowWater) return { send: true, next: "live" };
      return { send: false, next: "lagging" };
    }
  }
  if (kind === "other") {
    if (state === "live") {
      if (writableLength > highWater) return { send: false, next: "lagging" };
      return { send: true, next: "live" };
    }
    return { send: false, next: state };
  }
  return { send: false, next: state };
}

const textFrame = (obj) => encodeServerFrame(1, Buffer.from(JSON.stringify(obj)));
const closeFrame = () => encodeServerFrame(8, Buffer.alloc(0));

/** Stop a source and make it unjoinable at once. Its ffmpeg takes a moment to
 *  exit after SIGTERM; a viewer reopening the camera in that moment (a wall
 *  redraw does exactly this) must get a fresh source, not the dying one, and
 *  the old exit must never remove the new source from the map. */
function retireSource(source) {
  if (sources.get(source.key) === source) sources.delete(source.key);
  if (source.child && !source.child.killed) source.child.kill("SIGTERM");
}

export function attachLive(server, deps) {
  const {
    config, spawnFn, authorize, now = () => new Date(),
    maxSourcesPerCamera = 2, maxSources = 32, maxViewers = 128,
    maxPerCamera = maxSourcesPerCamera, // backward compat
    maxTotal = maxSources, // backward compat
    highWater = 6 * 1024 * 1024,
    lowWater = 2 * 1024 * 1024,
  } = deps;
  // Required, not defaulted: a live edge with no gate streams every camera to
  // anyone on the LAN, and a forgotten argument must not be how that happens.
  if (typeof authorize !== "function") throw new TypeError("attachLive needs an authorize(request) function");

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (!url.pathname.startsWith("/live/") || request.method !== "GET") {
      socket.destroy();
      return;
    }
    const cameraId = url.pathname.slice("/live/".length);
    const key = request.headers["sec-websocket-key"];
    if (!cameraId || !key) {
      socket.destroy();
      return;
    }

    // Who is asking is decided BEFORE the 101. Once the upgrade is written the
    // connection is a stream, and a refusal after it is a courtesy the client
    // may ignore; a plain HTTP status before it is the end of the conversation.
    const verdict = authorize(request);
    if (verdict?.kind !== "allow") {
      const status = verdict?.status ?? 401;
      const body = JSON.stringify({ ok: false, code: verdict?.code ?? "unauthenticated", message: verdict?.message ?? "sign in first" });
      socket.end(
        `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Unauthorized"}\r\n` +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          "Connection: close\r\n\r\n" +
          body,
      );
      socket.once("finish", () => socket.destroy());
      return;
    }

    // Complete the upgrade FIRST — a refusal is sent ON the socket, never as a
    // bare close. The client sees why it was refused.
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`,
    );

    const refuse = (code, message) => {
      socket.write(textFrame({ ok: false, code, message }));
      socket.write(closeFrame());
      socket.end();
      socket.once("finish", () => socket.destroy()); // flush first, then drop
    };

    // The CALLER validates the query string, as the contract requires.
    const quality = url.searchParams.get("quality") ?? "mainstream";
    if (quality !== "mainstream" && quality !== "substream") {
      refuse("bad_quality", "quality must be mainstream or substream");
      return;
    }

    const cam = config.cameras.find((c) => c.cameraId === cameraId) ?? null;
    const cameraExists = cam !== null;
    const resolution = cameraExists
      ? resolveCameraUrl(cam, config.credentials)
      : { kind: "unresolved", reason: "" }; // never read: unknown_camera wins first

    const substreamUrl =
      cam !== null && typeof cam.substreamUrl === "string" && cam.substreamUrl !== ""
        ? cam.substreamUrl
        : null;

    // Vendor derivation is the REAL rule from the vendor template contract,
    // tried live — never a guessed table. Hostless cameras cannot derive.
    let vendorDerivesSubstream = false;
    let vendorSubstreamUrl = null;
    if (cameraExists && typeof cam.host === "string" && cam.host !== "") {
      const sub = buildRtspUrl(
        { vendor: cam.vendor ?? "generic", ip: cam.host, channel: cam.channel ?? 1, stream: "sub" },
        config.credentials,
      );
      if (sub.kind === "ok") {
        vendorDerivesSubstream = true;
        vendorSubstreamUrl = sub.url;
      }
    }

    const sourceKey = `${cameraId}|${quality}`;
    const sourceRunning = sources.has(sourceKey);
    const sourcesForCamera = [...sources.keys()].filter((k) => k.startsWith(`${cameraId}|`)).length;

    const liveResult = negotiateLive({
      cameraId,
      cameraExists,
      quality,
      resolution,
      substreamUrl,
      vendorDerivesSubstream,
      sourceRunning,
      sourcesForCamera,
      sourcesTotal: sources.size,
      viewersTotal: registry.size,
      maxSourcesPerCamera,
      maxSources,
      maxViewers,
      streamId: randomUUID(),
    });
    if (liveResult.kind === "refused") {
      refuse(liveResult.reason, liveResult.detail);
      return;
    }

    const { streamId } = liveResult;
    const chosenUrl =
      quality === "mainstream"
        ? resolution.url
        : substreamUrl ?? vendorSubstreamUrl;

    // Create or retrieve the source
    let source = sources.get(sourceKey);

    if (!source) {
      source = {
        key: sourceKey,
        cameraId,
        quality,
        child: null,
        startedAt: now().getTime(),
        lastBytesAt: null,
        stderrLines: [],
        bytesSent: false,
        init: null,
        accumulator: createBoxAccumulator(),
        viewers: new Set(),
        secrets: secretsFor(config, chosenUrl),
      };
      sources.set(sourceKey, source);

      // Spawn ffmpeg only once per source
      const child = spawnFn("ffmpeg", liveFfmpegArgs(chosenUrl), {
        stdio: ["ignore", "pipe", "pipe"],
      });
      source.child = child;

      // Wire up source stdout/stderr/exit/error handlers
      child.stdout?.on("data", (chunk) => {
        source.bytesSent = true;
        source.lastBytesAt = now().getTime();
        // Update bytesSent on all viewers of this source
        for (const v of source.viewers) v.bytesSent = true;

        const emissions = source.accumulator.push(chunk);
        for (const emission of emissions) {
          // The accumulator's first emission is always the init segment
          // (ftyp..moov); it is kept for viewers who join later.
          let kind;
          if (source.init === null) {
            source.init = Buffer.from(emission);
            kind = "init";
          } else {
            // "moof" at bytes 4..7. frag_keyframe: every fragment starts on a
            // keyframe, so a fragment is a place a viewer can start.
            kind = emission.length >= 8 && emission[4] === 0x6d && emission[5] === 0x6f && emission[6] === 0x6f && emission[7] === 0x66
              ? "fragment" : "other";
          }
          // One frame, written to every viewer that should get it.
          const frame = encodeServerFrame(2, Buffer.from(emission.buffer, emission.byteOffset, emission.byteLength));
          for (const viewer of source.viewers) {
            const { send, next } = nextDelivery(viewer.state, kind, viewer.socket.writableLength, { highWater, lowWater });
            if (send) {
              try {
                viewer.socket.write(frame);
              } catch {}
            }
            viewer.state = next;
          }
        }
      });

      child.stderr?.on("data", (chunk) => {
        const lines = chunk.toString().split("\n").map((l) => l.trim()).filter(Boolean).map((l) => scrubLine(l, source.secrets));
        source.stderrLines.push(...lines);
        if (source.stderrLines.length > 10) source.stderrLines.splice(0, source.stderrLines.length - 10);
      });

      child.on("exit", () => {
        const envelope = source.bytesSent
          ? { ok: false, code: "live_ended", message: VIEWER_WORDS.live_ended }
          : { ok: false, code: "live_source_failed", message: VIEWER_WORDS.live_source_failed };
        // What ffmpeg said stays here, scrubbed, for whoever troubleshoots.
        log("warn", "live source failed", { cameraId, quality, bytesSent: source.bytesSent, stderrTail: source.stderrLines.slice(-3).join("; ") || null });
        for (const viewer of source.viewers) {
          if (!viewer.socket.destroyed) {
            try {
              viewer.socket.write(textFrame(envelope));
              viewer.socket.write(closeFrame());
              viewer.socket.end();
              viewer.socket.once("finish", () => viewer.socket.destroy());
            } catch {}
          }
          registry.delete(viewer.streamId);
        }
        source.viewers.clear();
        log("info", "live source stopped", { cameraId, quality, bytesSent: source.bytesSent });
        if (sources.get(sourceKey) === source) sources.delete(sourceKey);
      });

      child.on("error", () => {
        const envelope = { ok: false, code: "live_source_failed", message: "could not start the source" };
        for (const viewer of source.viewers) {
          if (!viewer.socket.destroyed) {
            try {
              viewer.socket.write(textFrame(envelope));
              viewer.socket.write(closeFrame());
              viewer.socket.end();
              viewer.socket.once("finish", () => viewer.socket.destroy());
            } catch {}
          }
          registry.delete(viewer.streamId);
        }
        source.viewers.clear();
        log("info", "live source stopped", { cameraId, quality, bytesSent: false });
        if (sources.get(sourceKey) === source) sources.delete(sourceKey);
      });
    }

    // Create viewer and register it BEFORE delivering init
    const viewer = {
      streamId,
      cameraId,
      quality,
      sourceKey,
      socket,
      state: "awaiting_init",
      startedAt: now().getTime(),
      lastPongAt: null,
      pingSentAt: null,
      bytesSent: source.bytesSent, // Track source's byte status
    };
    registry.set(streamId, viewer);
    source.viewers.add(viewer);

    // If source already has init segment, deliver it and start on keyframe
    if (source.init) {
      try {
        socket.write(encodeServerFrame(2, source.init));
        viewer.state = "awaiting_keyframe";
      } catch {}
    }

    // WebSocket frame parsing and handling
    let frameBuf = Buffer.alloc(0);
    socket.on("data", (data) => {
      frameBuf = Buffer.concat([frameBuf, data]);
      while (frameBuf.length >= 2) {
        const frame = parseClientFrame(frameBuf);
        if (frame === null) break; // partial frame: wait for the rest
        frameBuf = frameBuf.subarray(frame.frameLength);
        if (frame.opcode === 10) {
          // pong
          viewer.lastPongAt = now().getTime();
        } else if (frame.opcode === 8) {
          // close
          removeViewer(viewer, null);
          return;
        } else if (frame.opcode === 9) {
          // ping
          try {
            socket.write(encodeServerFrame(10, Buffer.alloc(0)));
          } catch {}
        }
        // other opcodes ignored — the client sends nothing else by contract
      }
    });
    socket.on("error", () => removeViewer(viewer, null));
    socket.on("close", () => removeViewer(viewer, null));

    function removeViewer(viewer, envelope) {
      if (!registry.has(streamId)) return; // already removed

      log("info", "live stream ended", {
        cameraId, quality, streamId,
        reason: envelope ? envelope.code : "client_disconnected",
        bytesSent: viewer.bytesSent,
        stderrTail: envelope?.message ?? null,
      });

      registry.delete(streamId);
      source.viewers.delete(viewer);

      if (!socket.destroyed) {
        if (envelope) {
          socket.write(textFrame(envelope));
          socket.write(closeFrame());
        }
        socket.end();
        socket.once("finish", () => socket.destroy());
      }

      // The last viewer out retires the source at once.
      if (source.viewers.size === 0) retireSource(source);
    }
  });

  // One watchdog. The 15s stall is the load-bearing path; ping maintenance
  // re-arms after every pong so a client that dies later is still caught.
  attachLive.watchdog ??= setInterval(() => {
    const nowMs = Date.now();

    // Check sources for stalls
    for (const sourceKey of deadStreams(sources, nowMs, 15000)) {
      const source = sources.get(sourceKey);
      if (!source) continue;
      const envelope = { ok: false, code: "live_stalled", message: "no bytes from the source for 15s" };
      for (const viewer of source.viewers) {
        if (!viewer.socket.destroyed) {
          viewer.socket.write(textFrame(envelope));
          viewer.socket.write(closeFrame());
          viewer.socket.end();
          viewer.socket.once("finish", () => viewer.socket.destroy());
        }
        registry.delete(viewer.streamId);
      }
      source.viewers.clear();
      retireSource(source);
    }

    // Check viewers for ping/pong and dead clients
    for (const viewer of registry.values()) {
      const lastWord = Math.max(viewer.lastPongAt ?? 0, viewer.pingSentAt ?? 0);
      if (nowMs - Math.max(viewer.startedAt, lastWord) > 20000) {
        try {
          viewer.socket.write(encodeServerFrame(9, Buffer.alloc(0)));
        } catch {} // a dead socket reports itself via its own close
        viewer.pingSentAt = nowMs;
      }
      if (viewer.pingSentAt !== null && nowMs - viewer.pingSentAt > 30000 && (viewer.lastPongAt ?? 0) < viewer.pingSentAt) {
        // No pong received
        const source = sources.get(viewer.sourceKey);
        if (source) source.viewers.delete(viewer);
        registry.delete(viewer.streamId);
        if (!viewer.socket.destroyed) {
          viewer.socket.write(textFrame({ ok: false, code: "live_client_dead", message: "no pong received" }));
          viewer.socket.write(closeFrame());
          viewer.socket.end();
          viewer.socket.once("finish", () => viewer.socket.destroy());
        }
        if (source && source.viewers.size === 0) retireSource(source);
      }
    }
  }, 5000);
  attachLive.watchdog.unref?.();
}

/** Read-only view of viewers for the harness and the health strip. */
export function liveRegistry() {
  return registry;
}

/** Read-only view of sources for the harness. */
export function liveSources() {
  return sources;
}

/** Server shutdown and the harness both end here. */
export function closeAll() {
  for (const source of sources.values()) {
    if (source.child && !source.child.killed) source.child.kill("SIGTERM");
    for (const viewer of source.viewers) {
      if (!viewer.socket.destroyed) viewer.socket.destroy();
    }
  }
  sources.clear();
  for (const viewer of registry.values()) {
    if (!viewer.socket.destroyed) viewer.socket.destroy();
  }
  registry.clear();
  if (attachLive.watchdog) {
    clearInterval(attachLive.watchdog);
    attachLive.watchdog = undefined;
  }
}

// Not a runnable daemon — api-server attaches this to ITS server. Saying so
// beats failing mysteriously.
if (process.argv[1] && process.argv[1].endsWith("live.mjs")) {
  log("info", "live.mjs is a module; attach it via attachLive(server, deps)");
}
