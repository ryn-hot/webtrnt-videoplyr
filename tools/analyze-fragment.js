#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function usage() {
  console.log('Usage: node tools/analyze-fragment.js <fragment.m4s>');
}

const target = process.argv[2] || 'debug-audio-2.m4s';
if (!fs.existsSync(target)) {
  console.error(`File not found: ${target}`);
  usage();
  process.exit(1);
}

const buf = fs.readFileSync(target);
let totalMdatSize = 0;

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function dumpBoxes(buffer, start = 0, end = buffer.length, depth = 0) {
  let offset = start;
  const indent = '  '.repeat(depth);
  while (offset + 8 <= end) {
    const size = readUInt32(buffer, offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (size === 0) {
      console.log(`${indent}${type} size=0 (extends to end)`);
      break;
    }
    const boxEnd = offset + size;
    console.log(`${indent}${type} size=${size}`);
    if (type === 'mdat') {
      totalMdatSize += size;
    }
    if (['moof', 'traf', 'trak', 'mdia', 'minf', 'stbl', 'mvex'].includes(type)) {
      dumpBoxes(buffer, offset + 8, boxEnd, depth + 1);
    } else if (type === 'trun') {
      dumpTrun(buffer.slice(offset, boxEnd), depth + 1);
    }
    offset = boxEnd;
  }
}

function dumpTrun(trunBuf, depth) {
  const indent = '  '.repeat(depth);
  const version = trunBuf[8];
  const flags = (trunBuf[9] << 16) | (trunBuf[10] << 8) | trunBuf[11];
  const sampleCount = readUInt32(trunBuf, 12);
  let cursor = 16;
  let dataOffset = null;
  let firstSampleFlags = null;
  if (flags & 0x1) { dataOffset = readUInt32(trunBuf, cursor); cursor += 4; }
  if (flags & 0x4) { firstSampleFlags = readUInt32(trunBuf, cursor); cursor += 4; }
  const samples = [];
  let totalSize = 0;
  for (let i = 0; i < sampleCount; i++) {
    const entry = { index: i };
    if (flags & 0x100) { entry.duration = readUInt32(trunBuf, cursor); cursor += 4; }
    if (flags & 0x200) { entry.size = readUInt32(trunBuf, cursor); cursor += 4; }
    if (flags & 0x400) { entry.flags = readUInt32(trunBuf, cursor); cursor += 4; }
    if (flags & 0x800) { entry.compositionOffset = readUInt32(trunBuf, cursor); cursor += 4; }
    if (entry.size != null) totalSize += entry.size;
    samples.push(entry);
  }
  console.log(`${indent}trun version=${version} flags=0x${flags.toString(16)} samples=${sampleCount}`);
  if (dataOffset != null) console.log(`${indent}  dataOffset=${dataOffset}`);
  if (firstSampleFlags != null) console.log(`${indent}  firstSampleFlags=0x${firstSampleFlags.toString(16)}`);
  if (totalSize) console.log(`${indent}  totalSampleSize=${totalSize}`);
  const preview = samples.slice(0, Math.min(samples.length, 10));
  for (const sample of preview) {
    console.log(`${indent}  sample#${sample.index} duration=${sample.duration ?? 'n/a'} size=${sample.size ?? 'n/a'} flags=${sample.flags != null ? '0x' + sample.flags.toString(16) : 'n/a'}`);
  }
  if (samples.length > preview.length) {
    console.log(`${indent}  ... ${samples.length - preview.length} more samples`);
  }
}

console.log(`Analyzing fragment: ${path.resolve(target)}`);
dumpBoxes(buf);
if (totalMdatSize) {
  console.log(`Total mdat size: ${totalMdatSize}`);
}
