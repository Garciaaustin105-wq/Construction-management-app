// agent/live.mjs
//
// The live transport slice. Hand-rolled WebSocket (the repo has zero
// dependencies by rule) attached to the same http.Server api-server already
// runs. ffmpeg is the muxer and -c copy only: the appliance's CPU is not a
// transcode farm. A camera that cannot be copied is refused, not transcoded.
//
// The refusal path always SENDS the reason before closing. A bare socket
// close is how bugs hide — the client must see why it was refused.

import { createHash, randomUUID } from "node:crypto";
import { negotiateLive, liveFfmpegArgs } from "../dist/liveNegotiation.js";
import { resolveCameraUrl } from "./recorder-service.mjs";
import { buildRtspUrl } from "../dist/rtsp.js";

/** Registry entry shape:
 *  { cameraId, quality, streamId, child, startedAt, lastBytesAt, stderrLines,
 *    socket, bytesSent, lastPongAt, pingSentAt }
 *  startedAt/lastBytesAt/lastPongAt/pingSentAt are ms numbers (Date.now() or
 *  deps.now().getTime()) so the pure helpers below need no timer to check.
 */
const registry = new Map();

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
  for (const [streamId, entry] of reg) {
    const lastAt = entry.lastBytesAt ?? entry.startedAt;
    if (typeof lastAt === "number" && nowMs - lastAt > stallMs) dead.push(streamId);
  }
  return dead;
}

const textFrame = (obj) => encodeServerFrame(1, Buffer.from(JSON.stringify(obj)));
const closeFrame = () => encodeServerFrame(8, Buffer.alloc(0));

export function attachLive(server, deps) {
  const { config, spawnFn, authorize, now = () => new Date(), maxPerCamera = 2, maxTotal = 16 } = deps;
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

    const liveResult = negotiateLive({
      cameraId,
      cameraExists,
      quality,
      resolution,
      substreamUrl,
      vendorDerivesSubstream,
      activeForCamera: [...registry.values()].filter((e) => e.cameraId === cameraId).length,
      activeTotal: registry.size,
      maxPerCamera,
      maxTotal,
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

    // Register BEFORE spawning so the slot is counted the moment it is held.
    const entry = {
      cameraId,
      quality,
      streamId,
      child: null,
      startedAt: now().getTime(),
      lastBytesAt: null,
      stderrLines: [],
      socket,
      bytesSent: false,
      lastPongAt: null,
      pingSentAt: null,
    };
    registry.set(streamId, entry);

    const child = spawnFn("ffmpeg", liveFfmpegArgs(chosenUrl), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    entry.child = child;

    const release = () => {
      registry.delete(streamId);
    };
    const teardown = (envelope) => {
      // Every teardown is logged with its envelope: without this the log
      // cannot answer "why did that stream end?" after the fact. A client
      // close frame and the socket's 'close' both land here: log the first.
      if (registry.has(streamId)) log("info", "live stream ended", {
        cameraId, quality, streamId,
        reason: envelope ? envelope.code : "client_disconnected",
        bytesSent: entry.bytesSent,
        stderrTail: envelope?.message ?? null,
      });
      if (child && !child.killed) child.kill("SIGTERM");
      if (!socket.destroyed) {
        if (envelope) {
          socket.write(textFrame(envelope));
          socket.write(closeFrame());
        }
        socket.end();
        socket.once("finish", () => socket.destroy()); // flush first, then drop
      }
      release();
    };

    child.stdout?.on("data", (chunk) => {
      entry.bytesSent = true;
      entry.lastBytesAt = now().getTime();
      if (!socket.destroyed) socket.write(encodeServerFrame(2, chunk));
    });

    // Keep the LAST 10 lines for failure messages; never the URL — messages
    // are built from these lines only, so the url cannot ride along.
    child.stderr?.on("data", (chunk) => {
      const lines = chunk.toString().split("\n").map((l) => l.trim()).filter(Boolean);
      entry.stderrLines.push(...lines);
      if (entry.stderrLines.length > 10) entry.stderrLines.splice(0, entry.stderrLines.length - 10);
    });

    child.on("exit", () => {
      if (socket.destroyed) {
        release();
        return;
      }
      if (entry.bytesSent) {
        teardown({
          ok: false,
          code: "live_ended",
          message: entry.stderrLines[entry.stderrLines.length - 1] ?? "source closed",
        });
      } else {
        teardown({
          ok: false,
          code: "live_source_failed",
          message: entry.stderrLines.slice(-3).join("; ") || "source failed",
        });
      }
    });

    child.on("error", () => {
      // Spawn failure (ENOENT etc.) — no bytes were sent by definition.
      teardown({ ok: false, code: "live_source_failed", message: "could not start the source" });
    });

    let frameBuf = Buffer.alloc(0);
    socket.on("data", (data) => {
      frameBuf = Buffer.concat([frameBuf, data]);
      while (frameBuf.length >= 2) {
        const frame = parseClientFrame(frameBuf);
        if (frame === null) break; // partial frame: wait for the rest
        frameBuf = frameBuf.subarray(frame.frameLength);
        if (frame.opcode === 10) {
          entry.lastPongAt = now().getTime();
        } else if (frame.opcode === 8) {
          socket.write(closeFrame());
          teardown(null);
          return;
        } else if (frame.opcode === 9) {
          socket.write(encodeServerFrame(10, Buffer.alloc(0)));
        }
        // other opcodes ignored — the client sends nothing else by contract
      }
    });
    socket.on("error", () => teardown(null));
    socket.on("close", () => teardown(null));
  });

  // One watchdog. The 15s stall is the load-bearing path; ping maintenance
  // re-arms after every pong so a client that dies later is still caught.
  attachLive.watchdog ??= setInterval(() => {
    const nowMs = Date.now();
    for (const streamId of deadStreams(registry, nowMs, 15000)) {
      const entry = registry.get(streamId);
      if (!entry) continue;
      teardownOf(entry, { ok: false, code: "live_stalled", message: "no bytes from the source for 15s" });
    }
    for (const entry of registry.values()) {
      const lastWord = Math.max(entry.lastPongAt ?? 0, entry.pingSentAt ?? 0);
      if (nowMs - Math.max(entry.startedAt, lastWord) > 20000 && !entry.child?.killed) {
        try {
          entry.socket.write(encodeServerFrame(9, Buffer.alloc(0)));
        } catch {} // a dead socket reports itself via its own close
        entry.pingSentAt = nowMs;
      }
      if (entry.pingSentAt !== null && nowMs - entry.pingSentAt > 30000 && (entry.lastPongAt ?? 0) < entry.pingSentAt) {
        teardownOf(entry, { ok: false, code: "live_client_dead", message: "no pong received" });
      }
    }
  }, 5000);
  attachLive.watchdog.unref?.();

  function teardownOf(entry, envelope) {
    // Watchdog-driven teardowns log too — the stall and no-pong paths are the
    // ones most likely to be a bug and the least visible without a line here.
    log("info", "live stream ended", {
      cameraId: entry.cameraId, quality: entry.quality, streamId: entry.streamId,
      reason: envelope ? envelope.code : "client_disconnected",
      bytesSent: entry.bytesSent,
      stderrTail: envelope?.message ?? null,
      watched: true,
    });
    if (entry.child && !entry.child.killed) entry.child.kill("SIGTERM");
    if (!entry.socket.destroyed) {
      if (envelope) {
        entry.socket.write(textFrame(envelope));
        entry.socket.write(closeFrame());
      }
      entry.socket.end();
      entry.socket.once("finish", () => entry.socket.destroy());
    }
    registry.delete(entry.streamId);
  }
}

/** Read-only view for the harness and the health strip. */
export function liveRegistry() {
  return registry;
}

/** Server shutdown and the harness both end here. */
export function closeAll() {
  for (const entry of registry.values()) {
    if (entry.child && !entry.child.killed) entry.child.kill("SIGTERM");
    if (!entry.socket.destroyed) entry.socket.destroy();
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