// fmp4-remuxer.mediabunny.js
// Small, focused module that turns your demuxed MKV packets into fMP4 fragments.
// Works in browser (MSE) or Node (pipe to WS/HTTP).

import {
  Output,
  Mp4OutputFormat,
  NullTarget,
  EncodedPacket,
  PacketType,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
} from 'mediabunny';

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

    // One active audio MP4
    this.aOut = null;
    this.aSrc = null;
    this.aMoof = null;
    this.aSeq = 0;

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
    this.vSrc = new EncodedVideoPacketSource(videoShort(video.codec), {
      // Pass WebCodecs-style decoderConfig
      // description is your avcC/hvcC/vpcC/av1C buffer
      decoderConfig: {
        codec: video.codec,
        description: video.description,
        codedWidth:  video.width,
        codedHeight: video.height,
      }
    });

    this.vOut = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minFragmentDuration: this.minFrag }),
      target: new NullTarget({
        onFtyp: ftyp => { this._v_ftyp = ftyp; },
        onMoov: async moov => {
          const init = concat(this._v_ftyp, moov);
          const mime = await this.vOut.getMimeType(); // e.g. "video/mp4;codecs=\"avc1.640028\""
          this.onInitVideo(mime, init);
        },
        onMoof: moof => { this.vMoof = moof; },
        onMdat: mdat => {
          const seg = concat(this.vMoof, mdat);
          this.vMoof = null;
          this.onVideoSeg(seg);
        }
      })
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
    this.aSrc = new EncodedAudioPacketSource(audioShort(audio.codec), {
      decoderConfig: {
        codec:        audio.codec,            // e.g. "mp4a.40.2" or "opus"
        description:  audio.description,      // e.g. AudioSpecificConfig / dOps / etc.
        numberOfChannels: audio.channel_count,
        sampleRate:   audio.samplerate,
      }
    });

    this.aOut = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minFragmentDuration: this.minFrag }),
      target: new NullTarget({
        onFtyp: ftyp => { this._a_ftyp = ftyp; },
        onMoov: async moov => {
          const init = concat(this._a_ftyp, moov);
          const mime = await this.aOut.getMimeType(); // "audio/mp4;codecs=\"mp4a.40.2\""
          this.onInitAudio(mime, init);
        },
        onMoof: moof => { this.aMoof = moof; },
        onMdat: mdat => {
          const seg = concat(this.aMoof, mdat);
          this.aMoof = null;
          this.onAudioSeg(seg);
        }
      })
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
    // EncodedPacket expects seconds + decode order sequenceNumber. MKV demux emits decode order already.
    const p = new EncodedPacket({
      type: isKeyframe ? PacketType.key : PacketType.delta,
      timestamp: toSec(pts),
      duration:  toSec(duration),
      data,
      sequenceNumber: ++this.vSeq
    });
    await this.vSrc.add(p);
  }

  /**
   * Push an encoded audio frame.
   * @param {{pts:number, duration:number, data:Uint8Array}} pkt  // ms, ms
   */
  async pushAudio(pkt) {
    if (!this.started || !this.aSrc) return;
    const { pts, duration, data } = pkt;
    const p = new EncodedPacket({
      type: PacketType.key,                // compressed audio frames are self-contained
      timestamp: toSec(pts),
      duration:  toSec(duration),
      data,
      sequenceNumber: ++this.aSeq
    });
    await this.aSrc.add(p);
  }

  async finalize() {
    const tasks = [];
    if (this.vOut) tasks.push(this.vOut.finalize());
    if (this.aOut) tasks.push(this.aOut.finalize());
    await Promise.allSettled(tasks);
  }
}