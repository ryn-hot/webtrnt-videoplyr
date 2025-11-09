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
import Diagnostics from './diagnostics.js';
import SeekController from './seek-controller.js';
import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';

let tracksReady = false;            // becomes true after remuxer.start()
const earlyPkts = { audio: [], video: [] };
let videoRemuxer = null;           // Fmp4Remuxer instance
const audioRemuxers = new Map();   // trackId -> AudioRemuxer
const audioSeqCounters = new Map();
const debugAudioDumpLimit = Number(process.env.DEBUG_AUDIO_DUMP || 0);
let debugAudioPacketCounter = 0;

const baseVideoPts = new Map();   // first pts per video track (ms)
const baseAudioPts = new Map();
const audioTrackDelay = new Map(); // trackNumber -> total delay ms
const lastVideoPtsMs = new Map();   // monotonic guard for seeks

let currentTrackLayout = { video: null, audio: [] };
let audioGateOpen = true;           // audio allowed when true
const gatedAudioQueue = [];         // audio packets held while gate closed
let awaitingVideoPostSeek = null;  // stores epochId waiting for first keyframe seg after reset
const videoKeyframeRequired = new Set(); // track IDs waiting for next keyframe
const videoSeqOverrides = new Map();      // trackId -> lastSeq baseline after trim
const audioSeqOverrides = new Map();      // trackId -> lastSeq baseline after trim

const trackKey = (id) => String(id ?? '');
let currentParserFile = null;
let activeParserStream = null;
let requireKeyframeOnNextStart = false;
let currentEpochId = 0;
let pendingEpochId = null;
let softAudioGate = null; // { targetSec, reason, source, startedAt }


// a helper that pushes packets once tracks are ready
function drainEarlyPackets() {
  if (earlyPkts.video.length) {
    const videoPkts = earlyPkts.video.splice(0, earlyPkts.video.length);
    for (const pkt of videoPkts) handleVideo(pkt);
  }
  if (earlyPkts.audio.length) {
    const audioPkts = earlyPkts.audio.splice(0, earlyPkts.audio.length);
    for (const pkt of audioPkts) {
      if (!audioGateOpen) {
        gatedAudioQueue.push(pkt);
      } else {
        handleAudio(pkt);
      }
    }
  }
}

const tracksMap = new Map();
const nalLenMap = new Map();     // trackNumber -> NAL length (H.264/H.265)
const hlsMode = (process.env.HLS_MODE || 'vod').toLowerCase() === 'live' ? 'live' : 'vod';
const segWindowEnv = Number(process.env.SEG_WINDOW);
const segmentStore = new SegmentStore({
  windowSize: Number.isFinite(segWindowEnv) && segWindowEnv > 0 ? segWindowEnv : Infinity,
  mode: hlsMode
});
let activeVideoStreamId = null;
const activeAudioStreamIds = new Set();
let torrentInstance = null;


Debug.enable('test:*,torrent:parser,remuxer,test:hls'); // Enable debug logs
const log = Debug('test:main');
const logAudio = Debug('test:audio');
const logHls = Debug('test:hls');

const HLS_PORT = Number(process.env.HLS_PORT) || 8081;
let hlsServer = null;
const SEEK_LIVE_RESTART_TOLERANCE_SEC = Number(process.env.SEEK_LIVE_RESTART_TOLERANCE_SEC || 0.25);
const SOFT_SEEK_RELEASE_EPS = Number(process.env.SOFT_SEEK_RELEASE_EPS || 0.1);

const audioFrameTraceConfig = process.env.DEBUG_AUDIO_FRAMES;
const audioSegmentTraceConfig = process.env.DEBUG_AUDIO_SEGMENTS;
const debugOutputDir = path.resolve(process.cwd(), 'debug-output');

function resolveDebugCsvPath(configValue, defaultName) {
  if (!configValue) return null;
  const target = configValue === '1' ? defaultName : configValue;
  if (!target) return null;
  if (path.isAbsolute(target)) return target;
  return path.join(debugOutputDir, target);
}

const audioFrameTracePath = resolveDebugCsvPath(audioFrameTraceConfig, 'audio-frame-trace.csv');
const audioSegmentTracePath = resolveDebugCsvPath(audioSegmentTraceConfig, 'audio-segment-trace.csv');
const segmentTimelinePath = path.join(debugOutputDir, 'segment-timeline.csv');

const diag = Diagnostics.start({ entry: 'test.js' });

const consoleLogPath = path.resolve(process.cwd(), 'debug-console.log');
const consoleStream = fs.createWriteStream(consoleLogPath, { flags: 'w' });
const teeWriter = (originalWrite) => function patched(chunk, encoding, cb) {
  try {
    const data = typeof chunk === 'string' ? chunk : Buffer.from(chunk);
    consoleStream.write(data);
  } catch {}
  return originalWrite.call(this, chunk, encoding, cb);
};
process.stdout.write = teeWriter(process.stdout.write);
process.stderr.write = teeWriter(process.stderr.write);
process.on('exit', () => {
  try { consoleStream.end(); } catch {}
});

const seekController = new SeekController({
  diag,
  logger: log,
  performSeek: executeSeek
});

const CUE_LOOKUP_TIMEOUT_MS = Number(process.env.CUE_LOOKUP_TIMEOUT_MS || 1500);

async function teardownRemuxers(reason = 'unknown') {
  const tasks = [];
  if (videoRemuxer) {
    tasks.push(videoRemuxer.finalize().catch(err => {
      log(`video remuxer finalize error during ${reason}: ${err?.message || err}`);
    }));
  }
  for (const [trackId, remux] of audioRemuxers.entries()) {
    tasks.push(remux.finalize().catch(err => {
      logAudio(`audio remuxer finalize error track=${trackId} during ${reason}: ${err?.message || err}`);
    }));
  }
  audioRemuxers.clear();
  videoRemuxer = null;
  const waitPromise = tasks.length ? Promise.allSettled(tasks) : Promise.resolve();
  const timeout = new Promise(resolve => setTimeout(resolve, 500));
  await Promise.race([waitPromise, timeout]);
  audioSeqCounters.clear();
}

async function restartParserAt(targetSec, context = {}) {
  if (!currentParserFile) {
    await reacquireParserFile();
  }
  if (!currentParserFile) {
    diag.queue('timeline-reset', {
      action: 'parser-restart-skip',
      reason: context.reason,
      epochId: context.epochId,
      note: 'no-current-file'
    });
    throw new Error('No parser file available for restart');
  }

  const normalizedSec = Number.isFinite(targetSec) ? Math.max(0, targetSec) : 0;
  const targetMs = normalizedSec * 1000;
  let cueOffset = 0;
  let cueTimeMs = targetMs;

  const metadataSource = parserInstance?.metadata;
  if (metadataSource && typeof metadataSource.buildCueIndex === 'function') {
    diag.queue('timeline-reset', {
      action: 'cue-lookup-start',
      epochId: context.epochId,
      targetMs
    });
    try {
      const cue = await lookupCueWithTimeout(metadataSource, targetMs, CUE_LOOKUP_TIMEOUT_MS);
      if (cue?.offset != null && cue.offset >= 0) cueOffset = cue.offset;
      if (cue?.time != null) cueTimeMs = cue.time;
      diag.queue('timeline-reset', {
        action: 'cue-lookup-complete',
        epochId: context.epochId,
        cueOffset,
        cueTimeSec: cueTimeMs / 1000
      });
    } catch (err) {
      diag.error('cue-lookup', err);
      diag.queue('timeline-reset', {
        action: 'cue-lookup-failed',
        epochId: context.epochId,
        message: err?.message || String(err)
      });
      log(`Failed to lookup cue: ${err?.message || err}`);
    }
  }

  diag.queue('timeline-reset', {
    action: 'parser-restart-prepare',
    reason: context.reason,
    epochId: context.epochId,
    targetSec: normalizedSec,
    cueOffset,
    cueTimeSec: cueTimeMs / 1000
  });

  if (typeof currentParserFile.deselect === 'function') {
    try {
      currentParserFile.deselect();
    } catch (err) {
      diag.error('torrent-deselect', err);
      log(`file deselect failed: ${err?.message || err}`);
    }
  }

  if (typeof currentParserFile.select === 'function') {
    try {
      const fileLength = Number.isFinite(currentParserFile.length) ? currentParserFile.length : null;
      if (fileLength != null && fileLength > cueOffset) {
        currentParserFile.select(cueOffset, fileLength);
      } else {
        currentParserFile.select();
      }
    } catch (err) {
      diag.error('torrent-select', err);
      log(`file select failed: ${err?.message || err}`);
    }
  }

  if (activeParserStream?.destroy) {
    try { activeParserStream.destroy(); } catch (err) {
      log(`Error destroying prior parser stream: ${err?.message || err}`);
    }
  }
  activeParserStream = null;

  if (parserInstance) {
    parserInstance.destroy();
    parserInstance = null;
  }

  parserInstance = new SimpleParser(currentParserFile, parserEmitter);

  let stream;
  if (typeof currentParserFile.createReadStream === 'function') {
    try {
      stream = currentParserFile.createReadStream({ start: cueOffset });
    } catch (err) {
      diag.error('parser-stream', err);
      log(`createReadStream failed at offset ${cueOffset}: ${err?.message || err}`);
    }
  }
  if (!stream && typeof currentParserFile.slice === 'function') {
    try {
      stream = currentParserFile.slice(cueOffset).stream();
    } catch (err) {
      diag.error('parser-slice', err);
      log(`slice().stream() failed at offset ${cueOffset}: ${err?.message || err}`);
    }
  }
  if (!stream && typeof currentParserFile.createReadStream === 'function') {
    try {
      stream = currentParserFile.createReadStream();
      if (stream) {
        diag.queue('timeline-reset', {
          action: 'parser-restart-fallback',
          reason: context.reason,
          epochId: context.epochId,
          note: 'fallback-to-zero'
        });
      }
    } catch (err) {
      diag.error('parser-stream-fallback', err);
      log(`fallback createReadStream failed: ${err?.message || err}`);
    }
  }

  if (!stream) {
    throw new Error('Unable to create restart stream');
  }

  activeParserStream = stream;
  if (typeof stream.on === 'function') {
    stream.on('error', (streamErr) => {
      log(`Error on restarted parser stream: ${streamErr.message || streamErr}`);
      diag.error('parser-stream-runtime', streamErr?.message || streamErr);
      if (parserInstance) parserInstance.destroy();
      parserInstance = null;
    });
  }

  parserInstance.startParsingFromStream(stream);
  diag.queue('timeline-reset', {
    action: 'parser-restart',
    reason: context.reason,
    epochId: context.epochId,
    targetSec: normalizedSec,
    cueOffset
  });
}

async function startRemuxersForLayout(layout, opts = {}) {
  const { video, audio: audioTracks } = layout || {};
  if (!video) {
    log('No video track available; cannot start remuxers.');
    return;
  }

  const requireKeyframe = opts?.requireKeyframe === true || requireKeyframeOnNextStart;
  requireKeyframeOnNextStart = false;

  const epochForLayout = pendingEpochId != null ? pendingEpochId : currentEpochId;
  if (pendingEpochId != null) {
    currentEpochId = pendingEpochId;
    pendingEpochId = null;
  }

  currentTrackLayout = {
    video,
    audio: Array.isArray(audioTracks) ? audioTracks : []
  };

  const segStats = globalThis.__segStats || (globalThis.__segStats = {
    video: { count: 0, bytes: 0, last: 0 },
    audio: { count: 0, bytes: 0, last: 0 },
    timer: null
  });

  if (!segStats.timer) {
    const human = b => b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(2)}MB`;
    segStats.timer = setInterval(() => {
      const v = segStats.video; const a = segStats.audio;
      const line = `Segments — Video: ${v.count} (${human(v.bytes)}, last ${v.last}) | Audio: ${a.count} (${human(a.bytes)}, last ${a.last})`;
      try {
        const pad = (process.stdout.columns || 120) - line.length;
        const text = `${line}${pad > 0 ? ' '.repeat(pad) : ''}`;
        if (process.stdout.isTTY) {
          process.stdout.write(`\r${text}`);
        } else {
          process.stdout.write(`${text}\n`);
        }
      } catch {}
    }, 500);
  }

  const videoStreamId = `v-${video.id}`;
  const videoKey = trackKey(video.id);
  let videoSeq = videoSeqOverrides.has(videoKey)
    ? videoSeqOverrides.get(videoKey) ?? 0
    : segmentStore.getLastSeq(videoStreamId) ?? 0;
  videoSeqOverrides.delete(videoKey);
  const remuxEpochId = epochForLayout;

  videoRemuxer = new Fmp4Remuxer({
    onInitVideo: (mime, init) => {
      log(`Video init emitted: ${mime}, ${init.byteLength} bytes`);
      activeVideoStreamId = videoStreamId;
      try {
        fs.writeFileSync('debug-video-init.mp4', Buffer.from(init));
      } catch (err) {
        log(`Unable to write debug video init: ${err.message}`);
      }
      segmentStore.setInit(videoStreamId, mime, init, { epochId: epochForLayout });
      segmentStore.setMeta(videoStreamId, {
        id: video.id,
        type: 'video',
        codecs: video.codec,
        width: video.width,
        height: video.height,
        language: video.language || 'und'
      });
    },
    onVideoSegment: (pkt) => {
      if (remuxEpochId !== currentEpochId) {
        diag.queue('segment-drop', {
          stream: videoStreamId,
          reason: 'stale-epoch',
          segmentEpoch: remuxEpochId,
          currentEpoch: currentEpochId
        });
        return;
      }
      const seg = pkt?.data || pkt;
      const s = segStats.video; s.count++; s.bytes += seg.byteLength; s.last = seg.byteLength;
      const startSec = typeof pkt?.start === 'number'
        ? pkt.start
        : typeof pkt?.startUs === 'number'
          ? pkt.startUs / 1_000_000
          : typeof pkt?.pts === 'number'
            ? pkt.pts / 1_000_000
            : 0;
      if (videoSeq < 5) {
        log(`Video seg seq=${videoSeq + 1} start=${startSec.toFixed(6)} durationHint=${pkt?.duration ?? 'n/a'}`);
      }
      if (videoSeq === 0) {
        const head = Buffer.from(seg.subarray(0, 32)).toString('hex');
        log(`First video fragment head=${head}`);
        try {
          fs.writeFileSync('debug-first-video.m4s', Buffer.from(seg));
          log('Wrote debug-first-video.m4s');
        } catch (err) {
          log(`Unable to write debug fragment: ${err.message}`);
        }
      }
      const seq = ++videoSeq;
      segmentStore.addSegment(videoStreamId, seq, seg, startSec, undefined);
      recordSegmentTimeline('video', video.id, seq, startSec, undefined, seg.byteLength, pkt?.duration != null ? `pktDuration=${pkt.duration}` : '');
      diag.remux('video-segment', {
        track: video.id,
        seq,
        startSec,
        bytes: seg.byteLength
      });
      if (videoStreamId === activeVideoStreamId) {
        tryReleaseSoftAudioGate('remuxer', startSec);
      }
      if (awaitingVideoPostSeek === remuxEpochId) {
        awaitingVideoPostSeek = null;
        openAudioGate(`video-segment-ready-epoch-${remuxEpochId}`);
      }
    },
    minFragDurationSec: 0.8,
  });

  baseVideoPts.delete(video.id);
  lastVideoPtsMs.delete(video.id);

  const startPromises = [];
  log(`Video remuxer start: codec=${video.codec} descriptionBytes=${video.description?.byteLength || 0}`);
  startPromises.push(videoRemuxer.start({
    video: {
      id: video.id,
      codec: video.codec,
      description: video.description,
      width: video.width,
      height: video.height,
    },
    audio: undefined
  }));

  const audioTrackList = Array.isArray(audioTracks) ? audioTracks : [];

  for (const aTrack of audioTrackList) {
    const streamId = `a-${aTrack.id}`;
    activeAudioStreamIds.add(streamId);

    baseAudioPts.delete(aTrack.id);

    const audioKey = trackKey(aTrack.id);
    const startingAudioSeq = audioSeqOverrides.has(audioKey)
      ? audioSeqOverrides.get(audioKey) ?? 0
      : segmentStore.getLastSeq(streamId) ?? 0;
    audioSeqOverrides.delete(audioKey);

    const debugHook = (event, payload) => {
      if (event === 'push') {
        if (!audioFrameTracePath) return;
        const durationSource = payload?.durationInferred ? 'inferred' : 'demux';
        appendCsv(audioFrameTracePath, [
          aTrack.id,
          payload?.seq ?? '',
          payload?.pts ?? '',
          payload?.duration ?? '',
          durationSource,
          payload?.dataBytes ?? ''
        ]);
        return;
      }
      if (!audioSegmentTracePath) return;
      const extra = payload?.bytes ?? payload?.frameCount ?? '';
      let durationColumn = payload?.duration ?? '';
      if (event === 'segment' && Number.isFinite(payload?.duration)) {
        durationColumn = Math.round(payload.duration / 1000);
      }
      appendCsv(audioSegmentTracePath, [
        aTrack.id,
        event,
        payload?.seq ?? '',
        payload?.startUs ?? '',
        payload?.startSec ?? '',
        payload?.pts ?? '',
        durationColumn,
        extra
      ]);
    };

    const remux = new AudioRemuxer({
      debug: `remuxer:audio:${aTrack.id}`,
      minFragDurationSec: 0.8,
      onDebugEvent: debugHook,
      onInit: (_meta, init) => {
        const codecs = tracksMap.get(aTrack.id)?.codec || 'mp4a.40.2';
        segmentStore.setInit(streamId, `audio/mp4; codecs="${codecs}"`, init, { epochId: epochForLayout });
        segmentStore.setMeta(streamId, {
          id: aTrack.id,
          type: 'audio',
          codecs,
          channels: aTrack.channel_count,
          samplerate: aTrack.samplerate,
          language: aTrack.language || 'und',
          label: tracksMap.get(aTrack.id)?.name || `Audio ${aTrack.id}`
        });
        logAudio(`track=${aTrack.id} init bytes=${init.byteLength}`);
        if (audioSegmentTracePath) {
          appendCsv(audioSegmentTracePath, [aTrack.id, 'init', '', '', '', '', '', init.byteLength]);
        }
        try {
          fs.writeFileSync(`debug-audio-init-${aTrack.id}.mp4`, Buffer.from(init));
        } catch (err) {
          logAudio(`failed to write audio init: ${err.message}`);
        }
      },
      onSegment: (info, seg) => {
        if (remuxEpochId !== currentEpochId) {
          diag.queue('segment-drop', {
            stream: streamId,
            reason: 'stale-epoch',
            segmentEpoch: remuxEpochId,
            currentEpoch: currentEpochId
          });
          return;
        }
        const counterKey = trackKey(aTrack.id);
        let prevSeq = audioSeqCounters.get(counterKey);
        if (!Number.isFinite(prevSeq)) prevSeq = startingAudioSeq;
        const seq = prevSeq + 1;
        audioSeqCounters.set(counterKey, seq);
        const startSec = Number.isFinite(info?.start) ? info.start : 0;
        const durationSec = Number.isFinite(info?.duration)
          ? info.duration / 1_000_000
          : undefined;
        if (seq === 1) {
          try {
            fs.writeFileSync(`debug-audio-${aTrack.id}.m4s`, Buffer.from(seg));
            logAudio(`wrote debug-audio-${aTrack.id}.m4s`);
          } catch (err) {
            logAudio(`failed to write audio debug seg: ${err.message}`);
          }
        }
        segmentStore.addSegment(streamId, seq, seg, startSec, durationSec);
        recordSegmentTimeline('audio', aTrack.id, seq, startSec, durationSec, seg.byteLength, info?.source ?? '');
        diag.remux('audio-segment', {
          track: aTrack.id,
          seq,
          startSec,
          durationSec,
          bytes: seg.byteLength
        });
        const s = globalThis.__segStats.audio; s.count++; s.bytes += seg.byteLength; s.last = seg.byteLength;
        if (audioSegmentTracePath) {
          appendCsv(audioSegmentTracePath, [
            aTrack.id,
            'segment',
            seq,
            info?.startUs ?? '',
            startSec,
            Number.isFinite(startSec) ? Math.round(startSec * 1000) : '',
            Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : '',
            seg.byteLength
          ]);
        }
      }
    });

    audioRemuxers.set(aTrack.id, remux);
    audioSeqCounters.set(audioKey, startingAudioSeq);
    startPromises.push(remux.start({
      codec: tracksMap.get(aTrack.id)?.codec,
      description: tracksMap.get(aTrack.id)?.description,
      channel_count: aTrack.channel_count,
      samplerate: aTrack.samplerate
    }).catch(err => {
      log(`Error starting audio remuxer track ${aTrack.id}: ${err.message}`);
    }));
  }

  if (requireKeyframe) {
    videoKeyframeRequired.clear();
    videoKeyframeRequired.add(trackKey(video.id));
        diag.queue('timeline-reset', {
          action: 'await-keyframe',
          track: video.id,
          reason: opts?.reason,
          epochId: remuxEpochId
        });
        log(`Video track ${video.id} waiting for next keyframe before output (epoch ${remuxEpochId})`);
  }

  tracksReady = false;
  try {
    await Promise.all(startPromises);
    tracksReady = true;
    drainEarlyPackets();
  } catch (err) {
    log(`Error starting remuxers: ${err?.message || err}`);
  }
}

function flushGatedAudioQueue() {
  if (!audioGateOpen || gatedAudioQueue.length === 0) return;
  while (audioGateOpen && gatedAudioQueue.length) {
    const pkt = gatedAudioQueue.shift();
    handleAudio(pkt);
  }
}

function openAudioGate(reason = 'unknown') {
  if (audioGateOpen) {
    flushGatedAudioQueue();
    return;
  }
  audioGateOpen = true;
  diag.queue('audio-gate', { action: 'open', reason });
  logAudio(`audio gate opened (reason=${reason}) queue=${gatedAudioQueue.length}`);
  flushGatedAudioQueue();
}

function closeAudioGate(reason = 'unknown') {
  if (!audioGateOpen) return;
  audioGateOpen = false;
  diag.queue('audio-gate', { action: 'close', reason });
  logAudio(`audio gate closed (reason=${reason})`);
}

function startSoftAudioGate(targetSec, ctx = {}) {
  if (!Number.isFinite(targetSec)) return false;
  softAudioGate = {
    targetSec,
    reason: ctx.reason || 'soft-seek',
    source: ctx.source || 'unknown',
    startedAt: Date.now()
  };
  diag.queue('audio-soft-gate', {
    action: 'start',
    targetSec,
    reason: softAudioGate.reason,
    source: softAudioGate.source
  });
  closeAudioGate(softAudioGate.reason);
  return true;
}

function tryReleaseSoftAudioGate(releaseSource, segmentStartSec) {
  if (!softAudioGate) return;
  if (!Number.isFinite(segmentStartSec)) return;
  if (segmentStartSec + SOFT_SEEK_RELEASE_EPS < softAudioGate.targetSec) {
    return;
  }
  const released = { ...softAudioGate };
  softAudioGate = null;
  diag.queue('audio-soft-gate', {
    action: 'release',
    targetSec: released.targetSec,
    reason: released.reason,
    source: released.source,
    releaseSource
  });
  openAudioGate('soft-seek-video-ready');
}

function secondsFrom(value) {
  if (!Number.isFinite(value)) return null;
  return value < 0 ? 0 : value;
}

function secondsFromMs(value) {
  if (!Number.isFinite(value)) return null;
  const sec = value / 1000;
  return sec < 0 ? 0 : sec;
}

function resolveRequestedSec(details = {}) {
  const primaryCandidates = [
    details.requestedSec,
    details.requestedSeconds,
    details.requestedTime,
    details.requestedTimeSec,
    details.seekTime,
    details.seekTimeSec,
    details.targetTime,
    details.targetSec,
    details.time,
    details.timeSec,
    details.position,
    details.packet?.startSec
  ];
  for (const candidate of primaryCandidates) {
    const sec = secondsFrom(candidate);
    if (sec != null) return sec;
  }

  const secondaryCandidates = [
    details.requestedMs,
    details.requestedTimeMs,
    details.seekTimeMs,
    details.targetMs,
    details.timeMs,
    details.packet?.pts,
    details.packet?.dts,
    details.packet?.timeMs,
    details.packet?.start
  ];
  for (const candidate of secondaryCandidates) {
    const sec = secondsFromMs(candidate);
    if (sec != null) return sec;
  }

  return null;
}

function scheduleTimelineReset(reason = 'unknown', details = {}) {
  if (!currentTrackLayout?.video) {
    diag.queue('seek-state', { action: 'reject', reason, details, note: 'no-track-layout', time: Date.now() });
    log(`seek request ignored (${reason}); no video track active`);
    return;
  }
  const requestedSec = resolveRequestedSec(details);
  const target = Number.isFinite(requestedSec) ? requestedSec : 0;
  seekController.requestSeek(target, { reason, details });
}

async function executeSeek({ controller, request, epochId }) {
  const reason = request.meta?.reason || 'seek-reset';
  const details = request.meta?.details || {};
  const requestedSec = Number.isFinite(request.targetSec) ? request.targetSec : 0;

  controller.setState('tearing-down', { epochId, reason, requestedSec });
  diag.queue('timeline-reset', { action: 'start', epochId, reason, details, requestedSec });
  log(`>>> seek epoch=${epochId} (${reason}) target=${requestedSec}`);

  closeAudioGate(reason);
  softAudioGate = null;
  pendingEpochId = epochId;
  awaitingVideoPostSeek = epochId;
  tracksReady = false;
  requireKeyframeOnNextStart = true;
  videoKeyframeRequired.clear();

  baseVideoPts.clear();
  baseAudioPts.clear();
  lastVideoPtsMs.clear();
  gatedAudioQueue.length = 0;
  earlyPkts.audio.length = 0;
  earlyPkts.video.length = 0;
  if (details?.packet) {
    earlyPkts.video.push(details.packet);
  }

  const layoutVideo = currentTrackLayout?.video;
  if (layoutVideo && activeVideoStreamId) {
    const streamId = activeVideoStreamId;
    segmentStore.resetStream(streamId, { epochId });
    videoSeqOverrides.set(trackKey(layoutVideo.id), 0);
    diag.queue('timeline-reset', { action: 'stream-reset', streamId, epochId });
  }

  const layoutAudio = Array.isArray(currentTrackLayout?.audio) ? currentTrackLayout.audio : [];
  diag.queue('timeline-reset', { action: 'audio-track-count', count: layoutAudio.length, epochId });
  for (const aTrack of layoutAudio) {
    const streamId = `a-${aTrack.id}`;
    segmentStore.resetStream(streamId, { epochId });
    audioSeqOverrides.set(trackKey(aTrack.id), 0);
    diag.queue('timeline-reset', { action: 'stream-reset', streamId, epochId });
  }
  flushSegmentTimeline(`seek-epoch#${epochId}`);

  await teardownRemuxers(reason);
  diag.queue('timeline-reset', { action: 'teardown-complete', epochId, reason });

  controller.setState('restarting', { epochId, reason, requestedSec });
  try {
    await restartParserAt(requestedSec, { epochId, reason, requestedSec });
  } catch (err) {
    diag.error('parser-restart', err?.message || err);
    throw err;
  }
  diag.queue('timeline-reset', { action: 'parser-restarted', epochId, reason, requestedSec });

  controller.setState('awaiting-keyframe', { epochId, reason, requestedSec });
  diag.queue('timeline-reset', { action: 'await-keyframe', epochId, reason, requestedSec });
}

if (typeof globalThis !== 'undefined') {
  globalThis.__triggerTimelineReset = scheduleTimelineReset;
}

function ensureCsv(pathToFile, headerLine) {
  if (!pathToFile) return;
  try {
    const dir = path.dirname(pathToFile);
    if (dir && dir !== '.') {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(pathToFile, headerLine + '\n');
  } catch (err) {
    logAudio(`failed to init csv ${pathToFile}: ${err.message}`);
  }
}

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function appendCsv(pathToFile, columns) {
  if (!pathToFile) return;
  try {
    const line = columns.map(csvEscape).join(',') + '\n';
    fs.appendFileSync(pathToFile, line);
  } catch (err) {
    logAudio(`failed to append csv ${pathToFile}: ${err.message}`);
  }
}

async function lookupCueWithTimeout(metadataSource, targetMs, timeoutMs) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  const cuePromise = metadataSource.buildCueIndex().then(() => metadataSource.lookupCue(targetMs));
  if (!timeout) return cuePromise;
  return Promise.race([
    cuePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cue-lookup-timeout')), timeout))
  ]);
}

async function reacquireParserFile() {
  if (currentParserFile || !torrentInstance) return;
  const file = torrentInstance.files?.[0];
  if (file) {
    currentParserFile = file;
  }
}

ensureCsv(audioFrameTracePath, 'trackId,eventSeq,ptsMs,durationMs,durationSource,dataBytes');
ensureCsv(audioSegmentTracePath, 'trackId,event,seq,startUs,startSec,ptsMs,durationMs,extra');
ensureCsv(segmentTimelinePath, 'streamType,trackId,seq,startSec,endSec,durationSec,calcDurationSec,bytes,source,notes');

diag.append('config', {
  hlsMode,
  segmentWindow: segmentStore.windowSize,
  audioFrameTracePath,
  audioSegmentTracePath,
  segmentTimelinePath
});

if (audioFrameTracePath) {
  logAudio(`frame trace enabled -> ${audioFrameTracePath}`);
}
if (audioSegmentTracePath) {
  logAudio(`segment trace enabled -> ${audioSegmentTracePath}`);
}

const attrEscape = (str) => String(str ?? '').replace(/"/g, '');
const formatDuration = (seconds) => {
  const val = Number.isFinite(seconds) ? Math.max(seconds, 0) : 0;
  return (Math.round(val * 1000) / 1000).toFixed(3);
};

const pendingSegmentTimeline = new Map();

function finalizeSegmentEntry(key, entry, reason) {
  if (!entry) return;
  if (reason && !entry.notes) entry.notes = reason;
  const end = Number.isFinite(entry.durationSec)
    ? entry.startSec + entry.durationSec
    : Number.isFinite(entry.calcDurationSec)
      ? entry.startSec + entry.calcDurationSec
      : undefined;
  const line = [
    entry.streamType,
    entry.trackId,
    entry.seq,
    Number.isFinite(entry.startSec) ? entry.startSec.toFixed(6) : '',
    Number.isFinite(end) ? end.toFixed(6) : '',
    Number.isFinite(entry.durationSec) ? entry.durationSec.toFixed(6) : '',
    Number.isFinite(entry.calcDurationSec) ? entry.calcDurationSec.toFixed(6) : '',
    entry.bytes ?? '',
    entry.source ?? '',
    entry.notes ?? ''
  ];
  appendCsv(segmentTimelinePath, line);
  pendingSegmentTimeline.delete(key);
}

function recordSegmentTimeline(streamType, trackId, seq, startSec, durationSec, bytes, source) {
  const key = `${streamType}:${trackId}`;
  const prev = pendingSegmentTimeline.get(key);
  if (prev) {
    if (!Number.isFinite(prev.calcDurationSec) && Number.isFinite(startSec) && Number.isFinite(prev.startSec)) {
      const delta = startSec - prev.startSec;
      if (delta >= 0) prev.calcDurationSec = delta;
    }
    finalizeSegmentEntry(key, prev);
  }
  pendingSegmentTimeline.set(key, {
    streamType,
    trackId,
    seq,
    startSec,
    durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
    calcDurationSec: Number.isFinite(durationSec) ? durationSec : undefined,
    bytes,
    source,
    notes: ''
  });
}

function flushSegmentTimeline(reason) {
  for (const [key, entry] of Array.from(pendingSegmentTimeline.entries())) {
    finalizeSegmentEntry(key, entry, reason);
  }
}

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

  diag.hls('master', {
    audioStreams: audioStreams.length,
    videoStreams: videoStreams.length
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
    logHls(`playlist miss stream=${streamId} hasWindow=${!!window} hasInit=${segmentStore.hasInit(streamId)}`);
    respond(res, 404, 'No segments');
    return;
  }
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  if (window.playlistType) {
    lines.push(`#EXT-X-PLAYLIST-TYPE:${window.playlistType}`);
  }
  lines.push(`#EXT-X-TARGETDURATION:${window.targetDuration}`);
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${window.mediaSequence}`);
  if (Number.isInteger(window.discontinuitySequence) && window.discontinuitySequence > 0) {
    lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${window.discontinuitySequence}`);
  }
  lines.push(`#EXT-X-MAP:URI="/hls/init/${encodeURIComponent(streamId)}.mp4"`);
  for (const seg of window.segments) {
    if (seg.discontinuity) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    const dur = seg.duration != null ? seg.duration : window.targetDuration;
    lines.push(`#EXTINF:${formatDuration(dur)},`);
    lines.push(`/hls/seg/${encodeURIComponent(streamId)}/${seg.seq}.m4s`);
  }
  if (window.endList) lines.push('#EXT-X-ENDLIST');
  diag.hls('playlist', {
    streamId,
    mediaSequence: window.mediaSequence,
    targetDuration: window.targetDuration,
    segmentCount: window.segments.length,
    playlistType: window.playlistType,
    epochId: window.epochId
  });
  respond(res, 200, lines.join('\n') + '\n', 'application/vnd.apple.mpegurl');
  logHls(`playlist stream=${streamId} ms=${window.mediaSequence} count=${window.segments.length} epoch=${window.epochId}`);
}

function handleInit(res, streamId) {
  const init = segmentStore.getInit(streamId);
  if (!init) {
    logHls(`init miss stream=${streamId}`);
    respond(res, 404, 'Init not available');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(Buffer.from(init.data));
  logHls(`init stream=${streamId} bytes=${init.data.byteLength}`);
}

function handleSegment(res, streamId, seq) {
  const seg = segmentStore.getSegment(streamId, seq);
  if (!seg) {
    logHls(`segment miss stream=${streamId} seq=${seq}`);
    respond(res, 404, 'Segment not found');
    return;
  }
  if (streamId === activeVideoStreamId) {
    tryReleaseSoftAudioGate('http-segment', Number(seg.start));
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(Buffer.from(seg.data));
  logHls(`segment stream=${streamId} seq=${seq} bytes=${seg.data.byteLength}`);
}

function getCurrentVideoCoverageRange() {
  if (!activeVideoStreamId) return null;
  const window = segmentStore.getHlsWindow(activeVideoStreamId);
  if (!window || !Array.isArray(window.segments) || !window.segments.length) return null;
  const fallbackDuration = Number.isFinite(window.targetDuration) && window.targetDuration > 0
    ? window.targetDuration
    : 1;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const seg of window.segments) {
    if (!seg || !Number.isFinite(seg.start)) continue;
    const duration = Number.isFinite(seg.duration) && seg.duration > 0
      ? seg.duration
      : fallbackDuration;
    minStart = Math.min(minStart, seg.start);
    maxEnd = Math.max(maxEnd, seg.start + duration);
  }
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return null;
  return {
    startSec: minStart,
    endSec: maxEnd,
    segmentCount: window.segments.length
  };
}

function shouldTriggerLiveRestartForSeek(targetSec) {
  if (!Number.isFinite(targetSec)) {
    return { shouldRestart: true, coverage: null };
  }
  const coverage = getCurrentVideoCoverageRange();
  if (!coverage) {
    return { shouldRestart: true, coverage: null };
  }
  if (targetSec <= coverage.endSec + SEEK_LIVE_RESTART_TOLERANCE_SEC) {
    return { shouldRestart: false, coverage };
  }
  return { shouldRestart: true, coverage };
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
      if (pathname === '/control/seek-reset') {
        const reason = urlObj.searchParams.get('reason') || 'http-control';
        const requestedTime = Number(urlObj.searchParams.get('time'));
        const requestedTimeSec = Number.isFinite(requestedTime) ? requestedTime : undefined;
        const outOfBufferFlag = urlObj.searchParams.get('outOfBuffer') === '1';
        diag.queue('timeline-reset', {
          action: 'http-request',
          reason,
          source: 'http-control',
          requestedTime: requestedTimeSec,
          outOfBuffer: outOfBufferFlag
        });
        diag.queue('timeline-reset-request', {
          source: 'http-control',
          reason,
          requestedTime: requestedTimeSec,
          outOfBuffer: outOfBufferFlag
        });

        const evalResult = shouldTriggerLiveRestartForSeek(requestedTimeSec);
        const beyondTail = evalResult.shouldRestart;
        if (!beyondTail && !outOfBufferFlag) {
          diag.queue('timeline-reset', {
            action: 'skip-http-reset',
            reason,
            source: 'http-control',
            requestedTime: requestedTimeSec,
            coverageEnd: evalResult.coverage?.endSec,
            coverageSegments: evalResult.coverage?.segmentCount
          });
          respond(
            res,
            200,
            JSON.stringify({ ok: true, reason, skipped: true, note: 'within-buffer' }),
            'application/json'
          );
          return;
        }

        const canSoftGate = outOfBufferFlag && !beyondTail && Number.isFinite(requestedTimeSec);
        if (canSoftGate) {
          const started = startSoftAudioGate(requestedTimeSec, { reason: `${reason}-soft-seek`, source: 'http-control' });
          if (started) {
            respond(
              res,
              200,
              JSON.stringify({ ok: true, reason, softGate: true, targetSec: requestedTimeSec }),
              'application/json'
            );
            return;
          }
        }

        scheduleTimelineReset(reason, {
          source: 'http-control',
          requestedTime: requestedTimeSec,
          outOfBuffer: outOfBufferFlag
        });
        respond(res, 200, JSON.stringify({ ok: true, reason, restarted: true, outOfBuffer: outOfBufferFlag }), 'application/json');
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

const magnetURI = 'magnet:?xt=urn:btih:EB4EAIUOCL2CNDPUYPMGWTE42YPOJAZF&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&dn=Solo%20Leveling%20S02E02%20I%20Suppose%20You%20Arent%20Aware%201080p%20CR%20WEB-DL%20AAC2.0%20H%20264-VARYG%20%28Ore%20dake%20Level%20Up%20na%20Ken%2C%20Multi-Subs%29';
const targetFileIndex = 0;


const parserEmitter = new EventEmitter();

parserEmitter.on('subtitle-cue', ({ trackNumber, subtitle }) => {
    // Log the first few subtitle events clearly
    // log(`***** SUBTITLE RECEIVED ***** Track: ${trackNumber}, Time: ${subtitle.time}, Duration: ${subtitle.duration}, Text: ${subtitle.text}`);
});

parserEmitter.on('timeline-reset-request', (info = {}) => {
    const reason = info?.reason || 'demux-event';
    diag.queue('timeline-reset-request', {
        source: 'parser-event',
        reason,
        requestedTime: info?.requestedTime,
        details: info
    });
    scheduleTimelineReset(reason, { ...info, source: 'parser-event' });
});

let seenAudio = 0, seenVideo = 0; 
// Add other listeners as before...
parserEmitter.on('tracks', async (tracks) => {
    log('--- Tracks Detected ---');
    const toAscii = s => String(s ?? '').replace(/[^\x20-\x7E]/g, '');
    const nsToMs = (ns) => Number.isFinite(ns) ? ns / 1_000_000 : 0;

    baseVideoPts.clear();
    baseAudioPts.clear();
    audioTrackDelay.clear();
    tracksMap.clear();
    nalLenMap.clear();

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
            options.codecDelayMs = nsToMs(t.codecDelay);
            options.seekPreRollMs = nsToMs(t.seekPreRoll);
            if (!mapped.description || mapped.description.byteLength === 0) {
                log(`  Warning: video track ${t.number} missing codec description`);
            } else {
                log(`  Video codec description bytes=${mapped.description.byteLength}`);
            }
            if (mapped.nalUnitLength) nalLenMap.set(t.number, mapped.nalUnitLength);
            const label = t.codec === 'V_MPEG4/ISO/AVC' ? 'AVC Coding' : t.codec === 'V_MPEGH/ISO/HEVC' ? 'HEVC Coding' : (t.name || 'Video');
            options.name = toAscii(label);
            options.compressorname = options.name.length > 31 ? options.name.slice(0, 31) : options.name;
            tracksMap.set(options.id, { ...options, annexB: Boolean(mapped.annexB) });
            log(`  Track ${t.number}: Type=${t.type}, Codec=${mapped.codec}, Lang=${t.language}, Name=${t.name}, Width=${t.width}, Height=${t.height}`);
            if (Number.isFinite(t.codecDelay) || Number.isFinite(t.seekPreRoll)) {
                log(`    codecDelay=${t.codecDelay}ns (${options.codecDelayMs.toFixed(3)} ms) seekPreRoll=${t.seekPreRoll}ns (${options.seekPreRollMs.toFixed(3)} ms)`);
            }
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
            options.codecDelayMs = nsToMs(t.codecDelay);
            options.seekPreRollMs = nsToMs(t.seekPreRoll);
            const label = t.name || `Audio ${t.number}`;
            options.name = toAscii(label);
            options.compressorname = options.name.length > 31 ? options.name.slice(0, 31) : options.name;
            tracksMap.set(options.id, options);
            log(`  Track ${t.number}: Type=${t.type}, Codec=${mapped.codec}, Lang=${t.language}, Name=${t.name}, SamplingFrequency=${t.samplingFrequency}, Channels=${t.channels}`);
            if (Number.isFinite(t.codecDelay) || Number.isFinite(t.seekPreRoll)) {
                log(`    codecDelay=${t.codecDelay}ns (${options.codecDelayMs.toFixed(3)} ms) seekPreRoll=${t.seekPreRoll}ns (${options.seekPreRollMs.toFixed(3)} ms)`);
            }
            audioTrackDelay.set(options.id, options.codecDelayMs + options.seekPreRollMs);
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
        await startRemuxersForLayout({ video, audio: audioTracks }, { reason: 'tracks' });
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
    const trackMeta = tracksMap.get(trackNumber) || {};
    const codec = trackMeta.codec || '';
    const codecLower = codec.toLowerCase();
    const sampleRate = trackMeta.samplerate || trackMeta.sample_rate || trackMeta.samplingFrequency || 44100;
    const remux = audioRemuxers.get(trackNumber);
    if (!remux) {
        if (seenAudio <= 12) logAudio(`track=${trackNumber} no remuxer; dropping`);
        return;
    }

    const rawFrame = data;

    if (++seenAudio === 1) {
        const originalHead = Buffer.from(data.subarray(0, 16)).toString('hex');
        logAudio(`first audio sample track=${trackNumber} pts=${pts} dur=${duration} bytes=${data.length}`);
        logAudio(`sample head raw=${originalHead}`);
    }

    let frameDuration = Number.isFinite(duration) ? duration : undefined;
    if (!Number.isFinite(frameDuration)) {
        if (codecLower.startsWith('mp4a.') && Number.isFinite(sampleRate) && sampleRate > 0) {
            frameDuration = (1024 * 1000) / sampleRate;
        } else if (codecLower.startsWith('mp3') && Number.isFinite(sampleRate) && sampleRate > 0) {
            frameDuration = (1152 * 1000) / sampleRate;
        }
    }
    if (!Number.isFinite(frameDuration)) frameDuration = 0;

    const delayMs = audioTrackDelay.get(trackNumber) ?? ((trackMeta.codecDelayMs ?? 0) + (trackMeta.seekPreRollMs ?? 0));
    const adjustedPts = Number.isFinite(pts) ? pts - delayMs : pts;

    let base = baseAudioPts.get(trackNumber);
    if (base == null) {
        base = Number.isFinite(adjustedPts) ? adjustedPts : 0;
        baseAudioPts.set(trackNumber, base);
    }
    const normPts = Number.isFinite(adjustedPts) ? adjustedPts - base : 0;

    diag.demux('audio', {
        track: trackNumber,
        ptsMs: pts,
        adjustedPtsMs: adjustedPts,
        normPtsMs: normPts,
        durationMs: frameDuration
    });

    if (audioFrameTracePath) {
        appendCsv(audioFrameTracePath, [
            trackNumber,
            0,
            Math.round(normPts) ?? '',
            frameDuration ?? '',
            codecLower.startsWith('mp4a.') ? 'aac' : codecLower,
            rawFrame.byteLength
        ]);
    }

    if (seenAudio <= 3) {
        logAudio(`track=${trackNumber} rawPts=${pts} delay=${delayMs} adjusted=${adjustedPts} base=${base} norm=${normPts}`);
    }

    if (debugAudioDumpLimit && debugAudioPacketCounter < debugAudioDumpLimit) {
        const dumpDir = path.resolve(process.cwd(), 'debug-audio-frames');
        if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
        const rawPath = path.join(dumpDir, `packet${debugAudioPacketCounter}-raw.bin`);
        fs.writeFileSync(rawPath, data);
        debugAudioPacketCounter++;
    }

    remux.push({ pts: normPts, duration: frameDuration, data: rawFrame })
        .then(() => {
            diag.remux('audio-frame', {
                track: trackNumber,
                ptsMs: normPts,
                durationMs: frameDuration
            });
        })
        .catch(err => {
            logAudio(`track=${trackNumber} push error ${err.message}`);
            diag.error('audio-remux-push', err.message || err);
        });
}

parserEmitter.on('audio-packet', (pkt) => {
    
    if (!tracksReady) { earlyPkts.audio.push(pkt); return; }
    if (!audioGateOpen) {
        gatedAudioQueue.push(pkt);
        return;
    }
    handleAudio(pkt);

})


function handleVideo({ trackNumber, pts, isKeyframe, data, duration }) {
    const trackInfo = tracksMap.get(trackNumber);
    const nalLen = nalLenMap.get(trackNumber) || 4;
    const looksLikeAnnexB = data?.length > 4 && data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1;
    const needsConversion = trackInfo?.annexB || looksLikeAnnexB;
    const payload = needsConversion ? annexBtoLengthPrefixed(data, nalLen) : data;

    let base = baseVideoPts.get(trackNumber);
    const delayMs = (trackInfo?.codecDelayMs ?? 0) + (trackInfo?.seekPreRollMs ?? 0);
    const adjustedPts = Number.isFinite(pts) ? pts - delayMs : pts;

    const trackKeyId = trackKey(trackNumber);
    const lastAdj = lastVideoPtsMs.get(trackNumber);
    if (Number.isFinite(adjustedPts) && Number.isFinite(lastAdj)) {
        const delta = adjustedPts - lastAdj;
        if (delta < -500) { // backwards by >0.5s => treat as seek/discontinuity
            scheduleTimelineReset('video-pts-backtrack', { trackNumber, packet: { trackNumber, pts, isKeyframe, data, duration } });
            return;
        }
    }

    if (base == null) {
        base = Number.isFinite(adjustedPts) ? adjustedPts : 0;
        baseVideoPts.set(trackNumber, base);
    }
    const normPts = Number.isFinite(adjustedPts) ? adjustedPts - base : 0;

    diag.demux('video', {
        track: trackNumber,
        ptsMs: pts,
        adjustedPtsMs: adjustedPts,
        normPtsMs: normPts,
        durationMs: duration,
        isKeyframe
    });

    /* if (++seenVideo <= 10) {
        log(`VIDEO PCKT track=${trackNumber} pts(ms)=${pts} key=${isKeyframe?'Y':'n'} duration(ms)=${duration} size=${data.length}`);
    } */

    if (++seenVideo <= 5) {
        log(`VIDEO PTS track=${trackNumber} raw=${pts} delay=${delayMs} adjusted=${adjustedPts} base=${base} norm=${normPts}`);
    }

    if (videoKeyframeRequired.has(trackKeyId)) {
        if (!isKeyframe) {
            diag.queue('video-gate', { action: 'drop-non-keyframe', track: trackNumber, pts: pts, reason: 'await-keyframe' });
            if (log.enabled) log(`VIDEO gate drop non-keyframe track=${trackNumber} pts=${pts}`);
            return;
        }
        videoKeyframeRequired.delete(trackKeyId);
        diag.queue('video-gate', { action: 'keyframe-resume', track: trackNumber, pts: pts });
        log(`Video gate satisfied with keyframe track=${trackNumber} pts=${pts}`);
        if (seekController.isAwaitingKeyframe() && seekController.getActiveEpoch() === currentEpochId) {
            seekController.setState('committed', { epochId: currentEpochId, pts: normPts, rawPts: pts });
            diag.queue('timeline-reset', { action: 'complete', epochId: currentEpochId, pts: normPts, reason: 'keyframe' });
            seekController.complete({ epochId: currentEpochId, pts: normPts });
        }
    }

    if (videoRemuxer) {
        videoRemuxer.pushVideo({ pts: normPts, duration, isKeyframe, data: payload });
    }

    if (Number.isFinite(adjustedPts)) {
        lastVideoPtsMs.set(trackNumber, adjustedPts);
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
        flushSegmentTimeline('parsing-finished');
        diag.summary({
            event: 'parsing-finished',
            videoSegments: globalThis.__segStats?.video?.count ?? null,
            audioSegments: globalThis.__segStats?.audio?.count ?? null
        });
        if (videoRemuxer) await videoRemuxer.finalize();
        await Promise.allSettled(Array.from(audioRemuxers.values()).map(r => r.finalize()));
        audioRemuxers.clear();
        if (activeVideoStreamId) segmentStore.end(activeVideoStreamId);
        activeAudioStreamIds.forEach(id => segmentStore.end(id));
    } finally {
        log('Parser is done. HLS server will remain available for playback—press Ctrl+C to exit.');
    }
})

client.on('error', (err) => {
    log(`WebTorrent Client Error: ${err.message || err}`);
    diag.error('webtorrent-client', err);
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
        currentParserFile = file;

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
            activeParserStream = stream;
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
    if (activeParserStream?.destroy) {
        try { activeParserStream.destroy(); } catch {}
    }
    activeParserStream = null;
    currentParserFile = null;
    if (videoRemuxer) {
        videoRemuxer.finalize().catch(()=>{});
        videoRemuxer = null;
    }
   audioRemuxers.forEach(r => r.finalize().catch(()=>{}));
   audioRemuxers.clear();
    flushSegmentTimeline('cleanup');
    diag.summary({ event: 'cleanup' });
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
            const buffer = Buffer.from(codecPrivate);  
            
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
// Audio frames currently flow directly to the remuxer; ADTS wrapping can be
// added on-demand if future muxers require it.
