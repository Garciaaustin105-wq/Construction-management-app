/**
 * agent/listeners.mjs: one http server, one listener per planned address,
 * re-planned as cards come and go.
 *
 * THE FEARED FAILURES: the server never learns that Tailscale or DHCP came up
 * after it started (the wall works, the manager cannot connect); a card going
 * away leaves a listener bound to nothing; one address that cannot bind takes
 * the whole server down; loopback failing silently, so the box's own TV shows
 * nothing and nobody is told; WebSocket upgrades (live video) lost on the
 * extra listeners.
 *
 * Real sockets on 127.0.0.x: every 127/8 address is loopback, so each can
 * stand in for a different card without touching a real network.
 */
import http from "node:http";
import net from "node:net";
import { createListeners } from "../agent/listeners.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("listeners");

const lo = { lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] };
const card = (address) => [{ address, family: "IPv4", internal: false }];

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function get(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/who", timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ ok: true, status: res.statusCode, body }));
    });
    req.on("error", (err) => resolve({ ok: false, code: err.code }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, code: "TIMEOUT" }); });
  });
}

function makeServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`local=${req.socket.localAddress}`);
  });
  server.on("upgrade", (req, socket) => {
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  return server;
}

await check("loopback is served by the one http server", async () => {
  const port = await freePort();
  const server = makeServer();
  const L = createListeners({ server, port, spec: null, interfacesFn: () => lo, routeFn: () => [], rescanMs: 60_000 });
  try {
    await L.start();
    const r = await get("127.0.0.1", port);
    eq(r.ok && r.status, 200, "answered");
    eq(r.body, "local=127.0.0.1", "by the shared handler");
    eq(L.addresses(), ["127.0.0.1"], "addresses()");
  } finally {
    await L.stop();
  }
});

await check("THE FEARED ONE: a card that comes up after start is picked up, and one that goes away is closed", async () => {
  const port = await freePort();
  const server = makeServer();
  let ifaces = { ...lo };
  const L = createListeners({ server, port, spec: ["loopback", "tailscale"], interfacesFn: () => ifaces, routeFn: () => [], rescanMs: 60_000 });
  try {
    await L.start();
    eq((await get("127.0.0.2", port)).ok, false, "nothing on 127.0.0.2 yet");
    ifaces = { ...lo, tailscale0: card("127.0.0.2") };
    const up = await L.rescan();
    eq(up.opened, ["127.0.0.2"], "opened on rescan");
    const r = await get("127.0.0.2", port);
    eq(r.ok && r.body, "local=127.0.0.2", "Tailscale address now served");
    ifaces = { ...lo };
    const down = await L.rescan();
    eq(down.closed, ["127.0.0.2"], "closed when the card went away");
    eq((await get("127.0.0.2", port)).ok, false, "no longer answering");
    eq((await get("127.0.0.1", port)).ok, true, "loopback untouched");
  } finally {
    await L.stop();
  }
});

await check("THE FEARED ONE: an address that cannot bind is logged and retried; the rest keep working", async () => {
  const port = await freePort();
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(port, "127.0.0.3", r));
  const server = makeServer();
  const logs = [];
  const L = createListeners({
    server, port, spec: ["loopback", "if:eth1"],
    interfacesFn: () => ({ ...lo, eth1: card("127.0.0.3") }),
    routeFn: () => [], rescanMs: 60_000,
    log: (level, msg, extra) => logs.push({ level, msg, ...extra }),
  });
  try {
    await L.start();
    eq((await get("127.0.0.1", port)).ok, true, "loopback still up");
    eq(L.addresses(), ["127.0.0.1"], "the busy address is not counted as listening");
    if (!logs.some((l) => l.level === "error" && l.address === "127.0.0.3")) throw new Error(`the failed bind was not logged: ${JSON.stringify(logs)}`);
    await new Promise((r) => squatter.close(r));
    const retry = await L.rescan();
    eq(retry.opened, ["127.0.0.3"], "retried and opened once free");
    eq((await get("127.0.0.3", port)).ok, true, "now answering");
  } finally {
    await L.stop();
    if (squatter.listening) await new Promise((r) => squatter.close(r));
  }
});

await check("THE FEARED ONE: loopback that cannot bind fails start loudly", async () => {
  const port = await freePort();
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(port, "127.0.0.1", r));
  const L = createListeners({ server: makeServer(), port, spec: null, interfacesFn: () => lo, routeFn: () => [], rescanMs: 60_000 });
  try {
    let threw = null;
    try { await L.start(); } catch (err) { threw = err; }
    if (!threw) throw new Error("start() resolved with loopback unbindable");
    if (!/127\.0\.0\.1/.test(threw.message)) throw new Error(`the error should name the address: ${threw.message}`);
  } finally {
    await L.stop();
    await new Promise((r) => squatter.close(r));
  }
});

await check("the camera card is never opened, and refused or waiting entries are logged once, not every scan", async () => {
  const port = await freePort();
  const logs = [];
  const L = createListeners({
    server: makeServer(), port, spec: ["loopback", "if:enp2s0", "tailscale"], cameraInterfaces: ["enp2s0"],
    interfacesFn: () => ({ ...lo, enp2s0: card("127.0.0.4") }), routeFn: () => [], rescanMs: 60_000,
    log: (level, msg, extra) => logs.push({ level, msg, ...extra }),
  });
  try {
    await L.start();
    eq((await get("127.0.0.4", port)).ok, false, "camera card not listened on");
    const before = logs.length;
    await L.rescan();
    await L.rescan();
    eq(logs.length, before, "an unchanged plan logs nothing more");
    if (!logs.some((l) => l.entry === "if:enp2s0")) throw new Error(`the refusal was never logged: ${JSON.stringify(logs)}`);
    if (!logs.some((l) => l.entry === "tailscale")) throw new Error(`the waiting entry was never logged: ${JSON.stringify(logs)}`);
  } finally {
    await L.stop();
  }
});

await check("WebSocket upgrades reach the server through every listener", async () => {
  const port = await freePort();
  const L = createListeners({ server: makeServer(), port, spec: ["loopback", "if:eth1"], interfacesFn: () => ({ ...lo, eth1: card("127.0.0.5") }), routeFn: () => [], rescanMs: 60_000 });
  try {
    await L.start();
    const line = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.5", () => {
        s.write("GET /live HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
      });
      let buf = "";
      s.on("data", (d) => { buf += d; });
      s.on("end", () => resolve(buf.split("\r\n")[0]));
      s.on("error", (e) => resolve(`error ${e.code}`));
    });
    eq(line, "HTTP/1.1 101 Switching Protocols", "upgrade handled");
  } finally {
    await L.stop();
  }
});

await check("the timer re-plans by itself, and stop() closes everything and stops the timer", async () => {
  const port = await freePort();
  let ifaces = { ...lo };
  const L = createListeners({ server: makeServer(), port, spec: ["loopback", "tailscale"], interfacesFn: () => ifaces, routeFn: () => [], rescanMs: 50 });
  await L.start();
  ifaces = { ...lo, tailscale0: card("127.0.0.6") };
  await new Promise((r) => setTimeout(r, 300));
  eq((await get("127.0.0.6", port)).ok, true, "picked up without a manual rescan");
  await L.stop();
  eq((await get("127.0.0.1", port)).ok, false, "loopback closed");
  eq((await get("127.0.0.6", port)).ok, false, "tailscale closed");
  eq(L.addresses(), [], "nothing listed");
});

report("listeners");
