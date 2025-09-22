// test-subtitles.js
import WebTorrent from 'webtorrent';
import SimpleParser from './simple-parser.js'; // Use the revised parser
import { EventEmitter } from 'events';
import Debug from 'debug';
import { convertAnnexBtoAvcC } from './h264-parser.js';
import { convertAnnexBtoHevcC } from './hevc-parser.js';
import { mkvVP9ToVpcc } from './vp9-parser.js';
import { mkvAV1ToAv1C } from './av1-parser.js';
import { annexBtoLengthPrefixed } from './annexBtoLengthPrefixed.js';
import { Fmp4Remuxer } from './fmp4-remuxer.mediabunny.js';
import SegmentStore from './segment-store.js';
import AudioRemuxer from './audio-remuxer.js';
import http from 'http';
import { URL } from 'url';

let tracksReady = false;            // becomes true after remuxer.start()
const earlyPkts = { audio: [], video: [] };
let videoRemuxer = null;           // Fmp4Remuxer instance
const audioRemuxers = new Map();   // trackId -> AudioRemuxer
const audioSeqCounters = new Map();


// a helper that pushes packets once tracks are ready
function drainEarlyPackets() {
  for (const pkt of earlyPkts.video) handleVideo(pkt);
  for (const pkt of earlyPkts.audio) handleAudio(pkt);
  earlyPkts.video.length = earlyPkts.audio.length = 0;
}

const tracksMap = new Map();
const nalLenMap = new Map();     // trackNumber -> NAL length (H.264/H.265)
const segmentStore = new SegmentStore({ windowSize: Number(process.env.SEG_WINDOW) || 12 });
let activeVideoStreamId = null;
const activeAudioStreamIds = new Set();


Debug.enable('test:*,torrent:parser,remuxer'); // Enable debug logs
const log = Debug('test:main');
const logAudio = Debug('test:audio');

const HLS_PORT = Number(process.env.HLS_PORT) || 8081;
let hlsServer = null;

const attrEscape = (str) => String(str ?? '').replace(/"/g, '');
const formatDuration = (seconds) => {
  const val = Number.isFinite(seconds) ? Math.max(seconds, 0) : 0;
  return (Math.round(val * 1000) / 1000).toFixed(3);
};

function respond(res, status, body, contentType = 'text/plain') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function handleMaster(res) {
  const streams = segmentStore.listStreamsWithMeta().filter(({ hasInit }) => hasInit);
  const videoStreams = streams.filter(s => s.meta?.type === 'video');
  const audioStreams = streams.filter(s => s.meta?.type === 'audio');

  if (videoStreams.length === 0) {
    respond(res, 503, '#EXTM3U\n', 'application/vnd.apple.mpegurl');
    return;
  }

  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];

  audioStreams.forEach((entry, idx) => {
    const meta = entry.meta || {};
    const name = attrEscape(meta.label || `Audio ${idx + 1}`);
    const lang = attrEscape(meta.language || 'und');
    const def = idx === 0 ? 'YES' : 'NO';
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",LANGUAGE="${lang}",DEFAULT=${def},AUTOSELECT=${def},URI="/hls/${encodeURIComponent(entry.id)}.m3u8"`);
  });

  videoStreams.forEach(entry => {
    const meta = entry.meta || {};
    const bandwidth = Math.max(1, Math.round(meta.bandwidth || 3_000_000));
    const resolution = meta.width && meta.height ? `,RESOLUTION=${meta.width}x${meta.height}` : '';
    const codecsVideo = meta.codecs || 'avc1.640028';
    const primaryAudioCodec = audioStreams.length ? (audioStreams[0].meta?.codecs || 'mp4a.40.2') : null;
    const codecsAttr = primaryAudioCodec ? `${codecsVideo},${primaryAudioCodec}` : codecsVideo;
    const audioAttr = audioStreams.length ? ',AUDIO="audio"' : '';
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codecsAttr}"${resolution}${audioAttr}`);
    lines.push(`/hls/${encodeURIComponent(entry.id)}.m3u8`);
  });

  respond(res, 200, lines.join('\n') + '\n', 'application/vnd.apple.mpegurl');
}

function handlePlaylist(res, streamId) {
  const window = segmentStore.getHlsWindow(streamId);
  if (!window || !segmentStore.hasInit(streamId)) {
    respond(res, 404, 'No segments');
    return;
  }
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  lines.push(`#EXT-X-TARGETDURATION:${window.targetDuration}`);
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${window.mediaSequence}`);
  lines.push(`#EXT-X-MAP:URI="/hls/init/${encodeURIComponent(streamId)}.mp4"`);
  for (const seg of window.segments) {
    const dur = seg.duration != null ? seg.duration : window.targetDuration;
    lines.push(`#EXTINF:${formatDuration(dur)},`);
    lines.push(`/hls/seg/${encodeURIComponent(streamId)}/${seg.seq}.m4s`);
  }
  if (window.endList) lines.push('#EXT-X-ENDLIST');
  respond(res, 200, lines.join('\n') + '\n', 'application/vnd.apple.mpegurl');
}

function handleInit(res, streamId) {
  const init = segmentStore.getInit(streamId);
  if (!init) {
    respond(res, 404, 'Init not available');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(init.data);
}

function handleSegment(res, streamId, seq) {
  const seg = segmentStore.getSegment(streamId, seq);
  if (!seg) {
    respond(res, 404, 'Segment not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(seg.data);
}

function startHlsServer() {
  hlsServer = http.createServer((req, res) => {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = urlObj.pathname;

      if (pathname === '/hls/master.m3u8') { handleMaster(res); return; }
      if (pathname.startsWith('/hls/init/')) {
        if (!pathname.endsWith('.mp4')) { respond(res, 404, 'Not found'); return; }
        const streamId = decodeURIComponent(pathname.slice('/hls/init/'.length, -'.mp4'.length));
        handleInit(res, streamId);
        return;
      }
      if (pathname.startsWith('/hls/seg/')) {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length !== 4) { respond(res, 404, 'Bad segment path'); return; }
        const streamId = decodeURIComponent(parts[2]);
        const seqStr = parts[3];
        if (!seqStr.endsWith('.m4s')) { respond(res, 404, 'Bad segment suffix'); return; }
        const seq = Number(seqStr.slice(0, -4));
        if (!Number.isFinite(seq)) { respond(res, 400, 'Invalid segment sequence'); return; }
        handleSegment(res, streamId, seq);
        return;
      }
      if (pathname.startsWith('/hls/') && pathname.endsWith('.m3u8')) {
        const streamId = decodeURIComponent(pathname.slice('/hls/'.length, -'.m3u8'.length));
        handlePlaylist(res, streamId);
        return;
      }
      respond(res, 404, 'Not found');
    } catch (err) {
      log(`HLS handler error: ${err.stack || err}`);
      respond(res, 500, 'Internal Server Error');
    }
  });

  hlsServer.listen(HLS_PORT, () => {
    log(`HLS server listening on http://localhost:${HLS_PORT}/hls/master.m3u8`);
  });
}

startHlsServer();


log('Creating WebTorrent client...');
const client = new WebTorrent();
let parserInstance = null;
let torrentInstance = null; // Keep track of the torrent

const magnetURI = 'magnet:?xt=urn:btih:EB4EAIUOCL2CNDPUYPMGWTE42YPOJAZF&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&dn=Solo%20Leveling%20S02E02%20I%20Suppose%20You%20Arent%20Aware%201080p%20CR%20WEB-DL%20AAC2.0%20H%20264-VARYG%20%28Ore%20dake%20Level%20Up%20na%20Ken%2C%20Multi-Subs%29';
const targetFileIndex = 0;


const parserEmitter = new EventEmitter();

parserEmitter.on('subtitle-cue', ({ trackNumber, subtitle }) => {
    // Log the first few subtitle events clearly
    // log(`***** SUBTITLE RECEIVED ***** Track: ${trackNumber}, Time: ${subtitle.time}, Duration: ${subtitle.duration}, Text: ${subtitle.text}`);
});

let seenAudio = 0, seenVideo = 0; 
// Add other listeners as before...
parserEmitter.on('tracks', (tracks) => {
    log('--- Tracks Detected ---');
    const toAscii = s => String(s ?? '').replace(/[^\x20-\x7E]/g, '');

    (tracks || []).forEach(t => {
        const common = {
            id: t.number,
            language: t.language || 'und',
            hdlr: t.type === 'video' ? 'vide' : 'soun',
            timescale: t.type === 'video' ? 90000 : t.samplingFrequency,
            name: '',
            compressorname: ''
        };

        if (t.type === 'video') {
            const mapped = mapMatroskaCodecToFourCC(t.codec, t.header) || {};
            const options = {
                ...common,
                type: (mapped.codec || '').slice(0, 4),
                codec: mapped.codec,
                width: t.width,
                height: t.height,
                description: mapped.description
            };
            if (mapped.annexB && mapped.nalUnitLength) nalLenMap.set(t.number, mapped.nalUnitLength);
            const label = t.codec === 'V_MPEG4/ISO/AVC' ? 'AVC Coding' : t.codec === 'V_MPEGH/ISO/HEVC' ? 'HEVC Coding' : (t.name || 'Video');
            options.name = toAscii(label);
            options.compressorname = options.name.length > 31 ? options.name.slice(0, 31) : options.name;
            tracksMap.set(options.id, { ...options, annexB: Boolean(mapped.annexB) });
            log(`  Track ${t.number}: Type=${t.type}, Codec=${mapped.codec}, Lang=${t.language}, Name=${t.name}, Width=${t.width}, Height=${t.height}`);
        } else if (t.type === 'audio') {
            const mapped = mapMatroskaCodecToFourCC(t.codec, t.header) || {};
            const options = {
                ...common,
                type: (mapped.codec || '').slice(0, 4),
                codec: mapped.codec,
                channel_count: t.channels,
                samplerate: t.samplingFrequency,
                description: mapped.description
            };
            const label = t.name || `Audio ${t.number}`;
            options.name = toAscii(label);
            options.compressorname = options.name.length > 31 ? options.name.slice(0, 31) : options.name;
            tracksMap.set(options.id, options);
            log(`  Track ${t.number}: Type=${t.type}, Codec=${mapped.codec}, Lang=${t.language}, Name=${t.name}, SamplingFrequency=${t.samplingFrequency}, Channels=${t.channels}`);
        } else {
            log(`  Track ${t.number}: Type=${t.type}, Codec=${t.codec}, Lang=${t.language}, Name=${t.name}`);
        }
    });

    try {
        const video = [...tracksMap.values()].find(t => t.hdlr === 'vide');
        if (!video) {
            log('No video track found; skipping remuxer start.');
            return;
        }
        const audioTracks = [...tracksMap.values()].filter(t => t.hdlr === 'soun');

        const segStats = globalThis.__segStats || (globalThis.__segStats = {
            video: { count: 0, bytes: 0, last: 0 },
            audio: { count: 0, bytes: 0, last: 0 },
            timer: null
        });
        if (!segStats.timer) {
            const human = b => b < 1024 ? `${b}B` : b < 1048576 ? `${(b/1024).toFixed(1)}KB` : `${(b/1048576).toFixed(2)}MB`;
            segStats.timer = setInterval(() => {
                const v = segStats.video; const a = segStats.audio;
                const line = `Segments — Video: ${v.count} (${human(v.bytes)}, last ${v.last}) | Audio: ${a.count} (${human(a.bytes)}, last ${a.last})`;
                try {
                    const pad = (process.stdout.columns || 120) - line.length;
                    process.stdout.write('
' + line + (pad > 0 ? ' '.repeat(pad) : ''));
                } catch {}
            }, 500);
        }

        let videoSeq = 0;
        videoRemuxer = new Fmp4Remuxer({
            onInitVideo: (mime, init) => {
                log(`Video init emitted: ${mime}, ${init.byteLength} bytes`);
                const streamId = `v-${video.id}`;
                activeVideoStreamId = streamId;
                segmentStore.setInit(streamId, mime, init);
                segmentStore.setMeta(streamId, {
                  id: video.id,
                  type: 'video',
                  codecs: video.codec,
                  width: video.width,
                  height: video.height,
                  language: video.language || 'und'
                });
            },
            onVideoSegment: (pkt) => {
                const seg = pkt?.data || pkt;
                const s = segStats.video; s.count++; s.bytes += seg.byteLength; s.last = seg.byteLength;
                const startSec = (pkt?.pts ?? 0) / 1000;
                const durSec = pkt?.duration != null ? pkt.duration / 1000 : undefined;
                segmentStore.addSegment(`v-${video.id}`, ++videoSeq, seg, startSec, durSec);
            },
            minFragDurationSec: 0.8,
        });

        const videoStart = videoRemuxer.start({
            video: {
                id: video.id,
                codec: video.codec,
                description: video.description,
                width: video.width,
                height: video.height,
            },
            audio: undefined
        });

        const audioStarts = audioTracks.map(aTrack => {
            const streamId = `a-${aTrack.id}`;
            activeAudioStreamIds.add(streamId);
            const remux = new AudioRemuxer({
                debug: `remuxer:audio:${aTrack.id}`,
                minFragDurationSec: 0.8,
                onInit: (_meta, init) => {
                    segmentStore.setInit(streamId, `audio/mp4; codecs="${tracksMap.get(aTrack.id)?.codec || 'mp4a.40.2'}"`, init);
                    segmentStore.setMeta(streamId, {
                        id: aTrack.id,
                        type: 'audio',
                        codecs: tracksMap.get(aTrack.id)?.codec,
                        channels: aTrack.channel_count,
                        samplerate: aTrack.samplerate,
                        language: aTrack.language || 'und',
                        label: tracksMap.get(aTrack.id)?.name || `Audio ${aTrack.id}`
                    });
                    logAudio(`track=${aTrack.id} init bytes=${init.byteLength}`);
                },
                onSegment: (info, seg) => {
                    const seq = (audioSeqCounters.get(aTrack.id) ?? 0) + 1;
                    audioSeqCounters.set(aTrack.id, seq);
                    const startSec = (info?.pts ?? 0) / 1000;
                    const durSec = info?.duration != null ? info.duration / 1000 : undefined;
                    segmentStore.addSegment(streamId, seq, seg, startSec, durSec);
                    const s = globalThis.__segStats.audio; s.count++; s.bytes += seg.byteLength; s.last = seg.byteLength;
                    if (seq <= 3) logAudio(`track=${aTrack.id} seq=${seq} size=${seg.byteLength}`);
                }
            });
            audioRemuxers.set(aTrack.id, remux);
            audioSeqCounters.set(aTrack.id, 0);
            return remux.start({
                codec: tracksMap.get(aTrack.id)?.codec,
                description: tracksMap.get(aTrack.id)?.description,
                channel_count: aTrack.channel_count,
                samplerate: aTrack.samplerate
            }).catch(err => log(`Error starting audio remuxer track ${aTrack.id}: ${err.message}`));
        });

        Promise.all([videoStart, ...audioStarts]).then(() => {
            tracksReady = true;
            drainEarlyPackets();
        }).catch(err => log(`Error starting remuxers: ${err.message}`));
    } catch (e) {
        log(`Failed to start remuxers: ${e.message || e}`);
    }
});

parserEmitter.on('subtitle-font-data', ({ filename, mimetype }) => {
    log(`--- Font Detected ---: ${filename} (Type: ${mimetype})`);
});
parserEmitter.on('subtitle-chapters', (chapters) => {
    log(`--- Chapters Detected ---: Count = ${chapters?.length || 0}`);
});     
parserEmitter.on('parser-error', (err) => {
    log(`!!! Parser Error: ${err.message || err}`);
});

function handleAudio({ trackNumber, pts, duration, data }) {
    if (++seenAudio <= 10) {
        log('audio packet id',trackNumber,'known',tracksMap.has(trackNumber));
        log(`AUDIO PCKT track=${trackNumber}  pts(ms)=${pts.toFixed(3)} duration(ms)=${duration} size=${data.length}`);
    }
    const remux = audioRemuxers.get(trackNumber);
    if (!remux) {
        if (seenAudio <= 12) logAudio(`track=${trackNumber} no remuxer; dropping`);
        return;
    }
    remux.push({ pts, duration, data }).catch(err => logAudio(`track=${trackNumber} push error ${err.message}`));
}

parserEmitter.on('audio-packet', (pkt) => {
    
    if (!tracksReady) { earlyPkts.audio.push(pkt); return; }
    handleAudio(pkt);

})


function handleVideo({ trackNumber, pts, isKeyframe, data, duration }) {
    const trackInfo = tracksMap.get(trackNumber);
    const nalLen = nalLenMap.get(trackNumber);
    const payload = trackInfo?.annexB && nalLen ? annexBtoLengthPrefixed(data, nalLen) : data;

    if (++seenVideo <= 10) {
        log(`VIDEO PCKT track=${trackNumber} pts(ms)=${pts} key=${isKeyframe?'Y':'n'} duration(ms)=${duration} size=${data.length}`);
    }

    if (videoRemuxer) {
        videoRemuxer.pushVideo({ pts, duration, isKeyframe, data: payload });
    }
}

parserEmitter.on('video-packet', pkt => {

    if (!tracksReady) {                       // gate
        earlyPkts.video.push(pkt);
        return;
    }
    handleVideo(pkt);
})

parserEmitter.on('cue-index-ready', idx => {
  log(`Cue table built: ${idx.length} points`)
  const m = [0, 5_000, 20_000, 60_000]   // ms we’ll probe
  for (const t of m) {
    const entry = parserInstance?.metadata.lookupCue(t)
    log(`lookupCue(${(t/1000).toFixed(1)} s) ⇒ time=${(entry.time/1000).toFixed(2)} s  offset=${entry.offset}`)
  }
  // Do not destroy here; allow streaming to continue
})

parserEmitter.on('parsing-finished', async () => {
    try {
        // Flush last samples to ensure durations on the tail packet
        parserInstance?.metadata?.flush?.();
        if (videoRemuxer) await videoRemuxer.finalize();
        await Promise.allSettled(Array.from(audioRemuxers.values()).map(r => r.finalize()));
        if (activeVideoStreamId) segmentStore.end(activeVideoStreamId);
        activeAudioStreamIds.forEach(id => segmentStore.end(id));
    } finally {
        log('Parser is done.');
        cleanup();
    }
})

client.on('error', (err) => {
    log(`WebTorrent Client Error: ${err.message || err}`);
});

log(`Adding torrent: ${magnetURI}`);
client.add(magnetURI, (torrent) => {
    log(`Torrent metadata ready: ${torrent.infoHash} - ${torrent.name}`);
    torrentInstance = torrent; // Store the torrent instance

    if (targetFileIndex < 0 || targetFileIndex >= torrent.files.length) {
        log(`Error: Invalid fileIndex ${targetFileIndex}`);
        client.destroy();
        return;
    }

    const file = torrent.files[targetFileIndex];
    log(`Target file found: ${file.name} (Size: ${file.length})`);

    if (file.name.endsWith('.mkv') || file.name.endsWith('.webm')) {
        log(`Selecting file ${file.name} for download/streaming...`);
        file.select(); // Prioritize download

        log(`Creating parser for ${file.name}...`);
        // Create parser AFTER selecting file
        parserInstance = new SimpleParser(file, parserEmitter);

        // *** Explicitly start parsing with a stream ***
        log(`Creating stream and starting parser for ${file.name}...`);
        try {
            const stream = file.createReadStream(); // Create a readable stream
            if (!stream) {
                 log("Error: Failed to create read stream for the file.");
                 return;
            }
            stream.on('error', (streamErr) => { // Add error handling for this stream
                log(`Error on stream passed to parser: ${streamErr.message}`);
                if (parserInstance) parserInstance.destroy(); // Clean up parser if stream fails early
                parserInstance = null;
            });
            parserInstance.startParsingFromStream(stream); // Pass the stream to the parser
        } catch(err) {
             log(`Error during stream creation or parser start: ${err.message}`);
             if (parserInstance) parserInstance.destroy();
             parserInstance = null;
        }
    } else {
        log(`Target file ${file.name} is not MKV/WebM, skipping parser creation.`);
    }

    torrent.on('done', () => {
        log(`Torrent download finished: ${torrent.name}`);
    });

    torrent.on('error', (err) => {
        log(`Error in torrent ${torrent.infoHash}: ${err.message || err}`);
    });

    // Optional: Monitor download progress
    // let lastProgress = 0;
    // torrent.on('download', (bytes) => {
    //     const progress = (torrent.progress * 100).toFixed(1);
    //     if (progress - lastProgress >= 5) { // Log every 5%
    //        log(`Torrent Progress: ${progress}% (${(torrent.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s)`);
    //        lastProgress = progress;
    //     }
    // });

});

// Graceful exit
function cleanup() {
    log('Cleaning up...');
    if (hlsServer) {
        try { hlsServer.close(); } catch {}
        hlsServer = null;
    }
    if (parserInstance) {
        parserInstance.destroy();
        parserInstance = null;
    }
    if (videoRemuxer) {
        videoRemuxer.finalize().catch(()=>{});
        videoRemuxer = null;
    }
    audioRemuxers.forEach(r => r.finalize().catch(()=>{}));
    audioRemuxers.clear();
    audioSeqCounters.clear();
    if (activeVideoStreamId) segmentStore.end(activeVideoStreamId);
    activeVideoStreamId = null;
    activeAudioStreamIds.forEach(id => segmentStore.end(id));
    activeAudioStreamIds.clear();
    if (client && !client.destroyed) {
        client.destroy((err) => {
            if (err) log("Error destroying client:", err);
            else log('WebTorrent client destroyed.');
            process.exit(err ? 1 : 0);
        });
    } else {
        process.exit(0);
    }
     // Force exit after a short delay if destroy hangs
     setTimeout(() => {
        log('Cleanup timeout, forcing exit.');
        process.exit(1);
     }, 5000).unref();
}

function toHex(num, len) {
  return num.toString(16).padStart(len, '0');
}

function parseNalLenFromHvcc(hvcc) {
  const u8 = hvcc instanceof Uint8Array ? hvcc
           : new Uint8Array(hvcc);           // works for ArrayBuffer too
  if (u8.byteLength < 22) throw new Error('hvcC too short');
  const len = (u8[21] & 0x03) + 1;           // spec: lengthSizeMinusOne
  if (len !== 1 && len !== 2 && len !== 4) {
    throw new Error(`invalid hvcC NAL length ${len}`);
  }
  return len;
}

function parseNalLenFromAvcC(avcC) {
  // Normalize to a Uint8Array
  let u8;
  if (avcC instanceof Uint8Array) {
    u8 = avcC;
  } else if (avcC instanceof ArrayBuffer) {
    u8 = new Uint8Array(avcC);
  } else if (ArrayBuffer.isView(avcC)) {
    u8 = new Uint8Array(avcC.buffer, avcC.byteOffset, avcC.byteLength);
  } else {
    throw new TypeError('parseNalLenFromAvcC: unsupported input type');
  }

  if (u8.byteLength < 5) {
    throw new Error('parseNalLenFromAvcC: avcC too short (< 5 bytes)');
  }

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const lengthSizeMinusOne = dv.getUint8(4) & 0x03;   // last 2 bits of byte 4
  const nalLen = lengthSizeMinusOne + 1;

  if (nalLen !== 1 && nalLen !== 2 && nalLen !== 4) {
    throw new Error(`parseNalLenFromAvcC: invalid nal length ${nalLen}`);
  }
  return nalLen;
}

function mapMatroskaCodecToFourCC(codecID, codecPrivate) {
  switch (codecID) {
    // ───── Audio ─────
    case 'A_AAC':
      // AAC-LC: ISO/IEC 14496-3 audioObjectType 2
        return { codec: 'mp4a.40.2', description: codecPrivate };              
    case 'A_OPUS':
      // Opus in MP4 is experimental but supported in Chrome
        return { codec: 'opus', description: codecPrivate };;                       
    case 'A_VORBIS':
        return { codec: 'vorbis', description: undefined};                    
    case 'A_FLAC':
      // FLAC-in-MP4 (requires MP4Box v0.8+), Chrome supports FLAC decode :contentReference[oaicite:0]{index=0}
        return { codec: 'flac', description: codecPrivate ?? undefined };                       
    case 'A_MPEG/L3':
      // MP3-in-MP4 uses objectTypeIndication 0x6B → "mp4a.40.34"
        return {codec: 'mp4a.40.34', description: undefined};                 
    case 'A_MPEG/L2':
      // MPEG-2 Audio in MP4 is rare; try objectTypeIndication 0x69 → "mp4a.40.69"
        return {codec: 'mp4a.40.69', description: undefined};                 
    case 'A_PCM/INT/LIT':
      // Linear PCM: ISO-BMFF FourCC is "lpcm", but MSE support may vary
        return { codec: 'lpcm', description: undefined};      
    case 'A_E-AC-3':
      // E-AC-3 in ISO-BMFF
        return { codec: 'ec-3', description: codecPrivate ?? undefined};       
      
    // ───── Video ─────
    case 'V_MPEG4/ISO/AVC': {
        //log(`Codec Private: ${codecPrivate[0]}`);

        if (!codecPrivate) return null;

        log(`Codec Private:`)
        log('--- H.264 CodecPrivate ---');
        log('HEX:', Buffer.from(codecPrivate).toString('hex'));
        log('--------------------------');

       if (codecPrivate[0] === 1) {
            // It's confirmed to be avcC, parse it directly.
            const profile = codecPrivate[1];
            const compatibility = codecPrivate[2];
            const level = codecPrivate[3];
            const n = parseNalLenFromAvcC(codecPrivate);
            const buffer = codecPrivate.slice(codecPrivate.byteOffset, codecPrivate.byteOffset + codecPrivate.byteLength);  
            
            return {
                codec: `avc1.${toHex(profile, 2)}${toHex(compatibility, 2)}${toHex(level, 2)}`,
                description: buffer,
                nalUnitLength: n,
                annexB: false
            }
        } else {
            // --- It's likely Annex B, run your converter ---
            const avcConfig = convertAnnexBtoAvcC(codecPrivate);
            const buffer = avcConfig.buffer;

            return {
                codec: `avc1.${toHex(avcConfig.profile, 2)}${toHex(avcConfig.compatibility, 2)}${toHex(avcConfig.level, 2)}`,
                description: buffer,
                nalUnitLength: 4,
                annexB: true
            }

        }
    }

    case 'V_MPEGH/ISO/HEVC': {

        if (!codecPrivate) return null;

        if (codecPrivate[0] === 1) {
            // The hvcC box structure is more complex than avcC.
            // Offsets are from the start of the hvcC box.
            // See ISO/IEC 14496-15 for the full specification.
            const profileSpace = (codecPrivate[1] >> 6) & 0x03; // Not always needed for codec string
            const tierFlag = (codecPrivate[1] >> 5) & 0x01;
            const profileIdc = codecPrivate[1] & 0x1F;
            
            // general_profile_compatibility_flags is 4 bytes (32 bits)
            // const compatFlags = codecPrivate.readUInt32BE(2);

            const compatFlags =
                (codecPrivate[2] << 24) | (codecPrivate[3] << 16) |
                (codecPrivate[4] << 8)  |  codecPrivate[5];
            
            const levelIdc = codecPrivate[12];
            
            // Parse lengthSizeMinusOne from the 22nd byte
            // const naluLengthSize = (codecPrivate[21] & 0x03) + 1;

            const n = parseNalLenFromHvcc(codecPrivate);

            const tier = tierFlag ? 'H' : 'L';

            // Codec string format: hvc1.<profile_idc>.<compat_flags_hex>.<tier><level_idc>
            // Note: Some players may prefer a simpler codec string. This is the more complete version.
            const codecString = `hvc1.${profileIdc}.${compatFlags.toString(16).padStart(8,'0')}.${tier}${levelIdc}`;
            const buffer = codecPrivate.slice(codecPrivate.byteOffset, codecPrivate.byteOffset + codecPrivate.byteLength);

            return {
                codec: codecString,
                description: buffer,
                nalUnitLength: n,
                annexB: false,
            }

        }
        else {
            // H.265: requires VPS/SPS/PPS → hvc1.<profile-space>.<tier>.<profile-id>.<lvl>
            const hevcConfig = convertAnnexBtoHevcC(codecPrivate);

            // The correct format is hvc1.<profile>.<compat_flags>.<tier><level>
            const profile = hevcConfig.general_profile_idc;
            // Reverse the bytes of the compatibility flags and convert to hex
            const compat = hevcConfig.general_profile_compatibility_flags;
            const compatHex = compat.toString(16).padStart(8, '0');

            const tier = hevcConfig.general_tier_flag ? 'H' : 'L';
            const level = hevcConfig.general_level_idc;
            const buffer = hevcConfig.buffer

            return {
                codec: `hvc1.${profile}.${compatHex}.${tier}${level}`,
                description: buffer,
                nalUnitLength: 4,
                annexB: true,
            };
        }
    }
    case 'V_VP8':
      return { codec:'vp8', description: undefined };                       
    case 'V_VP9':
        // Chrome supports VP9 Profile 0: level 1.0 → "vp09.00.10.08" :contentReference[oaicite:1]{index=1}
        try  { return mkvVP9ToVpcc(codecPrivate); }
        catch { return { codec: 'vp09.00.10.08', description: undefined }; }
         
    case 'V_AV1':
        try  { return mkvAV1ToAv1C(codecPrivate); }
        catch { return { codec: 'av01.0.04M.08',  description: undefined }; }
      // AV1 Profile 0, level 2.0, main tier, 8-bit → "av01.0.04M.08"            

    // ───── Unsupported in MP4 for MSE ─────
    
    case 'V_THEORA':
    case 'A_AC3':
      // Chrome can decode Theora/AC-3 in Ogg/WebM or native only
      return null;

    default:
      return null;
  }
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
