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
    this.combined      = opts.combined ?? false; // if true, mux A+V into one fMP4 stream

    // Video-only MP4 (recommended for easy audio switching)
    this.vOut = null;
    this.vSrc = null;
    this.vMoof = null;
    this._vSegStart = undefined;
    this.vSeq = 0;
    this.vMeta = null;
    this._vMetaSent = false;
    this._vInitEmitted = false;   // whether init (ftyp+moov) callback fired
    this._vPendingSegs = [];      // buffer moof+mdat until init is emitted
    this._vPtsOffsetSec = null;

    // One active audio MP4
    this.aOut = null;
    this.aSrc = null;
    this.aMoof = null;
    this._aSegStart = undefined;
    this.aSeq = 0;
    this.aMeta = null;
    this._aMetaSent = false;
    this._aInitEmitted = false;   // whether init (ftyp+moov) callback fired
    this._aPendingSegs = [];      // buffer moof+mdat until init is emitted
    this._aPtsOffsetSec = null;

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
    this._vInitEmitted = false;
    this._vPendingSegs.length = 0;
    this._vPtsOffsetSec = null;

    this.vOut = new Output({
      format: new Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: this.minFrag,
        onFtyp: (data/*, start*/) => { this._v_ftyp = data; /*this._dbg('onFtyp video'); */ },
        onMoov: async (data/*, start*/) => {
          const init = concat(this._v_ftyp, data);
          const mime = await this.vOut.getMimeType();
          //this._dbg(`onMoov video mime=${mime} initLen=${init.byteLength}`);
          this.onInitVideo(mime, init);
          this._vInitEmitted = true;
          // drain any buffered segments
          if (this._vPendingSegs.length) {
            const pend = this._vPendingSegs.splice(0);
            for (const seg of pend) this.onVideoSeg(seg);
          }
        },
        onMoof: (data, start) => { this.vMoof = data; this._vSegStart = start; /* this._dbg('onMoof video'); */ },
        onMdat: (data/*, start*/) => {
          const seg = concat(this.vMoof, data);
          this.vMoof = null;
          const start = this._vSegStart;
          this._vSegStart = undefined;
          //this._dbg(`onMdat video segLen=${seg.byteLength}`);
          const pkt = {
            data: seg,
            start: typeof start === 'number' ? start / 1_000_000 : undefined,
            startUs: start
          };
          if (!this._vInitEmitted) this._vPendingSegs.push(pkt);
          else this.onVideoSeg(pkt);
        }
      }),
      target: new NullTarget()
    });
    this.vOut.addVideoTrack(this.vSrc, { frameRate: undefined }); // optional

    // --- (Optional) AUDIO OUTPUT separated, for live track switching ---
    if (audio) {
      if (this.combined) {
        // Prepare audio source but attach to video Output
        this.aSrc = new EncodedAudioPacketSource(audioShort(audio.codec));
        this.aMeta = {
          decoderConfig: {
            codec:        audio.codec,
            description:  audio.description,
            numberOfChannels: audio.channel_count,
            sampleRate:   audio.samplerate,
          }
        };
        this._dbg(`start audio (combined): codec=${audio.codec} ch=${audio.channel_count} sr=${audio.samplerate}`);
        this.vOut.addAudioTrack(this.aSrc, {});
      } else {
        await this._startAudio(audio);
      }
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
    this._aInitEmitted = false;
    this._aPendingSegs.length = 0;
    this._aPtsOffsetSec = null;

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
          this._aInitEmitted = true;
          // drain any buffered audio segments
          if (this._aPendingSegs.length) {
            const pend = this._aPendingSegs.splice(0);
            for (const seg of pend) this.onAudioSeg(seg);
          }
        },
        onMoof: (data, start) => { this.aMoof = data; this._aSegStart = start; /* this._dbg('onMoof audio'); */ },
        onMdat: (data/*, start*/) => {
          const seg = concat(this.aMoof, data);
          this.aMoof = null;
          const start = this._aSegStart;
          this._aSegStart = undefined;
          // this._dbg(`onMdat audio segLen=${seg.byteLength}`);
          const pkt = {
            data: seg,
            start: typeof start === 'number' ? start / 1_000_000 : undefined,
            startUs: start
          };
          if (!this._aInitEmitted) this._aPendingSegs.push(pkt);
          else this.onAudioSeg(pkt);
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
    if (this.combined) {
      throw new Error('switchAudio not supported in combined mode');
    }
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
    let ptsSec = toSec(pts);
    if (this._vPtsOffsetSec == null && Number.isFinite(ptsSec)) {
      this._vPtsOffsetSec = ptsSec;
      this._dbg(`video pts baseline=${this._vPtsOffsetSec.toFixed(6)}s`);
    }
    if (this._vPtsOffsetSec != null && Number.isFinite(ptsSec)) {
      ptsSec = Math.max(0, ptsSec - this._vPtsOffsetSec);
    }
    const durSec = toSec(duration);
    // EncodedPacket signature: (data, type, timestamp, duration, sequenceNumber?, byteLength?)
    const p = new EncodedPacket(toU8(data), isKeyframe ? 'key' : 'delta', ptsSec, durSec, ++this.vSeq);
    if (!this._vMetaSent) {
      this._vMetaSent = true; // set before awaiting to avoid races
        this._dbg('sending first video meta');
        await this.vSrc.add(p, this.vMeta);
      } else {
        await this.vSrc.add(p);
      }
    if (this._dbg.enabled && this.vSeq <= 5) {
      this._dbg(`video packet seq=${this.vSeq} pts=${ptsSec} dur=${durSec}`);
    }
  }

  /**
   * Push an encoded audio frame.
   * @param {{pts:number, duration:number, data:Uint8Array}} pkt  // ms, ms
   */
  async pushAudio(pkt) {
    if (!this.started || !this.aSrc) return;
    const { pts, duration, data } = pkt;
    let ptsSec = toSec(pts);
    if (this._aPtsOffsetSec == null && Number.isFinite(ptsSec)) {
      this._aPtsOffsetSec = ptsSec;
      this._dbg(`audio pts baseline=${this._aPtsOffsetSec.toFixed(6)}s`);
    }
    if (this._aPtsOffsetSec != null && Number.isFinite(ptsSec)) {
      ptsSec = Math.max(0, ptsSec - this._aPtsOffsetSec);
    }
    const durSec = toSec(duration);
    const p = new EncodedPacket(toU8(data), 'key', ptsSec, durSec, ++this.aSeq);
    if (this._dbg.enabled && this.aSeq <= 5) {
      this._dbg(`audio packet seq=${this.aSeq} pts=${ptsSec} dur=${durSec}`);
    }
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
    if (!this.combined && this.aOut) tasks.push(this.aOut.finalize());
    await Promise.allSettled(tasks);
    this._vPendingSegs.length = 0;
    this._aPendingSegs.length = 0;
  }
}
