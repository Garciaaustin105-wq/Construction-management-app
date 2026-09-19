/**
 * agent/listeners.mjs: one http server, one net.Server listener per planned address,
 * re-planned as cards come and go.
 */

import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import { planListeners, defaultRouteInterfacesFrom } from '../dist/listenPlan.js';

/**
 * Create a listener manager for the given http server.
 * Returns { start, rescan, addresses, plan, stop }.
 */
export function createListeners({
  server,
  port,
  spec = null,
  cameraInterfaces = [],
  interfacesFn = os.networkInterfaces,
  routeFn = readDefaultRoutes,
  log = () => {},
  rescanMs = 10_000,
}) {
  const listeners = new Map(); // address -> net.Server
  let plan = null;
  let rescanTimer = null;

  /**
   * Get the current plan based on network interfaces and config.
   */
  function getPlan() {
    const interfaces = interfacesFn();
    const defaultRouteInterfaces = routeFn();

    // Parse spec from string if it's a string
    let parsedSpec = spec;
    if (typeof spec === 'string') {
      parsedSpec = spec.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }

    return planListeners({
      spec: parsedSpec,
      interfaces,
      defaultRouteInterfaces,
      cameraInterfaces,
    });
  }

  /**
   * Log changes in the plan (refused and waiting entries).
   */
  function logPlanChanges(oldPlan, newPlan) {
    if (!oldPlan) {
      // First plan: log all refused and waiting entries
      for (const entry of newPlan.refused) {
        log('warn', 'listen refused', { entry: entry.entry, reason: entry.reason });
      }
      for (const entry of newPlan.waiting) {
        log('info', 'listen waiting', { entry: entry.entry, reason: entry.reason });
      }
      return;
    }

    // Check if refused/waiting changed
    const oldRefusedStr = JSON.stringify(oldPlan.refused.map(r => r.entry).sort());
    const newRefusedStr = JSON.stringify(newPlan.refused.map(r => r.entry).sort());
    const oldWaitingStr = JSON.stringify(oldPlan.waiting.map(w => w.entry).sort());
    const newWaitingStr = JSON.stringify(newPlan.waiting.map(w => w.entry).sort());

    if (oldRefusedStr !== newRefusedStr || oldWaitingStr !== newWaitingStr) {
      for (const entry of newPlan.refused) {
        if (!oldPlan.refused.some(r => r.entry === entry.entry)) {
          log('warn', 'listen refused', { entry: entry.entry, reason: entry.reason });
        }
      }
      for (const entry of newPlan.waiting) {
        if (!oldPlan.waiting.some(w => w.entry === entry.entry)) {
          log('info', 'listen waiting', { entry: entry.entry, reason: entry.reason });
        }
      }
    }
  }

  /**
   * Start the listeners for all planned addresses.
   */
  async function start() {
    plan = getPlan();
    logPlanChanges(null, plan);

    const opened = [];
    const failed = [];

    // Try to open each planned address
    for (const listenAddr of plan.listen) {
      try {
        const netServer = net.createServer((socket) => {
          server.emit('connection', socket);
        });

        await new Promise((resolve, reject) => {
          netServer.listen(port, listenAddr.address, (err) => {
            if (err) reject(err);
            else resolve();
          });
          netServer.on('error', reject);
        });

        listeners.set(listenAddr.address, netServer);
        opened.push(listenAddr.address);
      } catch (err) {
        if (listenAddr.address === '127.0.0.1') {
          // Loopback must succeed
          // Close any already-opened listeners
          for (const addr of opened) {
            const ls = listeners.get(addr);
            if (ls) {
              await new Promise((r) => ls.close(r));
              listeners.delete(addr);
            }
          }
          const error = new Error(`cannot bind loopback 127.0.0.1:${port}: ${err.message}`);
          throw error;
        }
        // Other addresses that fail to bind are logged and retried on the next rescan
        log('error', 'listen failed', { address: listenAddr.address, port, err: err.code || err.message });
        failed.push(listenAddr.address);
      }
    }

    // Start the rescan timer. A failure is logged, never an unhandled
    // rejection that takes the web server down.
    if (rescanTimer) clearInterval(rescanTimer);
    rescanTimer = setInterval(() => {
      rescan().catch((err) => log('error', 'listen rescan failed', { err: err.message }));
    }, rescanMs);
    rescanTimer.unref();
  }

  /**
   * Rescan and update listeners. One at a time: a timer tick landing while a
   * slow rescan is still closing listeners would try to open the same
   * address twice. A caller during a rescan gets that rescan's result.
   */
  let scanning = null;
  function rescan() {
    if (!scanning) scanning = doRescan().finally(() => { scanning = null; });
    return scanning;
  }

  async function doRescan() {
    const oldPlan = plan;
    plan = getPlan();
    logPlanChanges(oldPlan, plan);

    const opened = [];
    const closed = [];

    // Addresses to close: those no longer in the plan
    const plannedAddrs = new Set(plan.listen.map(l => l.address));
    for (const [addr, listener] of listeners) {
      if (!plannedAddrs.has(addr)) {
        await new Promise((r) => listener.close(r));
        listeners.delete(addr);
        closed.push(addr);
      }
    }

    // Addresses to open: those in the plan but not yet listening
    const listeningAddrs = new Set(listeners.keys());
    for (const listenAddr of plan.listen) {
      if (!listeningAddrs.has(listenAddr.address)) {
        try {
          const netServer = net.createServer((socket) => {
            server.emit('connection', socket);
          });

          await new Promise((resolve, reject) => {
            netServer.listen(port, listenAddr.address, (err) => {
              if (err) reject(err);
              else resolve();
            });
            netServer.on('error', reject);
          });

          listeners.set(listenAddr.address, netServer);
          opened.push(listenAddr.address);
        } catch (err) {
          // Log and retry on next rescan
          log('error', 'listen failed', { address: listenAddr.address, port, err: err.code || err.message });
        }
      }
    }

    return { opened, closed };
  }

  /**
   * Get currently listening addresses (loopback first).
   */
  function addresses() {
    if (!plan) return [];
    const result = [];
    for (const addr of plan.listen) {
      if (listeners.has(addr.address)) {
        result.push(addr.address);
      }
    }
    return result;
  }

  /**
   * Get the current plan.
   */
  function getPlanCopy() {
    return plan;
  }

  /**
   * Stop all listeners.
   */
  async function stop() {
    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }
    for (const [, listener] of listeners) {
      await new Promise((r) => listener.close(r));
    }
    listeners.clear();
  }

  return {
    start,
    rescan,
    addresses,
    plan: getPlanCopy,
    stop,
  };
}

/**
 * Read /proc/net/route and return default route interfaces.
 */
function readDefaultRoutes() {
  try {
    const data = fs.readFileSync('/proc/net/route', 'utf8');
    return defaultRouteInterfacesFrom(data);
  } catch {
    return [];
  }
}
