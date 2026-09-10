/** Verify the box can actually do the job, before anyone wastes an afternoon
 *  wondering why a camera "does not work". */
import { toolVersion } from "./media.mjs";

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

  return { ok: checks.every((c) => c.ok), checks };
}
