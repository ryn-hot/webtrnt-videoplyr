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
import fs from 'fs';

let tracksReady = false;            // becomes true after remuxer.start()
const earlyPkts = { audio: [], video: [] };
let remuxer = null;                 // Fmp4Remuxer instance


// a helper that pushes packets once tracks are ready
function drainEarlyPackets() {
  for (const pkt of earlyPkts.video) handleVideo(pkt);
  for (const pkt of earlyPkts.audio) handleAudio(pkt);
  earlyPkts.video.length = earlyPkts.audio.length = 0;
}

const tracksMap = new Map();
const nalLenMap = new Map();     // trackNumber -> NAL length (H.264/H.265)


Debug.enable('test:*,torrent:parser,remuxer'); // Enable debug logs
const log = Debug('test:main');


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
            id: t.number,                            // REQUIRED for this build
            language: t.language || 'und',
            hdlr: t.type === 'video' ? 'vide' : 'soun',
            timescale: t.type === 'video' ? 90000 : t.samplingFrequency,
            name: '',
            compressorname: ''
        };

        if (t.type === "video") {
            const { codec, description, nalUnitLength, annexB } = mapMatroskaCodecToFourCC(t.codec, t.header);

            if ((t.codec === 'V_MPEG4/ISO/AVC' || t.codec === 'V_MPEGH/ISO/HEVC') && nalUnitLength === undefined) {
                throw new Error(`Broken MKV: no decoder config for ${t.codec}`);
            }

            const sampleType = codec.slice(0, 4);

            const options = {
                ...common,
                type: sampleType,
                codec,
                width: t.width,
                height: t.height,
                description
            }

            if (annexB && nalUnitLength) {
                // Only needed when the MKV payload is Annex B and we must convert per-packet
                nalLenMap.set(t.number, nalUnitLength);
            }
            

            const label = (t.codec === 'V_MPEG4/ISO/AVC') ? 'AVC Coding'
            : (t.codec === 'V_MPEGH/ISO/HEVC') ? 'HEVC Coding'
            : (t.name || 'Video');


            options.name = toAscii(label);
            options.compressorname = options.name.length > 31
                ? options.name.slice(0, 31)
                : options.name;

            tracksMap.set(options.id, { ...options, annexB: Boolean(annexB) });
            

            // Note: removed undefined helpers (setNamesEverywhere, tapWriteFooter, dumpSD)
            log(`  Track ${t.number}: Type=${t.type}, Codec=${codec}, Lang=${t.language}, Name=${t.name}, Width=${t.width}, Height=${t.height} `)
        } else if (t.type === "audio") {
            const { codec, description } = mapMatroskaCodecToFourCC(t.codec, t.header);

            const sampleType = codec.slice(0, 4);

            const options = {
                ...common,
                type: sampleType,
                codec, 
                channel_count: t.channels,
                samplerate: t.samplingFrequency,
                description
            }
            
            if (description) {
                options.description = description;
            }

            const label = t.name || 'Audio';
            options.name = toAscii(label);
            options.compressorname = options.name.length > 31
                ? options.name.slice(0, 31)
                : options.name;

            tracksMap.set(options.id, options);
        
            log(`  Track ${t.number}: Type=${t.type}, Codec=${codec}, Lang=${t.language}, Name=${t.name}, SamplingFrequency=${t.samplingFrequency}, Channels=${t.channels} `)
        } else {
            log(`  Track ${t.number}: Type=${t.type}, Codec=${t.codec}, Lang=${t.language}, Name=${t.name}`)
        }

    }); //Header: ${t.header}

    // After we have populated tracksMap, initialize the fMP4 remuxer
    try {
        // pick first video track
        const video = [...tracksMap.values()].find(t => t.hdlr === 'vide');
        if (!video) {
            log('No video track found; skipping remuxer start.');
            return;
        }
        // pick first audio track (optional)
        const audio = [...tracksMap.values()].find(t => t.hdlr === 'soun');

        remuxer = new Fmp4Remuxer({
            onInitVideo: (mime, init) => {
                log(`Video init emitted: ${mime}, ${init.byteLength} bytes`);
                // Optional: write to disk
                // fs.writeFileSync('init-video.mp4', Buffer.from(init));
            },
            onVideoSegment: (seg) => {
                log(`Video segment: ${seg.byteLength} bytes`);
                // Optional: append to file
                // fs.appendFileSync('video-segments.m4s', Buffer.from(seg));
            },
            onInitAudio: (mime, init) => {
                log(`Audio init emitted: ${mime}, ${init.byteLength} bytes`);
                // fs.writeFileSync('init-audio.mp4', Buffer.from(init));
            },
            onAudioSegment: (seg) => {
                log(`Audio segment: ${seg.byteLength} bytes`);
                // fs.appendFileSync('audio-segments.m4s', Buffer.from(seg));
            },
            minFragDurationSec: 0.8,
        });

        remuxer.start({
            video: {
                id: video.id,
                codec: video.codec,
                description: video.description,
                width: video.width,
                height: video.height,
            },
            audio: audio ? {
                id: audio.id,
                codec: audio.codec,
                description: audio.description,
                channel_count: audio.channel_count,
                samplerate: audio.samplerate,
            } : undefined
        }).then(() => {
            tracksReady = true;
            drainEarlyPackets();
        }).catch(err => {
            log('Error starting remuxer:', err);
        });
    } catch (e) {
        log('Failed to start remuxer:', e);
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
    if (remuxer) {
        remuxer.pushAudio({ pts, duration, data }); // mediabunny expects seconds; remuxer converts ms→s internally
    }
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

    if (remuxer) {
        remuxer.pushVideo({ pts, duration, isKeyframe, data: payload }); // remuxer converts ms→s internally
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
        if (remuxer) await remuxer.finalize();
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
    if (parserInstance) {
        parserInstance.destroy();
        parserInstance = null;
    }
    if (remuxer) {
        remuxer.finalize().catch(()=>{});
        remuxer = null;
    }
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
