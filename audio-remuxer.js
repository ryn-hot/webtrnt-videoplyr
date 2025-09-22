// audio-remuxer.js
// Minimal helper to remux MKV audio packets into fragmented MP4 segments using mediabunny.

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

export class AudioRemuxer {
  constructor(opts) {
    this._dbg = Debug(opts?.debug ?? 'remuxer:audio');
    this.onInit = opts.onInit ?? (()=>{});
    this.onSegment = opts.onSegment ?? (()=>{});
    this.minFrag = opts.minFragDurationSec ?? 0.8;
    this.aOut = null;
    this.aSrc = null;
    this.aSeq = 0;
    this.meta = null;
    this._initSent = false;
    this._ftyp = null;
    this._pendingInfo = null;
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
    let pendingMoof = null;

    this.aSrc = new EncodedAudioPacketSource(mapCodec(meta.codec));
    this.aOut = new Output({
      format: new Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: this.minFrag,
        onFtyp: (data) => { this._ftyp = data; },
        onMoov: async (data) => {
          const ftyp = this._ftyp ?? new Uint8Array(0);
          const init = new Uint8Array(ftyp.byteLength + data.byteLength);
          init.set(ftyp,0); init.set(data, ftyp.byteLength);
          await this.onInit(meta, init);
        },
        onMoof: (data) => { pendingMoof = data; },
        onMdat: (data) => {
          if (!pendingMoof) return;
          const seg = new Uint8Array(pendingMoof.byteLength + data.byteLength);
          seg.set(pendingMoof,0); seg.set(data,pendingMoof.byteLength);
          pendingMoof = null;
          const info = this._pendingInfo || {};
          this._pendingInfo = null;
          this.onSegment({ pts: info.pts, duration: info.duration }, seg);
        }
      }),
      target: new NullTarget()
    });
    this.aOut.addAudioTrack(this.aSrc, {});
    await this.aOut.start();
  }

  async push(pkt) {
    if (!this.aSrc) throw new Error('AudioRemuxer not started');
    const { pts, duration, data } = pkt;
    const p = new EncodedPacket(toU8(data), 'key', toSec(pts), toSec(duration), ++this.aSeq);
    this._pendingInfo = { pts, duration };
    if (!this._initSent) {
      this._initSent = true;
      await this.aSrc.add(p, this.meta);
    } else {
      await this.aSrc.add(p);
    }
  }

  async finalize() {
    if (this.aOut) {
      await this.aOut.finalize().catch(()=>{});
    }
  }
}

export default AudioRemuxer;
