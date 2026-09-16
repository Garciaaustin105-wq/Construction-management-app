// agent/ui/live-client.mjs
//
// Pure client-side half of the live edge: re-assembly of ffmpeg's fragmented
// MP4 WebSocket stream into MSE-appendable segments, plus the codec string a
// page needs to open a SourceBuffer. Zero imports — the browser page and the
// Node harness import the IDENTICAL file, so the feared part (box boundaries
// falling inside WS chunks) is testable without a browser. Refusals are
// VALUES ({ error }), never thrown.
//
// Why not just append every WS chunk: SourceBuffer.appendBuffer needs whole
// media segments, and ffmpeg's stdout chunks do not align to MP4 box
// boundaries. So bytes are buffered until top-level boxes complete, then
// emitted as: the init segment (everything through the first moov), then each
// moof+mdat pair as one contiguous buffer (they form ONE media segment — mdat
// is moof's SIBLING, never its child), then any other complete box.

// Big-endian unsigned reads. >>> 0 keeps the 32-bit one unsigned; sizes are
// far below 2^53 so the 64-bit one is a plain number, not a BigInt.
const readU32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const readU64 = (b, o) => readU32(b, o) * 0x100000000 + readU32(b, o + 4);
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// Complete top-level boxes parseable from bytes, in order. Stops at the first
// incomplete tail. size === 0 (extends to end of stream) and corrupt sizes
// (< 8) stop the walk — only flush() knows where the stream truly ends.
export function parseTopLevelBoxes(bytes) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= bytes.length) {
    const size32 = readU32(bytes, off);
    const type = fourcc(bytes, off + 4);
    let size;
    if (size32 === 1) {
      if (off + 16 > bytes.length) break;
      size = readU64(bytes, off + 8);
    } else if (size32 === 0 || size32 < 8) {
      break;
    } else {
      size = size32;
    }
    if (off + size > bytes.length) break;
    boxes.push({ type, start: off, size });
    off += size;
  }
  return boxes;
}

// WS bytes in, MSE-appendable buffers out. push(chunk) RETURNS the emissions
// (never a DOM event — this module must run in a harness with no document).
export function createBoxAccumulator() {
  let buf = new Uint8Array(0);
  let out = [];
  let initDone = false;

  const concat = (a, b) => {
    const n = new Uint8Array(a.length + b.length);
    n.set(a);
    n.set(b, a.length);
    return n;
  };

  function push(chunk) {
    buf = concat(buf, chunk);
    for (;;) {
      const boxes = parseTopLevelBoxes(buf);
      if (!boxes.length) break;
      const b = boxes[0];
      const end = b.start + b.size;
      if (!initDone) {
        // Everything from stream start through the first moov is ONE init
        // emission (normally ftyp+moov). Earlier complete boxes stay buffered
        // — emitting them alone would split the init segment — so the moov is
        // searched for anywhere in the parsed list, not assumed to be first.
        const moov = boxes.find((x) => x.type === 'moov');
        if (!moov) break;
        const end = moov.start + moov.size;
        out.push(buf.slice(0, end));
        initDone = true;
        buf = buf.slice(end);
        continue;
      }
      if (b.type === 'moof') {
        // mdat must be the NEXT top-level box and complete; otherwise wait —
        // a media segment split across two appendBuffer calls is invalid.
        const next = boxes[1];
        if (!next || next.type !== 'mdat') break;
        out.push(buf.slice(0, next.start + next.size));
        buf = buf.slice(next.start + next.size);
        continue;
      }
      // free, sidx, or a lone mdat: pass through individually, in order.
      out.push(buf.slice(0, end));
      buf = buf.slice(end);
    }
    const emissions = out;
    out = [];
    return emissions;
  }

  function flush() {
    // Whatever remains (an incomplete box, a size===0 box, a moof whose mdat
    // never arrived) goes out as-is: a broken append beats silently dropped
    // bytes, because dropped bytes corrupt every frame after them.
    if (buf.length) out.push(buf);
    buf = new Uint8Array(0);
    const emissions = out;
    out = [];
    return emissions;
  }

  return { push, flush };
}

// The codec string MSE needs up front: 'video/mp4; codecs="<video>, <audio>"'.
export function extractMimeCodec(initSegment) {
  const top = parseTopLevelBoxes(initSegment);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return { error: 'no moov box in the init segment' };

  // Child boxes parse from offset `from` onward, but a parsed box's start is
  // relative to that subarray — the data slice needs the same offset added,
  // or every grandchild walk reads a box shifted by its parent's header.
  const childBoxes = (bytes, from) =>
    parseTopLevelBoxes(bytes.subarray(from)).map((b) => ({
      type: b.type,
      data: bytes.subarray(from + b.start, from + b.start + b.size),
    }));
  const find = (boxes, type) => boxes.find((b) => b.type === type) ?? null;

  // moov is a plain container: its payload IS the child boxes.
  const moovBody = initSegment.subarray(moov.start + 8, moov.start + moov.size);
  const traks = childBoxes(moovBody, 0).filter((b) => b.type === 'trak');
  const entries = [];
  for (const trak of traks) {
    const mdia = find(childBoxes(trak.data, 8), 'mdia');
    if (!mdia) continue;
    const minf = find(childBoxes(mdia.data, 8), 'minf');
    if (!minf) continue;
    const stbl = find(childBoxes(minf.data, 8), 'stbl');
    if (!stbl) continue;
    const stsd = find(childBoxes(stbl.data, 8), 'stsd');
    if (!stsd) continue;
    const count = readU32(stsd.data, 12);
    let off = 16;
    const stsdBody = stsd.data;
    for (let i = 0; i < count && off + 8 <= stsdBody.length; i++) {
      const size = readU32(stsdBody, off);
      if (size < 8 || off + size > stsdBody.length) break;
      entries.push({ type: fourcc(stsdBody, off + 4), data: stsdBody.subarray(off, off + size) });
      off += size;
    }
  }

  // Sample entries: 8-byte box header, then ISO 14496-12's fixed fields per
  // kind — video 78 (VisualSampleEntry), audio 28 (AudioSampleEntry) — before
  // the avcC/hvcC/esds child. ffmpeg's muxer writes them exactly this way.
  const VIDEO_CHILD_AT = 86; // 8 header + 78 fixed fields
  const AUDIO_CHILD_AT = 36; // 8 header + 28 fixed fields
  const isVideo = (t) => t === 'avc1' || t === 'avc3' || t === 'hvc1' || t === 'hev1';

  const videoEntry = entries.find((e) => isVideo(e.type));
  if (!videoEntry) return { error: 'no video sample entry in the moov' };
  const videoKids = childBoxes(videoEntry.data, VIDEO_CHILD_AT);
  let videoCodec = null;
  if (videoEntry.type === 'avc1' || videoEntry.type === 'avc3') {
    const avcC = find(videoKids, 'avcC');
    // avcC payload: [0] configurationVersion, [1] profile, [2] compat, [3] level.
    const q = avcC ? avcC.data.subarray(8) : null;
    if (!q || q.length < 4) return { error: 'avc1 entry without an avcC record' };
    const hex2 = (n) => n.toString(16).padStart(2, '0');
    videoCodec = `avc1.${hex2(q[1])}${hex2(q[2])}${hex2(q[3])}`;
  } else {
    const hvcC = find(videoKids, 'hvcC');
    // hvcC payload needs 13 bytes at minimum: through general_level_idc at [12].
    const q = hvcC ? hvcC.data.subarray(8) : null;
    if (!q || q.length < 13) return { error: 'hevc entry without an hvcC record' };
    const space = (q[1] >> 6) & 0x03;
    const idc = q[1] & 0x1f;
    const tier = q[1] & 0x20 ? 'H' : 'L';
    // Compatibility flags go into the string BIT-REVERSED, leading zeros
    // stripped (ISO 14496-15 Annex E notation — verified against Chromium's
    // video_codec_string_parsers.cc).
    let compat = readU32(q, 2);
    let rev = 0;
    for (let i = 0; i < 32; i++) {
      rev = (rev << 1) | (compat & 1);
      compat >>>= 1;
    }
    const spaceLetter = ['', 'A', 'B', 'C'][space];
    const cons = [];
    for (let i = 6; i < 12; i++) cons.push(q[i].toString(16).padStart(2, '0').toUpperCase());
    while (cons.length && cons[cons.length - 1] === '00') cons.pop();
    videoCodec = `${videoEntry.type}.${spaceLetter}${idc}.${rev.toString(16)}.${tier}${q[12]}.${cons.join('.')}`;
  }

  // Audio is optional: a video-only mime is still playable, so an mp4a track
  // that fails to parse degrades to video-only rather than an error.
  const audioEntry = entries.find((e) => e.type === 'mp4a');
  let audioCodec = '';
  if (audioEntry) {
    const esds = find(childBoxes(audioEntry.data, AUDIO_CHILD_AT), 'esds');
    if (esds) {
      // esds payload: 4 version/flags bytes, then the descriptor chain.
      const aot = audioObjectTypeFromEsds(esds.data.subarray(12));
      if (aot !== null) audioCodec = `, mp4a.40.${aot}`;
    }
  }
  return { mime: `video/mp4; codecs="${videoCodec}${audioCodec}"` };
}

// MPEG-4 descriptor lengths are expandable-128 (7 bits per byte, high bit
// continues) — a fixed u32 read desynchronises every field after the first.
function descrLen(bytes, o) {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    len = (len << 7) | (bytes[o + i] & 0x7f);
    if (!(bytes[o + i] & 0x80)) return { len, next: o + i + 1 };
  }
  return { len, next: o + 4 };
}

// Read one descriptor's tag+length, returning the offset of its payload — or
// null when the bytes there are not the expected tag.
function readDescr(p, off, tag) {
  if (off + 2 > p.length || p[off] !== tag) return null;
  return descrLen(p, off + 1).next;
}

// esds payload (after the 4 version/flags bytes) is STRUCTURAL, not a flat
// tag soup: ES_Descriptor (0x03) -> DecoderConfigDescriptor (0x04) ->
// DecoderSpecificInfo (0x05). The ES payload is ES_ID (2) + flags (1) —
// ffmpeg's muxer writes flags=0, and a flags≠0 layout adds fields this walk
// does not claim to read. The DCD payload is 13 fixed bytes (object type,
// stream type, buffer size, two bitrates) before its DSI child. The DSI
// payload is the AudioSpecificConfig: first 5 bits are the audioObjectType
// (31 = escape: 32 + the next 6 bits). Returns null anywhere the walk does
// not land on the expected structure — audio then degrades to video-only.
function audioObjectTypeFromEsds(p) {
  let off = readDescr(p, 0, 0x03);
  if (off === null) return null;
  off = readDescr(p, off + 3, 0x04); // past ES_ID + flags
  if (off === null) return null;
  off = readDescr(p, off + 13, 0x05); // past the DCD's fixed fields
  if (off === null) return null;
  const asc = p.subarray(off);
  if (asc.length < 1) return null;
  let aot = (asc[0] >> 3) & 0x1f;
  if (aot === 31) {
    if (asc.length < 2) return null;
    aot = 32 + (((asc[0] & 0x07) << 3) | (asc[1] >> 5));
  }
  return aot;
}

// ── Live buffer steering ─────────────────────────────────────────────────────
//
// A live tile's SourceBuffer must be trimmed, or it grows for as long as the
// tile is open. THE FEARED FAILURE (seen on the bench): trimming the range the
// playhead is IN. The picture freezes on its last frame while the socket, the
// server and the status line all still say "live", and new data lands past a
// hole the <video> never jumps. So the trim only ever cuts behind the
// playhead, and a playhead left outside the buffer, or too far behind the live
// edge, is moved to the edge.

export const LIVE_TARGET_LATENCY_S = 1;   // where a seek puts the playhead, behind the edge
export const LIVE_MAX_LATENCY_S = 4;      // further behind the edge than this: seek
export const LIVE_WINDOW_S = 20;          // trim once the playhead is this far past the buffer start
export const LIVE_KEEP_BEHIND_S = 10;     // a trim keeps this much behind the playhead
export const LIVE_IN_RANGE_TOLERANCE_S = 0.25;

/**
 * Decide how to steer one live tile. Pure: the page reads the SourceBuffer
 * and the <video>, calls this, and applies the result.
 *
 * `ranges`: the buffered ranges as an array of [startSeconds, endSeconds]
 * pairs, ascending (the page copies them out of SourceBuffer.buffered).
 * `currentTime`: the <video>'s currentTime in seconds.
 *
 * Returns `{ seekTo, removeEnd }`, keys in that order, each a number or null:
 *   seekTo     set video.currentTime to this, or null to leave it
 *   removeEnd  sb.remove(ranges[0][0], removeEnd), or null to remove nothing
 *
 * 1. Refuse to steer, returning { seekTo: null, removeEnd: null }, when
 *    `ranges` is not an array, is empty, or any element is not an array of
 *    exactly two finite numbers with end >= start; or when `currentTime` is
 *    not a finite number (typeof "number" and Number.isFinite).
 * 2. Let last = the final pair and edge = last[1]. The playhead is "inside"
 *    when some pair has start - LIVE_IN_RANGE_TOLERANCE_S <= currentTime <=
 *    end + LIVE_IN_RANGE_TOLERANCE_S.
 * 3. seekTo: when the playhead is not inside, OR edge - currentTime >
 *    LIVE_MAX_LATENCY_S, seekTo = Math.max(last[0], edge - LIVE_TARGET_LATENCY_S).
 *    Otherwise null.
 * 4. Let p = seekTo when it is not null, else currentTime. removeEnd: when
 *    p - ranges[0][0] > LIVE_WINDOW_S, removeEnd = p - LIVE_KEEP_BEHIND_S.
 *    Otherwise null. (So removeEnd is always behind p: never the range being
 *    played.)
 * 5. Never mutate `ranges`. Never throw.
 */
export function planLiveBuffer(ranges, currentTime) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return { seekTo: null, removeEnd: null };
  }
  for (const pair of ranges) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return { seekTo: null, removeEnd: null };
    }
    const start = pair[0];
    const end = pair[1];
    if (typeof start !== "number" || !Number.isFinite(start)) {
      return { seekTo: null, removeEnd: null };
    }
    if (typeof end !== "number" || !Number.isFinite(end) || end < start) {
      return { seekTo: null, removeEnd: null };
    }
  }
  if (typeof currentTime !== "number" || !Number.isFinite(currentTime)) {
    return { seekTo: null, removeEnd: null };
  }

  const last = ranges[ranges.length - 1];
  const edge = last[1];
  const inside = ranges.some(
    (pair) =>
      pair[0] - LIVE_IN_RANGE_TOLERANCE_S <= currentTime &&
      currentTime <= pair[1] + LIVE_IN_RANGE_TOLERANCE_S
  );
  let seekTo = null;
  if (!inside || edge - currentTime > LIVE_MAX_LATENCY_S) {
    seekTo = Math.max(last[0], edge - LIVE_TARGET_LATENCY_S);
  }
  const p = seekTo === null ? currentTime : seekTo;
  let removeEnd = null;
  if (p - ranges[0][0] > LIVE_WINDOW_S) {
    removeEnd = p - LIVE_KEEP_BEHIND_S;
  }
  return { seekTo, removeEnd };
}

// ── Reconnecting a live tile ─────────────────────────────────────────────────
//
// A TV on the wall has nobody to press "Reconnect". A camera reboot, a Wi-Fi
// blip or the watchdog restarting the recorder would otherwise leave dead
// tiles until someone walks over. THE FEARED FAILURES: a tile that retries in
// a tight loop and floods the recorder, and a tile that retries something that
// can never work (this browser cannot decode the codec) forever.

export const RECONNECT_FIRST_MS = 2000;
export const RECONNECT_MAX_MS = 30000;

/** Why a tile stopped. Only these are worth trying again. */
export const RECONNECT_REASONS = Object.freeze(["closed", "stalled", "ended", "source_failed", "mainstream_failed"]);

/**
 * How long to wait before reconnecting a tile, or null for never.
 *
 * `reason`: a string saying why the tile stopped.
 * `attempt`: how many reconnects have already been tried since the tile last
 *   played (0 for the first retry).
 *
 * 1. If `reason` is not one of RECONNECT_REASONS (by ===), return null. That
 *    includes "codec_unsupported" and "codec_unreadable": the same browser
 *    will refuse the same stream again.
 * 2. If `attempt` is not a number, not finite, not an integer or negative,
 *    return RECONNECT_MAX_MS (keep trying, slowly, rather than stop).
 * 3. Otherwise return Math.min(RECONNECT_FIRST_MS * 2 ** attempt,
 *    RECONNECT_MAX_MS). So 2 s, 4 s, 8 s, 16 s, then 30 s for good; a huge
 *    attempt must still return RECONNECT_MAX_MS, never Infinity or NaN.
 * 4. Never throw.
 */
export function reconnectDelayMs(reason, attempt) {
  if (!RECONNECT_REASONS.includes(reason)) return null;
  if (!Number.isInteger(attempt) || attempt < 0) return RECONNECT_MAX_MS;
  if (attempt >= 30) return RECONNECT_MAX_MS; // 2 ** attempt would overflow the cap
  return Math.min(RECONNECT_FIRST_MS * 2 ** attempt, RECONNECT_MAX_MS);
}
