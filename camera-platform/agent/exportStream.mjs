// agent/exportStream.mjs
//
// Streams an export plan (contracts/exportPlan.ts) out as a store-only ZIP:
// each file's bytes pass through CRC-32 and SHA-256 on the way out, and
// manifest.json, built from what was SENT, goes last. See EXPORT-SPEC.md §3.
//
// THE FEARED FAILURE: a download that completes as a valid-looking archive
// while carrying less than it claims. So a missing file, or one whose size no
// longer matches the plan, REJECTS before another byte is written. The caller
// then destroys the response, and no end-of-central-directory record ever
// goes out.
//
// None of these functions ends or destroys `out`: the caller ends it on
// success and destroys it on failure.

import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  crc32Update, dosDateTime, checkEntryName,
  localFileHeader, dataDescriptor, centralDirectoryHeader, endOfCentralDirectory,
} from '../dist/zipStore.js';
import { exportManifest, MANIFEST_ENTRY_NAME } from '../dist/exportPlan.js';
import { parseUtc } from '../dist/time.js';

/**
 * Why a stream stopped. `code` is one of:
 *   'file_missing'      the file could not be opened (ENOENT or any open error)
 *   'file_size_changed' the file holds more or fewer bytes than the plan says
 *   'client_gone'       `out` was destroyed, or closed or errored while waiting
 * `message` names the archive entry name, never a filesystem path.
 */
export class ExportStreamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Write `bytes` (a Uint8Array) to the Writable `out`, honouring backpressure.
 *
 * 1. If `out.destroyed` is true, throw ExportStreamError('client_gone', ...)
 *    without writing.
 * 2. `const ok = out.write(bytes)`.
 * 3. If `ok` is false, wait until `out` emits 'drain'. If it emits 'close' or
 *    'error' first, reject with ExportStreamError('client_gone', ...). Remove
 *    all three listeners once settled, whichever fired.
 *
 * Returns a Promise<void>.
 */
function awaitDrain(out) {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ExportStreamError('client_gone', 'client gone'));
    };
    const onError = () => {
      cleanup();
      reject(new ExportStreamError('client_gone', 'client gone'));
    };
    const cleanup = () => {
      out.off('drain', onDrain);
      out.off('close', onClose);
      out.off('error', onError);
    };
    out.once('drain', onDrain);
    out.once('close', onClose);
    out.once('error', onError);
  });
}

export async function writeChunk(out, bytes) {
  if (out.destroyed) {
    throw new ExportStreamError('client_gone', 'client gone');
  }
  const ok = out.write(bytes);
  if (ok) return;
  return awaitDrain(out);
}

/**
 * Stream one planned file's bytes into `out`, measuring as it goes.
 *
 * `file`: an ExportFile of the plan ({ name, bytes, ... }). `absPath`: where it
 * is on disk. `openRead`: a function (absPath) => Readable, normally
 * createReadStream.
 *
 * 1. `const input = openRead(absPath)`. Let crc = 0, count = 0, and
 *    hash = createHash('sha256').
 * 2. `for await (const chunk of input)`, for each chunk:
 *    a. If count + chunk.length > file.bytes: destroy `input` and throw
 *       ExportStreamError('file_size_changed', ...) BEFORE writing the chunk.
 *       Bytes past the plan are never sent.
 *    b. crc = crc32Update(crc, chunk); hash.update(chunk); count += chunk.length.
 *    c. `await writeChunk(out, chunk)`.
 * 3. Errors: wrap the whole loop in try/catch. On any error, destroy `input`
 *    first. Then rethrow an ExportStreamError unchanged (instanceof), and
 *    turn any other error (the read stream's: ENOENT, EACCES, EISDIR ...)
 *    into ExportStreamError('file_missing', ...).
 * 4. After the loop, if count !== file.bytes, throw
 *    ExportStreamError('file_size_changed', ...). A short file fails too.
 * 5. Return { crc, bytes: count, sha256: hash.digest('hex') }.
 *
 * Messages name `file.name`, never `absPath`.
 */
export async function streamFile(out, file, absPath, openRead) {
  const input = openRead(absPath);
  let crc = 0;
  let count = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of input) {
      if (count + chunk.length > file.bytes) {
        input.destroy();
        throw new ExportStreamError('file_size_changed', file.name);
      }
      crc = crc32Update(crc, chunk);
      hash.update(chunk);
      count += chunk.length;
      await writeChunk(out, chunk);
    }
  } catch (err) {
    input.destroy();
    if (err instanceof ExportStreamError) {
      throw err;
    }
    throw new ExportStreamError('file_missing', file.name);
  }
  if (count !== file.bytes) {
    throw new ExportStreamError('file_size_changed', file.name);
  }
  return { crc, bytes: count, sha256: hash.digest('hex') };
}

/**
 * Stream a whole ExportPlan (ok: true) into `out` as a ZIP.
 *
 * `resolvePath`: (plan file path) => absolute path. `siteId`,
 * `generatedAtUtc`: passed to exportManifest. `openRead` defaults to
 * createReadStream.
 *
 * Keep `offset` = bytes written so far, `central` = [] of CentralEntry and
 * `sent` = [] of SentFile. Every write goes through `await writeChunk(out, u8)`
 * followed by `offset += u8.length`.
 *
 * 1. For each file of plan.files, in order:
 *    a. checkEntryName(file.name); `const at = offset`;
 *       `const dos = dosDateTime(parseUtc(file.startUtc))`.
 *    b. write localFileHeader(file.name, dos).
 *    c. `const r = await streamFile(out, file, resolvePath(file.path), openRead)`;
 *       then `offset += r.bytes` (streamFile writes the bytes itself).
 *    d. write dataDescriptor(r.crc, r.bytes).
 *    e. central.push({ name: file.name, dos, crc: r.crc, size: r.bytes, offset: at });
 *       sent.push({ name: file.name, bytes: r.bytes, sha256: r.sha256 }).
 * 2. The manifest: `const text = exportManifest(plan, sent, siteId, generatedAtUtc)`;
 *    `const bytes = Buffer.from(text, 'latin1')` (it is ASCII, so one byte per
 *    character); `const at = offset`; `const dos = dosDateTime(parseUtc(generatedAtUtc))`;
 *    `const crc = crc32Update(0, bytes)`. Write localFileHeader(MANIFEST_ENTRY_NAME, dos),
 *    then bytes, then dataDescriptor(crc, bytes.length). Push its CentralEntry.
 * 3. `const cdOffset = offset`; write centralDirectoryHeader(entry) for each
 *    entry of central, in order; then write
 *    endOfCentralDirectory(central.length, offset - cdOffset, cdOffset).
 * 4. Before returning, wait until `out` has drained — every byte handed to
 *    the sink, none still queued inside it. Resolving sooner would promise an
 *    archive the caller's `out.bytes()` (or its socket buffer) does not yet
 *    hold, and the caller still ends `out` itself.
 * 5. Return { sent, archiveBytes: offset }. Do not end `out`.
 *
 * Any error propagates unchanged (streamFile's, ZipError, ExportManifestError).
 */
export async function streamExport(out, plan, { resolvePath, siteId, generatedAtUtc, openRead = createReadStream }) {
  let offset = 0;
  const central = [];
  const sent = [];
  for (const file of plan.files) {
    checkEntryName(file.name);
    const at = offset;
    const dos = dosDateTime(parseUtc(file.startUtc));
    const localHeader = localFileHeader(file.name, dos);
    await writeChunk(out, localHeader);
    offset += localHeader.length;
    const r = await streamFile(out, file, resolvePath(file.path), openRead);
    offset += r.bytes;
    const dataDesc = dataDescriptor(r.crc, r.bytes);
    await writeChunk(out, dataDesc);
    offset += dataDesc.length;
    central.push({ name: file.name, dos, crc: r.crc, size: r.bytes, offset: at });
    sent.push({ name: file.name, bytes: r.bytes, sha256: r.sha256 });
  }
  const text = exportManifest(plan, sent, siteId, generatedAtUtc);
  const bytes = Buffer.from(text, 'latin1');
  const at = offset;
  const dos = dosDateTime(parseUtc(generatedAtUtc));
  const crc = crc32Update(0, bytes);
  const localHeader = localFileHeader(MANIFEST_ENTRY_NAME, dos);
  await writeChunk(out, localHeader);
  offset += localHeader.length;
  await writeChunk(out, bytes);
  offset += bytes.length;
  const dataDesc = dataDescriptor(crc, bytes.length);
  await writeChunk(out, dataDesc);
  offset += dataDesc.length;
  central.push({ name: MANIFEST_ENTRY_NAME, dos, crc, size: bytes.length, offset: at });

  const cdOffset = offset;
  for (const entry of central) {
    const cdHeader = centralDirectoryHeader(entry);
    await writeChunk(out, cdHeader);
    offset += cdHeader.length;
  }
  const eocd = endOfCentralDirectory(central.length, offset - cdOffset, cdOffset);
  await writeChunk(out, eocd);
  offset += eocd.length;

  // Every byte handed to the sink before this resolves — the last write may
  // have returned true with data still queued inside `out`, and the caller
  // reading `out` at this point must see a complete archive. The queue can
  // empty without a 'drain' event (drain only follows a write that returned
  // false), so this polls `writableLength` rather than listening. A
  // destroyed `out` is the client leaving: reject as client_gone, the EOCD
  // never mattered anyway.
  while (out.writableLength > 0) {
    if (out.destroyed) throw new ExportStreamError('client_gone', 'client gone');
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (out.destroyed) throw new ExportStreamError('client_gone', 'client gone');

  return { sent, archiveBytes: offset };
}