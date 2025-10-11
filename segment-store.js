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
    this.windowSize = Number.isFinite(opts.windowSize) && opts.windowSize > 0 ? Math.floor(opts.windowSize) : 12;
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
        maxSegments: this.mode === 'vod' ? Infinity : this.windowSize,
        ended: false,
        firstSeq: null,
        lastSeq: null,
        meta: {},
        baseStart: null
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
  setInit(id, mime, bytes) {
    const s = this._ensure(id);
    s.mime = mime;
    s.init = toU8(bytes);
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
    const seg = { seq, data, start: normalizedStart, duration: Number.isFinite(durationSec) ? durationSec : undefined };
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
    // evict
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
      meta: s.meta
    };
  }

  /** Get stream ids currently present. */
  listStreams() { return Array.from(this.streams.keys()); }
}

export default SegmentStore;
