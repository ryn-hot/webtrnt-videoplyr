#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function usage() {
  console.log('Usage: node tools/test-aac-frame.js <raw-aac-frame> [--sample-rate=44100] [--channels=2] [--profile=2]');
  console.log('Writes <frame>-adts.aac and runs ffmpeg decode test.');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { sampleRate: 44100, channels: 2, profile: 2 };
  let file = null;
  for (const arg of args) {
    if (arg.startsWith('--sample-rate=')) opts.sampleRate = Number(arg.split('=')[1]);
    else if (arg.startsWith('--channels=')) opts.channels = Number(arg.split('=')[1]);
    else if (arg.startsWith('--profile=')) opts.profile = Number(arg.split('=')[1]);
    else if (!file) file = arg;
    else {
      console.error('Unexpected arg', arg);
      usage();
      process.exit(1);
    }
  }
  if (!file) {
    usage();
    process.exit(1);
  }
  return { file, opts };
}

function samplingFreqIndex(sr) {
  const freqs = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const idx = freqs.indexOf(sr);
  if (idx === -1) throw new Error(`Unsupported sample rate ${sr}`);
  return idx;
}

function createAdtsHeader(frameLength, opts) {
  const { sampleRate, channels, profile } = opts;
  const freqIdx = samplingFreqIndex(sampleRate);
  const chanCfg = channels;
  const adtsLen = frameLength + 7;
  const header = Buffer.alloc(7);
  header[0] = 0xff;
  header[1] = 0xf1; // 1111 0001, MPEG-4, layer 00, protection absent
  header[2] = ((profile - 1) << 6) | (freqIdx << 2) | ((chanCfg >> 2) & 0x1);
  header[3] = ((chanCfg & 0x3) << 6) | ((adtsLen >> 11) & 0x3);
  header[4] = (adtsLen >> 3) & 0xff;
  header[5] = ((adtsLen & 0x7) << 5) | 0x1f;
  header[6] = 0xfc;
  return header;
}

function main() {
  const { file, opts } = parseArgs();
  const raw = fs.readFileSync(file);
  if (raw.length < 8) {
    console.error('Frame is too small to be valid AAC (length < 8 bytes)');
    process.exit(1);
  }
  const header = createAdtsHeader(raw.length, opts);
  const outPath = `${file.replace(/\.[^/.]+$/, '')}-adts.aac`;
  fs.writeFileSync(outPath, Buffer.concat([header, raw]));
  console.log(`Wrote ${outPath} (${raw.length} + 7 bytes)`);
  let ffmpeg = spawnSync('ffmpeg', ['-v', 'error', '-hide_banner', '-i', outPath, '-f', 'null', '-'], { stdio: 'inherit' });
  if (ffmpeg.status !== 0) {
    console.warn('ffmpeg autodetect failed, retrying with -f adts');
    ffmpeg = spawnSync('ffmpeg', ['-v', 'error', '-hide_banner', '-f', 'adts', '-i', outPath, '-f', 'null', '-'], { stdio: 'inherit' });
  }
  if (ffmpeg.status === 0) {
    console.log('ffmpeg decode succeeded');
  } else {
    console.error(`ffmpeg decode failed with code ${ffmpeg.status}`);
  }
}

try {
  main();
} catch (err) {
  console.error(err.stack || err);
  process.exit(1);
}
