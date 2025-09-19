// fmp4-remuxer.mediabunny.js
// Small, focused module that turns your demuxed MKV packets into fMP4 fragments.
// Works in browser (MSE) or Node (pipe to WS/HTTP).

import {
  Output,
  Mp4OutputFormat,
  NullTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
} from 'mediabunny';
import Debug from 'debug';

// Helpers: map your FourCC -> Mediabunny short codec id
function videoShort(codec) {
  if (codec.startsWith('avc1') || codec.startsWith('avc3')) return 'avc';
  if (codec.startsWith('hvc1') || codec.startsWith('hev1')) return 'hevc';
  if (codec.startsWith('vp09')) return 'vp9';
  if (codec.startsWith('av01')) return 'av1';
  if (codec.startsWith('vp8'))  return 'vp8';
  throw new Error(`Unsupported video codec ${codec}`);
}
function audioShort(codec) {
  if (codec.startsWith('mp4a')) return 'aac';
  if (codec === 'opus')        return 'opus';
  if (codec === 'vorbis')      return 'vorbis';
  if (codec === 'flac')        return 'flac';
  if (codec === 'mp3' || codec === 'mp4a.40.34') return 'mp3';
  if (codec === 'lpcm')        return 'pcm-s16'; // pick one; adjust if you expose depth
  throw new Error(`Unsupported audio codec ${codec}`);
}

function toSec(ms)     { return ms / 1000; }
function concat(a, b)  { const out = new Uint8Array(a.length + b.length); out.set(a,0); out.set(b,a.length); return out; }
function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // Best effort: Buffer is a Uint8Array, plain arrays are not supported
  throw new TypeError('data must be a Uint8Array or ArrayBuffer(View)');
}

export class Fmp4Remuxer {
  /**
   * @param {Object} opts
   * @param {(mime:string, init:Uint8Array)=>void} opts.onInitVideo
   * @param {(seg:Uint8Array)=>void}               opts.onVideoSegment
   * @param {(mime:string, init:Uint8Array)=>void} [opts.onInitAudio]
   * @param {(seg:Uint8Array)=>void}               [opts.onAudioSegment]
   * @param {number} [opts.minFragDurationSec]  // e.g. 0.5–1.0
   */
  constructor(opts) {
    this._dbg = Debug('remuxer');
    this.onInitVideo   = opts.onInitVideo;
    this.onVideoSeg    = opts.onVideoSegment;
    this.onInitAudio   = opts.onInitAudio ?? (()=>{});
    this.onAudioSeg    = opts.onAudioSegment ?? (()=>{});
    this.minFrag       = opts.minFragDurationSec ?? 0.8;

    // Video-only MP4 (recommended for easy audio switching)
    this.vOut = null;
    this.vSrc = null;
    this.vMoof = null;
    this.vSeq = 0;
    this.vMeta = null;
    this._vMetaSent = false;

    // One active audio MP4
    this.aOut = null;
    this.aSrc = null;
    this.aMoof = null;
    this.aSeq = 0;
    this.aMeta = null;
    this._aMetaSent = false;

    this.started = false;
  }

  /**
   * Call once when your 'tracks' event fires and you picked which audio track to start with.
   * @param {Object} trackInfo
   * @param {{id:number, codec:string, description?:ArrayBufferView|ArrayBuffer, width?:number, height?:number}} trackInfo.video
   * @param {{id:number, codec:string, description?:ArrayBufferView|ArrayBuffer, channel_count?:number, samplerate?:number}} [trackInfo.audio]
   */
  async start(trackInfo) {
    const { video, audio } = trackInfo;
    if (!video) throw new Error('Video track required');

    // --- VIDEO OUTPUT (fragmented MP4 with callbacks) ---
    this.vSrc = new EncodedVideoPacketSource(videoShort(video.codec));
    // Prepare WebCodecs-style decoderConfig for first packet add
    this.vMeta = {
      decoderConfig: {
        codec:        video.codec,
        description:  video.description,
        codedWidth:   video.width,
        codedHeight:  video.height,
      }
    };

    this._dbg(`start video: codec=${video.codec} ${video.width}x${video.height}`);
    this.vOut = new Output({
      format: new Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: this.minFrag,
        onFtyp: (data/*, start*/) => { this._v_ftyp = data; this._dbg('onFtyp video'); },
        onMoov: async (data/*, start*/) => {
          const init = concat(this._v_ftyp, data);
          const mime = await this.vOut.getMimeType();
          this._dbg(`onMoov video mime=${mime} initLen=${init.byteLength}`);
          this.onInitVideo(mime, init);
        },
        onMoof: (data/*, start*/) => { this.vMoof = data; this._dbg('onMoof video'); },
        onMdat: (data/*, start*/) => {
          const seg = concat(this.vMoof, data);
          this.vMoof = null;
          this._dbg(`onMdat video segLen=${seg.byteLength}`);
          this.onVideoSeg(seg);
        }
      }),
      target: new NullTarget()
    });
    this.vOut.addVideoTrack(this.vSrc, { frameRate: undefined }); // optional

    // --- (Optional) AUDIO OUTPUT separated, for live track switching ---
    if (audio) {
      await this._startAudio(audio);
    }

    await this.vOut.start();
    if (this.aOut) await this.aOut.start();
    this.started = true;
  }

  async _startAudio(audio) {
    // Tear down previous audio if present
    if (this.aOut) {
      await this.aOut.finalize().catch(()=>{});
    }
    this.aSrc = new EncodedAudioPacketSource(audioShort(audio.codec));
    this.aMeta = {
      decoderConfig: {
        codec:        audio.codec,            // e.g. "mp4a.40.2" or "opus"
        description:  audio.description,      // e.g. AudioSpecificConfig / dOps / etc.
        numberOfChannels: audio.channel_count,
        sampleRate:   audio.samplerate,
      }
    };

    this._dbg(`start audio: codec=${audio.codec} ch=${audio.channel_count} sr=${audio.samplerate}`);
    this.aOut = new Output({
      format: new Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: this.minFrag,
        onFtyp: (data/*, start*/) => { this._a_ftyp = data; this._dbg('onFtyp audio'); },
        onMoov: async (data/*, start*/) => {
          const init = concat(this._a_ftyp, data);
          const mime = await this.aOut.getMimeType();
          this._dbg(`onMoov audio mime=${mime} initLen=${init.byteLength}`);
          this.onInitAudio(mime, init);
        },
        onMoof: (data/*, start*/) => { this.aMoof = data; this._dbg('onMoof audio'); },
        onMdat: (data/*, start*/) => {
          const seg = concat(this.aMoof, data);
          this.aMoof = null;
          this._dbg(`onMdat audio segLen=${seg.byteLength}`);
          this.onAudioSeg(seg);
        }
      }),
      target: new NullTarget()
    });
    this.aOut.addAudioTrack(this.aSrc, {});
  }

  /**
   * Switch audio on the fly. Provide the *new* audio track meta from your mapMatroskaCodecToFourCC().
   * In the browser, call SourceBuffer.changeType(newMime) right before we emit the new init segment.
   */
  async switchAudio(newAudioMeta) {
    await this._startAudio(newAudioMeta);
    if (this.started) await this.aOut.start();
    this.aSeq = 0;
  }

  /**
   * Push an encoded video frame.
   * @param {{pts:number, duration:number, isKeyframe:boolean, data:Uint8Array}} pkt  // ms, ms, boolean, length-prefixed if H.264/H.265
   */
  async pushVideo(pkt) {
    if (!this.started) return;
    const { pts, duration, isKeyframe, data } = pkt;
    // EncodedPacket signature: (data, type, timestamp, duration, sequenceNumber?, byteLength?)
    const p = new EncodedPacket(toU8(data), isKeyframe ? 'key' : 'delta', toSec(pts), toSec(duration), ++this.vSeq);
    if (!this._vMetaSent) {
      this._vMetaSent = true; // set before awaiting to avoid races
      this._dbg('sending first video meta');
      await this.vSrc.add(p, this.vMeta);
    } else {
      await this.vSrc.add(p);
    }
  }

  /**
   * Push an encoded audio frame.
   * @param {{pts:number, duration:number, data:Uint8Array}} pkt  // ms, ms
   */
  async pushAudio(pkt) {
    if (!this.started || !this.aSrc) return;
    const { pts, duration, data } = pkt;
    const p = new EncodedPacket(toU8(data), 'key', toSec(pts), toSec(duration), ++this.aSeq);
    if (!this._aMetaSent) {
      this._aMetaSent = true;
      this._dbg('sending first audio meta');
      await this.aSrc.add(p, this.aMeta);
    } else {
      await this.aSrc.add(p);
    }
  }

  async finalize() {
    const tasks = [];
    if (this.vOut) tasks.push(this.vOut.finalize());
    if (this.aOut) tasks.push(this.aOut.finalize());
    await Promise.allSettled(tasks);
  }
}
