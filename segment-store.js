// segment-store.js
// Lightweight in-memory store for CMAF-style fMP4 streams (video/audio).
// Maintains per-stream init segment and a sliding window of media segments
// with sequence numbers, start times, and durations.

/**
 * @typedef {Object} Segment
 * @property {number} seq
 * @property {Uint8Array} data
 * @property {number} start  // seconds
 * @property {number|undefined} duration // seconds
 * @property {boolean} discontinuity
 */

/**
 * @typedef {Object} StreamInfo
 * @property {string|null} mime
 * @property {Uint8Array|null} init
 * @property {Map<number, Segment>} segments
 * @property {number[]} order
 * @property {number} maxSegments
 * @property {boolean} ended
 * @property {number|null} firstSeq
 * @property {number|null} lastSeq
 * @property {Object} meta // freeform track metadata for manifests
 * @property {boolean} pendingDiscontinuity
 * @property {number} discontinuitySequence
 * @property {number} epochId
*/

function toU8(x) {
  if (x == null) throw new TypeError('expected bytes');
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  // Node Buffer is a Uint8Array subclass; covered above.
  throw new TypeError('expected Uint8Array/ArrayBuffer(View)');
}

export class SegmentStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.windowSize] number of segments to retain per stream
   */
  constructor(opts = {}) {
    this.mode = opts.mode === 'vod' ? 'vod' : 'live';
    this.windowSize = Number.isFinite(opts.windowSize) && opts.windowSize > 0
      ? Math.floor(opts.windowSize)
      : Infinity;
    /** @type {Map<string, StreamInfo>} */
    this.streams = new Map();
  }

  /** Ensure a stream record exists. */
  _ensure(id) {
    let s = this.streams.get(id);
    if (!s) {
      s = {
        mime: null,
        init: null,
        segments: new Map(),
        order: [],
        maxSegments: this.windowSize,
        ended: false,
        firstSeq: null,
        lastSeq: null,
        meta: {},
        baseStart: null,
        pendingDiscontinuity: false,
        discontinuitySequence: 0,
        epochId: 0
      };
      this.streams.set(id, s);
    }
    return s;
  }

  /** Return metadata object for a stream (as stored via setMeta). */
  getMeta(id) {
    const s = this.streams.get(id);
    return s ? s.meta : null;
  }

  /** Whether stream has init segment set. */
  hasInit(id) {
    const s = this.streams.get(id);
    return !!(s && s.init && s.mime);
  }

  /** List stream ids with meta snapshot. */
  listStreamsWithMeta() {
    return Array.from(this.streams.entries()).map(([id, s]) => ({
      id,
      meta: s.meta,
      hasInit: !!s.init,
      hasSegments: s.order.length > 0
    }));
  }

  /**
   * Assign or update descriptive metadata (e.g., codec, width/height, language).
   * @param {string} id
   * @param {object} meta
   */
  setMeta(id, meta) {
    const s = this._ensure(id);
    s.meta = { ...s.meta, ...meta };
  }

  /**
   * Set init segment and MIME type for a stream.
   * @param {string} id
   * @param {string} mime
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
   */
  setInit(id, mime, bytes, opts = {}) {
    const s = this._ensure(id);
    s.mime = mime;
    s.init = toU8(bytes);
    if (Number.isFinite(opts.epochId)) {
      s.epochId = opts.epochId;
    }
  }

  /**
   * Add a media segment for stream `id`.
   * Auto-fills previous segment duration if unknown.
   * Evicts oldest when window exceeds.
   * @param {string} id
   * @param {number} seq
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
   * @param {number} startSec
   * @param {number|undefined} durationSec
   */
  addSegment(id, seq, bytes, startSec, durationSec) {
    if (!Number.isFinite(seq) || seq <= 0) throw new TypeError('seq must be positive number');
    if (!Number.isFinite(startSec) || startSec < 0) throw new TypeError('startSec must be non-negative');
    const s = this._ensure(id);
    const data = toU8(bytes);
    if (s.baseStart == null) s.baseStart = startSec;
    const offset = startSec - s.baseStart;
    const normalizedStart = Math.abs(offset) <= 1e-3 ? 0 : offset;
    const seg = {
      seq,
      data,
      start: normalizedStart,
      duration: Number.isFinite(durationSec) ? durationSec : undefined,
      discontinuity: s.pendingDiscontinuity,
      epochId: s.epochId
    };
    if (s.pendingDiscontinuity) {
      s.pendingDiscontinuity = false;
    }
    if (s.order.length < 4) {
      console.log(`[segment-store] stream=${id} seq=${seq} start=${normalizedStart.toFixed(6)} base=${s.baseStart?.toFixed?.(6) ?? s.baseStart}`);
    }
    if (s.segments.has(seq)) throw new Error(`duplicate segment seq=${seq} for stream ${id}`);
    // set previous duration if missing
    if (s.lastSeq != null) {
      const prev = s.segments.get(s.lastSeq);
      if (prev && (prev.duration == null)) {
        const delta = normalizedStart - prev.start;
        if (delta >= 1e-6) prev.duration = delta;
      }
    }
    s.segments.set(seq, seg);
    s.order.push(seq);
    if (s.firstSeq == null) s.firstSeq = seq;
      s.lastSeq = seq;
    // evict window head
    while (s.order.length > s.maxSegments) {
      const drop = s.order.shift();
      if (drop != null) s.segments.delete(drop);
      s.firstSeq = s.order.length ? s.order[0] : s.lastSeq;
    }
  }

  /** Mark end-of-stream for a given stream. */
  end(id) { this._ensure(id).ended = true; }

  /** Clear a stream (init + segments). */
  clear(id) { this.streams.delete(id); }

  /**
   * Get init for a stream.
   * @param {string} id
   * @returns {{mime:string, data:Uint8Array}|null}
   */
  getInit(id) {
    const s = this.streams.get(id);
    if (!s || !s.init || !s.mime) return null;
    return { mime: s.mime, data: s.init };
  }

  /**
   * Get segment by seq.
   * @param {string} id
   * @param {number} seq
   * @returns {Segment|null}
   */
  getSegment(id, seq) {
    const s = this.streams.get(id);
    if (!s) return null;
    return s.segments.get(seq) || null;
  }

  /**
   * Return a snapshot suitable for an HLS playlist window.
   * @param {string} id
   * @returns {{mediaSequence:number, targetDuration:number, segments:Segment[], endList:boolean, playlistType:(string|null), meta:object}|null}
   */
  getHlsWindow(id) {
    const s = this.streams.get(id);
    if (!s || s.order.length === 0) return null;
    const segments = s.order.map(seq => s.segments.get(seq)).filter(Boolean);
    // compute target duration: ceil of max known duration (fallback to 1)
    let maxDur = 0;
    for (const seg of segments) {
      if (Number.isFinite(seg.duration)) maxDur = Math.max(maxDur, seg.duration);
    }
    const targetDuration = Math.max(1, Math.ceil(maxDur || 1));
    const playlistType = this.mode === 'vod'
      ? (s.ended ? 'VOD' : 'EVENT')
      : (s.ended ? 'EVENT' : null);
    return {
      mediaSequence: s.firstSeq ?? segments[0].seq,
      targetDuration,
      segments,
      endList: s.ended,
      playlistType,
      meta: s.meta,
      discontinuitySequence: s.discontinuitySequence,
      epochId: s.epochId
    };
  }

  /** Get stream ids currently present. */
  listStreams() { return Array.from(this.streams.keys()); }

  /**
   * Drop existing segments and mark that the next segment starts a new discontinuity.
   * @param {string} id
   * @param {object} [opts]
   * @param {boolean} [opts.dropInit=true]
   * @param {boolean} [opts.dropSegments=true]
   */
  markDiscontinuity(id, opts = {}) {
    const s = this._ensure(id);
    const dropSegments = opts.dropSegments !== false;
    const dropInit = opts.dropInit !== false; // default true
    if (dropSegments) {
      s.segments.clear();
      s.order.length = 0;
      s.firstSeq = null;
      s.lastSeq = null;
    }
    if (dropInit) {
      s.init = null;
      s.mime = null;
    }
    if (dropSegments) {
      s.baseStart = null;
    }
    s.pendingDiscontinuity = true;
    s.discontinuitySequence = (s.discontinuitySequence || 0) + 1;
  }

  /** Return the latest sequence number tracked for a stream (0 if none). */
  getLastSeq(id) {
    const s = this.streams.get(id);
    return s?.lastSeq ?? 0;
  }

  getFirstSeq(id) {
    const s = this.streams.get(id);
    return s?.firstSeq ?? null;
  }

  /**
   * Find the sequence whose start time is closest to the requested second.
   * Returns the smallest seq with start >= timeSec; if none, returns lastSeq.
   */
  getSeqForTime(id, timeSec) {
    const s = this.streams.get(id);
    if (!s || s.order.length === 0) return null;
    for (const seq of s.order) {
      const seg = s.segments.get(seq);
      if (!seg) continue;
      if (!Number.isFinite(seg.start) || seg.start >= timeSec) {
        return seq;
      }
    }
    return s.lastSeq ?? s.order[s.order.length - 1];
  }

  /**
   * Remove all stored segments with sequence less than `seq`.
   * Useful for trimming to the first post-reset fragment.
   * @param {string} id
   * @param {number} seq
   */
  dropBefore(id, seq, opts = {}) {
    const s = this.streams.get(id);
    if (!s) return;
    const inclusive = opts.inclusive === true;
    const threshold = inclusive ? seq + 1 : seq;
    s.order = s.order.filter(n => n >= threshold);
    for (const n of Array.from(s.segments.keys())) {
      if (n < threshold) s.segments.delete(n);
    }
    s.firstSeq = s.order.length ? s.order[0] : s.lastSeq;
    if (s.order.length) {
      const firstSeg = s.segments.get(s.order[0]);
      if (firstSeg) s.baseStart = firstSeg.start;
    }
  }

  /**
   * Reset a stream to an empty sliding window while preserving its init/meta.
   * Marks a discontinuity so the next segment starts a new continuity sequence.
   */
  resetStream(id, opts = {}) {
    const s = this._ensure(id);
    if (opts.dropInit) {
      s.init = null;
      s.mime = null;
    }
    s.segments.clear();
    s.order.length = 0;
    s.firstSeq = null;
    s.lastSeq = null;
    s.baseStart = null;
    s.pendingDiscontinuity = true;
    s.discontinuitySequence = (s.discontinuitySequence || 0) + 1;
    s.ended = false;
    if (Number.isFinite(opts.epochId)) {
      s.epochId = opts.epochId;
    }
  }
}

export default SegmentStore;
