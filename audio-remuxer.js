// audio-remuxer.js
// Buffers demuxed audio frames and remuxes them into CMAF-compatible fragments
// via Mediabunny. By batching frames ourselves we guarantee accurate timing
// metadata (start/duration) for every emitted segment.

import {
  Output,
  Mp4OutputFormat,
  NullTarget,
  EncodedPacket,
  EncodedAudioPacketSource,
} from 'mediabunny';
import Debug from 'debug';

const toSec = (ms) => ms / 1000;
const mapCodec = (codec) => {
  if (!codec) throw new Error('codec required');
  if (codec.startsWith('mp4a')) return 'aac';
  if (codec === 'opus') return 'opus';
  if (codec === 'vorbis') return 'vorbis';
  if (codec === 'flac') return 'flac';
  if (codec === 'lpcm') return 'pcm-s16';
  if (codec === 'mp3' || codec === 'mp4a.40.34') return 'mp3';
  return codec;
};

const toU8 = (data) => {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('audio data must be Uint8Array or ArrayBuffer(View)');
};

const readUint32 = (buf, offset) => (
  (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]
) >>> 0;

const readUint64 = (buf, offset) => {
  const hi = readUint32(buf, offset);
  const lo = readUint32(buf, offset + 4);
  return (BigInt(hi) << 32n) | BigInt(lo);
};

const writeUint32 = (buf, offset, value) => {
  buf[offset]     = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
};

const writeUint64 = (buf, offset, value) => {
  const big = BigInt(value);
  const hi = Number((big >> 32n) & 0xffffffffn);
  const lo = Number(big & 0xffffffffn);
  writeUint32(buf, offset, hi);
  writeUint32(buf, offset + 4, lo);
};

const readType = (buf, offset) => String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);

function readBoxHeader(buf, offset) {
  if (offset + 8 > buf.length) return null;
  let size = readUint32(buf, offset);
  const type = readType(buf, offset + 4);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > buf.length) return null;
    size = Number(readUint64(buf, offset + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = buf.length - offset;
  }
  if (size < headerSize) return null;
  return { size, type, headerSize };
}

function overwriteTfdtBase(segment, startSeconds, timescale, dbg) {
  if (!Number.isFinite(timescale) || timescale <= 0 || segment.byteLength < 16) return;
  const expected = Math.max(0, Math.round(startSeconds * timescale));
  const stack = [{ start: 0, end: segment.byteLength }];

  while (stack.length) {
    const { start, end } = stack.pop();
    let cursor = start;
    while (cursor + 8 <= end) {
      const header = readBoxHeader(segment, cursor);
      if (!header) return;
      const { size, type, headerSize } = header;
      const boxStart = cursor + headerSize;
      const boxEnd = cursor + size;
      if (type === 'tfdt') {
        const version = segment[boxStart];
        const target = expected >>> 0;
        if (version === 0) {
          writeUint32(segment, boxStart + 4, target);
        } else {
          writeUint64(segment, boxStart + 4, expected);
        }
        if (dbg?.enabled) dbg(`tfdt adjusted -> ${expected} (timescale=${timescale})`);
        return;
      }
      if (type === 'moof' || type === 'traf') {
        stack.push({ start: boxStart, end: boxEnd });
      }
      if (size <= 0) break;
      cursor += size;
    }
  }
}

export class AudioRemuxer {
  constructor(opts) {
    this._dbg = Debug(opts?.debug ?? 'remuxer:audio');
    this.onInit = opts.onInit ?? (()=>{});
    this.onSegment = opts.onSegment ?? (()=>{});
    this.minFrag = opts.minFragDurationSec ?? 0.8;
    this._debugHook = typeof opts?.onDebugEvent === 'function' ? opts.onDebugEvent : null;

    this.meta = null;
    this._initSent = false;

    this._buffer = [];
    this._bufferDurationMs = 0;
    this._bufferStartMs = null;
    this._flushPromise = null;

    this._packetSeq = 0;  // sequence for EncodedPacket
    this._frameSeq = 0;   // debug counter
    this._segmentSeq = 0; // emitted segments

    this._queue = [];
    this._processing = false;
    this._drainPromise = Promise.resolve();
    this._ptsOffsetMs = null;
  }

  _emitDebug(type, payload) {
    if (!this._debugHook) return;
    try {
      this._debugHook(type, payload);
    } catch (err) {
      this._dbg(`debug hook error: ${err?.message || err}`);
    }
  }

  async start(meta) {
    if (!meta || !meta.codec) throw new Error('Audio meta required');
    this.meta = {
      decoderConfig: {
        codec:        meta.codec,
        description:  meta.description,
        numberOfChannels: meta.channel_count,
        sampleRate:   meta.samplerate,
      }
    };

    this._dbg(`start codec=${meta.codec} ch=${meta.channel_count} sr=${meta.samplerate}`);
    this._emitDebug('start', {
      codec: meta.codec,
      channels: meta.channel_count,
      sampleRate: meta.samplerate
    });

    this._buffer.length = 0;
    this._bufferDurationMs = 0;
    this._bufferStartMs = null;
    this._flushPromise = null;
    this._initSent = false;
    this._packetSeq = 0;
    this._frameSeq = 0;
    this._segmentSeq = 0;
    this._queue.length = 0;
    this._processing = false;
    this._drainPromise = Promise.resolve();
    this._ptsOffsetMs = null;
  }

  async push(pkt) {
    if (!this.meta) throw new Error('AudioRemuxer not started');
    const { pts, duration, data } = pkt;

    let adjPtsMs = Number.isFinite(pts) ? pts : 0;
    if (this._ptsOffsetMs == null && Number.isFinite(adjPtsMs)) {
      this._ptsOffsetMs = adjPtsMs;
      this._dbg(`pts baseline established @${this._ptsOffsetMs.toFixed(3)}ms`);
    }
    if (this._ptsOffsetMs != null && Number.isFinite(adjPtsMs)) {
      adjPtsMs = Math.max(0, adjPtsMs - this._ptsOffsetMs);
    }

    const frameData = Uint8Array.from(toU8(data));
    const durationMs = Number.isFinite(duration) ? duration : 0;

    const frame = {
      ptsMs: adjPtsMs,
      ptsSec: toSec(adjPtsMs),
      durationMs,
      durationSec: toSec(durationMs),
      data: frameData
    };

    const frameSeq = ++this._frameSeq;
    this._emitDebug('push', {
      seq: frameSeq,
      pts,
      ptsAdjusted: adjPtsMs,
      duration,
      durationInferred: !Number.isFinite(duration),
      dataBytes: frameData.byteLength
    });
    if (frameSeq <= 3) {
      this._dbg(`push seq=${frameSeq} rawPts=${pts} adjPts=${adjPtsMs}`);
    }

    return new Promise((resolve, reject) => {
      this._queue.push({ frame, resolve, reject });
      this._kickWorker();
    });
  }

  async finalize() {
    try {
      await this._drainPromise;
      if (this._flushPromise) await this._flushPromise;
      await this._flushBuffer(true);
    } finally {
      // no-op but keep structure for future cleanup if needed
    }
  }

  _kickWorker() {
    if (this._processing) return;
    this._processing = true;
    const run = async () => {
      while (this._queue.length) {
        const entry = this._queue.shift();
        try {
          await this._processFrame(entry.frame);
          entry.resolve();
        } catch (err) {
          entry.reject(err);
          throw err;
        }
      }
    };

    this._drainPromise = run()
      .catch(err => {
        this._dbg(`queue worker error: ${err?.message || err}`);
        throw err;
      })
      .finally(() => {
        this._processing = false;
        if (this._queue.length) {
          this._kickWorker();
        }
      });
  }

  async _processFrame(frame) {
    if (this._bufferStartMs == null) this._bufferStartMs = frame.ptsMs;
    this._buffer.push(frame);
    this._bufferDurationMs += frame.durationMs;

    if (this._bufferDurationMs >= this.minFrag * 1000) {
      await this._flushBuffer();
    }
  }

  async _flushBuffer(force = false) {
    if (!force && this._buffer.length === 0) return;
    if (this._flushPromise) return this._flushPromise;
    if (this._buffer.length === 0) return;

    const frames = this._buffer.slice();
    const startMs = this._bufferStartMs ?? frames[0]?.ptsMs ?? 0;
    if (this._dbg.enabled) {
      this._dbg(`flush frames=${frames.length} startMs=${startMs}`);
    }
    const totalDurationMs = frames.reduce((sum, f) => sum + (Number.isFinite(f.durationMs) ? f.durationMs : 0), 0);

    this._buffer = [];
    this._bufferDurationMs = 0;
    this._bufferStartMs = null;

    this._flushPromise = this._remuxFrames(frames, startMs, totalDurationMs)
      .catch(err => {
        // Requeue frames so they are not lost
        this._buffer = frames.concat(this._buffer);
        this._bufferDurationMs += totalDurationMs;
        if (this._bufferStartMs == null) this._bufferStartMs = startMs;
        throw err;
      })
      .finally(() => {
        this._flushPromise = null;
      });

    return this._flushPromise;
  }

  async _remuxFrames(frames, startMs, durationMs) {
    if (!frames.length) return;

    const codecId = mapCodec(this.meta.decoderConfig.codec);
    const src = new EncodedAudioPacketSource(codecId);

    let currentFtyp = null;
    let pendingMoof = null;
    let pendingStartUs = null;
    let segmentParts = [];
    let totalSegmentBytes = 0;
    const segmentSeq = ++this._segmentSeq;

    const format = new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: 0,
      onFtyp: (data) => { currentFtyp = data; },
      onMoov: async (data) => {
        if (this._initSent) return;
        const ftyp = currentFtyp ?? new Uint8Array(0);
        const init = new Uint8Array(ftyp.byteLength + data.byteLength);
        init.set(ftyp, 0);
        init.set(data, ftyp.byteLength);
        this._emitDebug('init', { byteLength: init.byteLength });
        await this.onInit(this.meta, init);
        this._initSent = true;
      },
      onMoof: (data, start) => {
        pendingMoof = data;
        pendingStartUs = start;
        this._emitDebug('moof', {
          seq: segmentSeq,
          startUs: start,
          startSec: typeof start === 'number' ? start / 1_000_000 : undefined,
          frameCount: frames.length
        });
      },
      onMdat: (data) => {
        if (!pendingMoof) return;
        const combo = new Uint8Array(pendingMoof.byteLength + data.byteLength);
        combo.set(pendingMoof, 0);
        combo.set(data, pendingMoof.byteLength);
        segmentParts.push(combo);
        totalSegmentBytes += combo.byteLength;
        const startSec = startMs / 1000;
        this._emitDebug('mdat', {
          seq: segmentSeq,
          startUs: pendingStartUs,
          startSec,
          durationMs,
          bytes: combo.byteLength
        });
        pendingMoof = null;
      }
    });

    const out = new Output({ format, target: new NullTarget() });
    out.addAudioTrack(src, {});
    await out.start();

    let sentMeta = false;
    for (const frame of frames) {
      const packet = new EncodedPacket(
        frame.data,
        'key',
        frame.ptsSec,
        frame.durationSec,
        ++this._packetSeq
      );
      if (!sentMeta) {
        await src.add(packet, this.meta);
        sentMeta = true;
      } else {
        await src.add(packet);
      }
    }

    await out.finalize();

    if (segmentParts.length === 0) {
      throw new Error('AudioRemuxer: segmentBytes not produced');
    }

    const startSec = startMs / 1000;
    const durationSec = durationMs / 1000;

    let segmentBytes;
    if (segmentParts.length === 1) {
      segmentBytes = segmentParts[0];
    } else {
      segmentBytes = new Uint8Array(totalSegmentBytes);
      let offset = 0;
      for (const part of segmentParts) {
        segmentBytes.set(part, offset);
        offset += part.byteLength;
      }
    }

    const sampleRate = this.meta?.decoderConfig?.sampleRate;
    if (segmentBytes && Number.isFinite(sampleRate) && sampleRate > 0) {
      overwriteTfdtBase(segmentBytes, startSec, sampleRate, this._dbg);
    }
    const payload = {
      pts: Math.round(startMs),
      duration: Math.round(durationSec * 1_000_000),
      startSec,
      start: startSec,
      startUs: Math.round(startSec * 1_000_000)
    };

    this._emitDebug('segment', {
      seq: segmentSeq,
      ...payload,
      bytes: segmentBytes.byteLength
    });

    await this.onSegment(payload, segmentBytes);
  }
}

export default AudioRemuxer;
