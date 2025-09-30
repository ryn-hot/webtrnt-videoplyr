#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import WebTorrent from 'webtorrent';

function usage() {
  console.log(`Usage: node tools/debug-aac-workflow.js [--magnet <uri>] [--index <fileIndex>] [--audio-track <spec>] [--output <file>] [--mkv <path>]\n
Defaults:\n  --magnet    Solo Leveling S02E02 magnet (same as test.js)\n  --index     0 (first file in torrent)\n  --audio-track 0:a:0 (first audio track)\n  --output   debug-audio-comparison.txt\n  --mkv      (download via WebTorrent into a temp dir unless provided)`);
}

const DEFAULT_MAGNET = 'magnet:?xt=urn:btih:EB4EAIUOCL2CNDPUYPMGWTE42YPOJAZF&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&dn=Solo%20Leveling%20S02E02%20I%20Suppose%20You%20Arent%20Aware%201080p%20CR%20WEB-DL%20AAC2.0%20H%20264-VARYG%20%28Ore%20dake%20Level%20Up%20na%20Ken%2C%20Multi-Subs%29';

const args = process.argv.slice(2);
let magnet = DEFAULT_MAGNET;
let fileIndex = 0;
let outputPath = 'debug-audio-comparison.txt';
let audioMap = '0:a:0';
let providedMkv = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case '--magnet': magnet = args[++i]; break;
    case '--index': fileIndex = Number(args[++i]); break;
    case '--output': outputPath = args[++i]; break;
    case '--audio-track': audioMap = args[++i]; break;
    case '--mkv': providedMkv = args[++i]; break;
    case '--help':
    case '-h': usage(); process.exit(0);
    default:
      console.error(`Unknown argument: ${arg}`);
      usage();
      process.exit(1);
  }
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'pipe', ...opts });
  return { status: res.status, stdout: res.stdout?.toString() ?? '', stderr: res.stderr?.toString() ?? '' };
}

function hexPreview(buffer, limit = 32) {
  return buffer.slice(0, limit).toString('hex');
}

async function downloadMkv() {
  if (providedMkv) {
    return path.resolve(providedMkv);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkv-aac-debug-'));
  const client = new WebTorrent();
  console.log(`[debug] Downloading torrent to ${tmpDir}`);
  const targetPath = await new Promise((resolve, reject) => {
    client.add(magnet, { path: tmpDir }, torrent => {
      const file = torrent.files[fileIndex];
      if (!file) {
        reject(new Error(`File index ${fileIndex} not found in torrent`));
        return;
      }
      console.log(`[debug] Selected file: ${file.path}`);
      file.select();
      torrent.on('done', () => {
        const fullPath = path.join(tmpDir, file.path);
        console.log(`[debug] Download complete: ${fullPath}`);
        resolve(fullPath);
      });
      torrent.on('error', reject);
    });
  }).finally(() => {
    client.destroy();
  });
  return targetPath;
}

function ensureDebugFrames() {
  const framesDir = path.resolve('debug-audio-frames');
  if (!fs.existsSync(framesDir)) {
    throw new Error(`Directory ${framesDir} not found. Run DEBUG_AUDIO_DUMP=1 node test.js first.`);
  }
  const frames = fs.readdirSync(framesDir)
    .filter(name => name.endsWith('-clean.aac'))
    .sort();
  if (frames.length === 0) {
    throw new Error(`No *-clean.aac files found in ${framesDir}. Run DEBUG_AUDIO_DUMP=1 node test.js first.`);
  }
  return frames.map(name => path.join(framesDir, name));
}

function testDecode(aacPath) {
  const res = run('ffmpeg', ['-v', 'error', '-hide_banner', '-i', aacPath, '-frames:a', '1', '-f', 'null', '-']);
  return res.status === 0 ? { ok: true, stderr: res.stderr } : { ok: false, stderr: res.stderr }; 
}

(async () => {
  try {
    const log = [];
    const mkvPath = await downloadMkv();
    log.push(`# Source MKV\n${mkvPath}`);

    const referenceAac = path.resolve('reference-track.aac');
    console.log('[debug] Extracting audio track with ffmpeg...');
    const ff = run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mkvPath, '-map', audioMap, '-c', 'copy', referenceAac]);
    if (ff.status !== 0) {
      throw new Error(`ffmpeg failed extracting audio track:\n${ff.stderr}`);
    }
    const refBuf = fs.readFileSync(referenceAac);
    log.push(`\n# Extracted reference AAC\nPath: ${referenceAac}\nSize: ${refBuf.length} bytes\nFirst 32 bytes: ${hexPreview(refBuf, 32)}`);

    const frames = ensureDebugFrames();
    log.push(`\n# Debug frames (${frames.length})\n`);

    frames.forEach(framePath => {
      const frameBuf = fs.readFileSync(framePath);
      const decodeResult = testDecode(framePath);
      log.push(`* ${framePath}\n  Size: ${frameBuf.length} bytes\n  Hex[0..31]: ${hexPreview(frameBuf, 32)}\n  ffmpeg decode: ${decodeResult.ok ? 'OK' : 'FAIL'}${decodeResult.stderr ? `\n  stderr: ${decodeResult.stderr.trim()}` : ''}`);
    });

    // Compare first debug frame to first bytes of reference
    const firstFrame = frames[0];
    const refSegment = refBuf.slice(0, fs.readFileSync(firstFrame).length);
    const frameBuf = fs.readFileSync(firstFrame);
    const diff = [];
    const len = Math.min(refSegment.length, frameBuf.length);
    for (let i = 0; i < len; i++) {
      if (refSegment[i] !== frameBuf[i]) {
        diff.push({ offset: i, reference: refSegment[i], sample: frameBuf[i] });
        if (diff.length >= 16) break;
      }
    }
    log.push('\n# Comparison with reference');
    log.push(`Reference first ${len} bytes vs ${firstFrame}`);
    if (diff.length === 0) {
      log.push('No byte differences found in the compared window.');
    } else {
      log.push('First byte mismatches (offset: reference -> sample):');
      diff.forEach(entry => {
        log.push(`  ${entry.offset}: ${entry.reference.toString(16).padStart(2, '0')} -> ${entry.sample.toString(16).padStart(2, '0')}`);
      });
    }

    fs.writeFileSync(outputPath, log.join('\n') + '\n', 'utf8');
    console.log(`[debug] Wrote report to ${outputPath}`);
  } catch (err) {
    console.error(err.stack || err);
    process.exit(1);
  }
})();
