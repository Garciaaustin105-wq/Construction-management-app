/** TCP connect sweep. The reliable backstop: a camera is something that answers
 *  on 554 and streams when you ask it to. Works regardless of whether ONVIF is
 *  enabled or SADP answers. */
import net from "node:net";
import { expandCidr } from "../dist/net.js";

/** Resolves true if a TCP connection completes within the timeout. */
export function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Sweep a CIDR for open ports.
 * `concurrency` is bounded because a /24 opening 254 sockets at once on a
 * cheap appliance NIC produces timeouts that look like absent cameras.
 */
export async function sweep(cidr, ports = [554, 80], { concurrency = 32, timeoutMs = 800, onHost } = {}) {
  const hosts = expandCidr(cidr);
  const found = [];
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= hosts.length) return;
      const host = hosts[index];
      const openPorts = [];
      for (const port of ports) {
        if (await probePort(host, port, timeoutMs)) openPorts.push(port);
      }
      if (openPorts.length > 0) {
        const hit = { ip: host, openPorts };
        found.push(hit);
        onHost?.(hit);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  return found;
}
