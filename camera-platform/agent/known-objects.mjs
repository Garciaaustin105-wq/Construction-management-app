/**
 * The known-objects store: `<stateDir>/known-objects.json`, the file
 * contracts/knownObjects.ts describes and checks - `{ "version": 1,
 * "objects": [...] }`. This module is the only thing that reads or writes it;
 * the detector service, the API server and camctl all go through it.
 *
 * Three rules shape it:
 *
 * 1. A file that cannot be trusted is never overwritten. Unreadable, not JSON,
 *    or refused by checkKnownObjects: load() says so (`problem`) and returns
 *    no objects, and every write is refused until a human fixes or removes the
 *    file. That file may be the only record of what hid which events; writing
 *    "no objects" over it would destroy that record while looking like a
 *    fresh start (build rule 7's spirit: never destroy what you cannot read).
 *    And no objects means nothing is hidden, which is the safe side.
 *
 * 2. Several processes write it: the detector (learning, lapsing, counting
 *    matches), the API server (the owner's answer) and camctl (a reset by
 *    hand). So a write is read-modify-write in update(), and the file is read
 *    AGAIN just before the new one is renamed into place: if another process
 *    changed it in between, the change is started over on top of theirs rather
 *    than written over it. Without that, the detector's once-a-minute match
 *    count would quietly undo an owner's answer, or bring back an object a
 *    person had just reset.
 *
 * 3. Atomic: the new file is written in full beside the old one, flushed to
 *    disk, and renamed over it. A crash mid-write leaves the old file whole,
 *    never a half file - and a half file would be refused whole by rule 1,
 *    turning every known object off until someone came to look.
 *
 * cameraFingerprint lives here too: it is what the stored objects carry, so a
 * camera whose connection settings change can be told from one that did not.
 */

import { readFile, rename, unlink, open } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { checkKnownObjects, KNOWN_OBJECTS_VERSION } from "../dist/knownObjects.js";
import { parseRtspUrl } from "../dist/cameraSource.js";

export const KNOWN_OBJECTS_FILE = "known-objects.json";

/**
 * How many times update() starts over when another process changed the file
 * between its read and its rename. Writers here are a handful of processes
 * writing a small file a few times a minute at most, so a second attempt
 * almost always lands; three that all collide means something is writing it
 * in a loop, and that is reported rather than retried forever.
 */
const UPDATE_ATTEMPTS = 3;

/** At most this many of the checker's errors go into a problem message. */
const PROBLEM_ERRORS_SHOWN = 3;
/** And each is cut to this length, so one huge bad value cannot flood a log. */
const PROBLEM_ERROR_CHARS = 200;

/**
 * The default write: the whole text, flushed to the disk before the rename
 * that makes it the file. Without the flush, a power cut shortly after the
 * rename can leave a zero-length file on some filesystems (XFS, which the
 * appliance's drives use, is one) - and rule 1 would then turn every known
 * object off until a human came to look.
 */
async function writeFileSynced(file, text) {
  const fh = await open(file, "w", 0o644);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * A problem message fit for a log line and detect-health.json. The checker
 * quotes bad values back, and a hand-edited file can hold anything - so any
 * address (rtsp://, http://...) is removed whole, user name and all, rather
 * than trusting it to hold no login. Long lists are cut to the first few.
 */
function problemText(prefix, errors = []) {
  const shown = errors.slice(0, PROBLEM_ERRORS_SHOWN).map((e) => {
    const text = String(e).replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[an address, removed]");
    return text.length > PROBLEM_ERROR_CHARS ? `${text.slice(0, PROBLEM_ERROR_CHARS)}...` : text;
  });
  const more = errors.length > shown.length ? `; and ${errors.length - shown.length} more` : "";
  return shown.length === 0 ? prefix : `${prefix}: ${shown.join("; ")}${more}`;
}

/**
 * Parameters in a camera path that carry a login rather than choose a stream.
 * Some vendors take the login in the path or query (`/user=admin&password=x&
 * channel=1`); the value is dropped so it never reaches the hash - a hash is
 * not a hiding place for a password - and so changing a password, which is not
 * re-aiming a camera, does not lapse its known objects.
 */
const LOGIN_PARAM = /(^|[/?&;])(username|user|usr|login|password|passwd|pwd|pass|auth|token)=[^&;?#]*/gi;

/**
 * Where a typed camera address points - host, port and path - and never who
 * it logs in as. null when there is no address; a marker when it cannot be
 * parsed (such an address cannot be connected to, so there is nothing to
 * detect on and nothing to fingerprint; its text is never used, because an
 * address that fails to parse is most often one whose password broke it).
 */
function addressOf(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return { unreadable: true };
  const parsed = parseRtspUrl(raw);
  if (parsed.kind !== "ok") return { unreadable: true };
  return {
    // Host names are not case-sensitive; paths are.
    host: parsed.host.toLowerCase(),
    port: parsed.port,
    path: parsed.path.replace(LOGIN_PARAM, "$1$2="),
  };
}

/**
 * A short fingerprint of what a camera entry connects to: its host, vendor,
 * channel and stream, and the host, port and path of any typed address (the
 * recording address and the substream address the detector watches). Known
 * objects are learned under it, and lapse when it changes (belt 4): the same
 * box on a different view is a different spot.
 *
 * NEVER the login. Neither the entry's user name and password, nor the site
 * login, nor a password carried in an address or its query is part of it - a
 * new password is not a re-aimed camera. The address itself is never stored
 * or logged either: only this hash is, and 16 hex characters of SHA-256 over
 * values that are not secret give nothing back.
 *
 * Blank channel, stream and vendor are read the way the recorder and detector
 * read them (1, "main", "generic" - resolveCameraUrl), so an entry that gains
 * the value it was already using is not a change. The display name and
 * bitrate are left out: renaming a camera does not move it.
 */
export function cameraFingerprint(configCam) {
  if (typeof configCam !== "object" || configCam === null || Array.isArray(configCam)) {
    throw new TypeError("cameraFingerprint needs one camera entry from the config");
  }
  const parts = {
    host: typeof configCam.host === "string" && configCam.host !== "" ? configCam.host.toLowerCase() : null,
    vendor: configCam.vendor ?? "generic",
    channel: configCam.channel ?? 1,
    stream: configCam.stream ?? "main",
    url: addressOf(configCam.url),
    substreamUrl: addressOf(configCam.substreamUrl),
  };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * The store. `readFileFn`, `writeFileFn`, `renameFn` and `unlinkFn` are the
 * file operations, replaceable so a harness can make each one fail.
 *
 *   load()          -> { objects, problem }
 *   update(mutate)  -> { ok: true, objects, changed } | { ok: false, code, problem, objects }
 *   save(objects)   -> the same as update
 *
 * Neither ever throws for a file or disk problem; each answers with it.
 */
export function createKnownObjectsStore({
  stateDir,
  readFileFn = readFile,
  writeFileFn = writeFileSynced,
  renameFn = rename,
  unlinkFn = unlink,
} = {}) {
  if (typeof stateDir !== "string" || stateDir === "") {
    throw new TypeError("createKnownObjectsStore needs the state directory");
  }
  const file = path.join(stateDir, KNOWN_OBJECTS_FILE);

  /** The file's text, or absent, or the error code that stopped the read. */
  async function readText() {
    try {
      const text = await readFileFn(file, "utf8");
      if (typeof text !== "string") return { kind: "error", code: "not text" };
      return { kind: "text", text };
    } catch (err) {
      if (err?.code === "ENOENT") return { kind: "absent" };
      return { kind: "error", code: err?.code ?? "unknown error" };
    }
  }

  /** The file read and checked: { read, objects, problem }. */
  async function readState() {
    const read = await readText();
    if (read.kind === "absent") return { read, objects: [], problem: null };
    if (read.kind === "error") {
      return { read, objects: [], problem: `${KNOWN_OBJECTS_FILE} could not be read (${read.code})` };
    }
    let raw;
    try {
      raw = JSON.parse(read.text);
    } catch {
      // Never the parser's message: it quotes the text around the fault.
      return { read, objects: [], problem: `${KNOWN_OBJECTS_FILE} is not valid JSON` };
    }
    const checked = checkKnownObjects(raw);
    if (!checked.ok) {
      return { read, objects: [], problem: problemText(`${KNOWN_OBJECTS_FILE} failed its check`, checked.errors) };
    }
    return { read, objects: checked.objects, problem: null };
  }

  /**
   * Every object in the file, and `problem`: null when the file is fine or
   * simply not there yet (no file is no objects, not an error); otherwise why
   * it cannot be trusted, with objects [] - refused whole, never half-read.
   */
  async function load() {
    const state = await readState();
    return { objects: state.objects, problem: state.problem };
  }

  async function discard(tmp) {
    try {
      await unlinkFn(tmp);
    } catch {
      // A leftover .tmp file is untidy, not harmful: it is never read.
    }
  }

  /**
   * Read the file, hand its objects (fresh copies) to `mutate`, and write back
   * what it returns - the whole list of objects, or null to write nothing.
   * `mutate` may be async. If it throws, nothing is written and the throw
   * comes back to the caller: that is the caller's own refusal or bug.
   *
   * Answers:
   * - { ok: true, objects, changed }: `objects` is what the file now holds;
   *   changed is false when there was nothing to write (mutate gave null, or
   *   the same objects the file already had).
   * - { ok: false, code: "unreadable", problem, objects: [] }: the file cannot
   *   be trusted and was not touched.
   * - { ok: false, code: "invalid", problem, objects }: what mutate returned
   *   fails checkKnownObjects, so it was not written - a file this store
   *   writes must be one it could read back. `objects` is the file as it is.
   * - { ok: false, code: "busy", problem, objects }: another process kept
   *   changing the file; nothing was written.
   * - { ok: false, code: "write_failed", problem, objects }: the disk refused;
   *   the old file is still whole.
   */
  async function update(mutate) {
    let before = null;
    for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt += 1) {
      before = await readState();
      if (before.problem !== null) {
        return { ok: false, code: "unreadable", problem: before.problem, objects: [] };
      }
      const next = await mutate(before.objects);
      if (next === null || next === undefined) {
        return { ok: true, objects: before.objects, changed: false };
      }
      const checked = checkKnownObjects({ version: KNOWN_OBJECTS_VERSION, objects: next });
      if (!checked.ok) {
        return {
          ok: false,
          code: "invalid",
          problem: problemText("refused to write known objects that would fail their own check", checked.errors),
          objects: before.objects,
        };
      }
      const text = `${JSON.stringify({ version: KNOWN_OBJECTS_VERSION, objects: checked.objects }, null, 2)}\n`;
      // Nothing to write: the same text, or no file and no objects. Leaving an
      // absent file absent keeps a box with no known objects exactly as it was.
      if ((before.read.kind === "text" && before.read.text === text) ||
          (before.read.kind === "absent" && checked.objects.length === 0)) {
        return { ok: true, objects: checked.objects, changed: false };
      }

      // Unique per writer, so two processes writing at once never share one.
      const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFileFn(tmp, text);
      } catch (err) {
        await discard(tmp);
        return { ok: false, code: "write_failed", problem: `${KNOWN_OBJECTS_FILE} could not be written (${err?.code ?? "unknown error"})`, objects: before.objects };
      }
      // Rule 2: has anyone else written it since we read it? Then start over
      // on top of what they wrote, never over it.
      const now = await readText();
      const unchanged = (now.kind === "absent" && before.read.kind === "absent") ||
        (now.kind === "text" && before.read.kind === "text" && now.text === before.read.text);
      if (!unchanged) {
        await discard(tmp);
        continue;
      }
      try {
        await renameFn(tmp, file);
      } catch (err) {
        await discard(tmp);
        return { ok: false, code: "write_failed", problem: `${KNOWN_OBJECTS_FILE} could not be replaced (${err?.code ?? "unknown error"})`, objects: before.objects };
      }
      return { ok: true, objects: checked.objects, changed: true };
    }
    return {
      ok: false,
      code: "busy",
      problem: `${KNOWN_OBJECTS_FILE} kept changing while it was being written (${UPDATE_ATTEMPTS} tries); nothing was written`,
      objects: before?.objects ?? [],
    };
  }

  /**
   * Replace the file's objects with these. Still refuses to overwrite a file
   * that cannot be trusted, and still checks what it writes. Prefer update()
   * for any change to what was loaded: a load() then save() can overwrite a
   * change another process made in between.
   */
  async function save(objects) {
    if (!Array.isArray(objects)) {
      // update() reads null as "write nothing"; here it can only be a mistake.
      return { ok: false, code: "invalid", problem: "save needs a list of known objects", objects: (await load()).objects };
    }
    return update(() => objects);
  }

  return { file, load, update, save };
}
