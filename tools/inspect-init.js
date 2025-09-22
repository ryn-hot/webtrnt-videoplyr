#!/usr/bin/env node
// Simple inspector for fMP4 init and first media segments.
// Prints mvhd/mdhd timescales and first tfdt (base decode time) if present.

import fs from 'fs';
import path from 'path';

function toHex(n, w=8) { return '0x' + n.toString(16).padStart(w,'0'); }

function readU32(u8, off) { return (u8[off]<<24)|(u8[off+1]<<16)|(u8[off+2]<<8)|u8[off+3]; }
function readU64(u8, off) { const hi=readU32(u8,off)>>>0, lo=readU32(u8,off+4)>>>0; return (BigInt(hi)<<32n)|BigInt(lo); }

function eachBox(u8, start=0, end=u8.byteLength, cb) {
  let off = start;
  while (off + 8 <= end) {
    const size = readU32(u8, off) >>> 0;
    const type = String.fromCharCode(u8[off+4],u8[off+5],u8[off+6],u8[off+7]);
    let hdr = 8, largesize = 0n;
    if (size === 1) { largesize = readU64(u8, off+8); hdr = 16; }
    const boxStart = off + hdr;
    const boxSize = size === 0 ? (end-off) : (size === 1 ? Number(largesize) : size);
    const boxEnd = off + boxSize;
    cb(type, off, boxStart, boxEnd);
    off = boxEnd;
  }
}

function parseInit(u8) {
  const out = { mvhdTimescale: null, tracks: [] };
  let moovStart=0, moovEnd=u8.byteLength;
  eachBox(u8, 0, u8.byteLength, (type, off, boxStart, boxEnd)=>{
    if (type==='moov') { moovStart=boxStart; moovEnd=boxEnd; }
  });
  eachBox(u8, moovStart, moovEnd, (type, off, boxStart, boxEnd)=>{
    if (type==='mvhd') {
      const version = u8[boxStart];
      const timescaleOff = version===1 ? boxStart+20 : boxStart+12;
      out.mvhdTimescale = readU32(u8, timescaleOff)>>>0;
    } else if (type==='trak') {
      let hdlrType='????', mdhdTimescale=null;
      let mdiaStart=boxStart, mdiaEnd=boxEnd;
      eachBox(u8, boxStart, boxEnd, (t2, o2, s2, e2)=>{ if (t2==='mdia') { mdiaStart=s2; mdiaEnd=e2; } });
      eachBox(u8, mdiaStart, mdiaEnd, (t3, o3, s3, e3)=>{
        if (t3==='hdlr') { hdlrType = String.fromCharCode(u8[s3+8],u8[s3+9],u8[s3+10],u8[s3+11]); }
        if (t3==='mdhd') { const ver=u8[s3]; const off2 = ver===1? s3+20 : s3+12; mdhdTimescale = readU32(u8, off2)>>>0; }
      });
      out.tracks.push({ handler: hdlrType, mdhdTimescale });
    }
  });
  return out;
}

function parseTfdt(u8) {
  let moofStart=0, moofEnd=u8.byteLength;
  eachBox(u8, 0, u8.byteLength, (type, off, boxStart, boxEnd)=>{
    if (type==='moof') { moofStart=boxStart; moofEnd=boxEnd; }
  });
  let bmdt=null;
  eachBox(u8, moofStart, moofEnd, (t1, o1, s1, e1)=>{
    if (t1==='traf') {
      eachBox(u8, s1, e1, (t2, o2, s2, e2)=>{
        if (t2==='tfdt') {
          const ver = u8[s2];
          bmdt = ver===1 ? Number(readU64(u8, s2+4)) : readU32(u8, s2+4)>>>0;
        }
      });
    }
  });
  return bmdt;
}

function loadU8(p) { return new Uint8Array(fs.readFileSync(p).buffer); }

function run(indexPath) {
  const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const dir = path.dirname(indexPath);
  const vInitPath = path.join(dir, 'video-init.mp4');
  const aInitPath = path.join(dir, 'audio-init.mp4');
  console.log('videoMime:', idx.videoMime);
  if (idx.audioMime) console.log('audioMime:', idx.audioMime);
  if (fs.existsSync(vInitPath)) {
    const vu8 = loadU8(vInitPath);
    const vi = parseInit(vu8);
    console.log('video-init mvhd timescale:', vi.mvhdTimescale, 'tracks:', vi.tracks);
  }
  if (idx.audioMime && fs.existsSync(aInitPath)) {
    const au8 = loadU8(aInitPath);
    const ai = parseInit(au8);
    console.log('audio-init mvhd timescale:', ai.mvhdTimescale, 'tracks:', ai.tracks);
  }
  const vSeg = idx.video?.[0] ? path.join(dir, idx.video[0]) : null;
  const aSeg = idx.audio?.[0] ? path.join(dir, idx.audio[0]) : null;
  if (vSeg && fs.existsSync(vSeg)) {
    const u = loadU8(vSeg);
    console.log('video seg #1 tfdt(base decode time):', parseTfdt(u));
  }
  if (aSeg && fs.existsSync(aSeg)) {
    const u = loadU8(aSeg);
    console.log('audio seg #1 tfdt(base decode time):', parseTfdt(u));
  }
}

const indexPath = process.argv[2] || path.join(process.cwd(), 'browser/segments/index.json');
run(indexPath);

