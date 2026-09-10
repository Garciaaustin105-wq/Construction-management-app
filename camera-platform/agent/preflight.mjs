/** Verify the box can actually do the job, before anyone wastes an afternoon
 *  wondering why a camera "does not work". */
import { statfs } from "node:fs/promises";
import { access, constants } from "node:fs/promises";
import { toolVersion } from "./media.mjs";
import { DEFAULT_PATHS, indexPathFor } from "./config.mjs";

export async function preflight() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const ffmpeg = await toolVersion("ffmpeg");
  add("ffmpeg present", ffmpeg !== null, ffmpeg ?? "not found on PATH — install ffmpeg");

  const ffprobe = await toolVersion("ffprobe");
  add("ffprobe present", ffprobe !== null, ffprobe ?? "not found on PATH — install ffmpeg");

  const major = Number(process.versions.node.split(".")[0]);
  add("node >= 18", major >= 18, `node ${process.versions.node}`);

  add(
    "raw multicast permitted",
    process.getuid === undefined || process.getuid() === 0 || process.env.CAMPLAT_ALLOW_NONROOT === "1",
    process.getuid !== undefined && process.getuid() !== 0
      ? "SADP binds UDP 37020; if discovery finds nothing, try sudo or set CAMPLAT_ALLOW_NONROOT=1 to silence this"
      : "ok",
  );

  // Optimisations specific to the reference build. Each is something that
  // silently costs performance rather than failing outright, which is why they
  // are checked rather than assumed.
  let hasRenderNode = true;
  try {
    await access("/dev/dri/renderD128", constants.R_OK);
  } catch {
    hasRenderNode = false;
  }
  add(
    "iGPU render node",
    hasRenderNode,
    hasRenderNode
      ? "/dev/dri/renderD128 — substream decode runs on QuickSync"
      : "missing: detection would decode in software and eat a core of four. " +
        "Check i915 is loaded and the user is in the `render` group",
  );

  const stateDir = process.env.CAMPLAT_STATE_DIR ?? DEFAULT_PATHS.stateDir;
  const storeRoots = (process.env.CAMPLAT_STORE_ROOTS ?? DEFAULT_PATHS.storeRoots.join(",")).split(",");
  const indexPath = indexPathFor(stateDir);
  const indexOnStore = storeRoots.some((root) => indexPath.startsWith(root.trim()));
  add(
    "index off the recording drives",
    !indexOnStore,
    indexOnStore
      ? `${indexPath} sits inside a recording drive — the index and the video stream will seek against each other`
      : `${indexPath}`,
  );

  for (const root of storeRoots) {
    const stats = await statfs(root.trim()).catch(() => null);
    if (stats === null) {
      add(`store ${root.trim()}`, false, "not mounted");
      continue;
    }
    const freeGb = (stats.bavail * stats.bsize) / 1e9;
    const totalGb = (stats.blocks * stats.bsize) / 1e9;
    const usedPct = ((totalGb - freeGb) / totalGb) * 100;
    add(
      `store ${root.trim()}`,
      usedPct < 92,
      `${totalGb.toFixed(0)} GB total, ${usedPct.toFixed(0)}% used` +
        (usedPct >= 92 ? " — above the ring buffer's 85% target, eviction is behind" : ""),
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}
