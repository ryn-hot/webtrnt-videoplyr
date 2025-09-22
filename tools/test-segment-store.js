#!/usr/bin/env node
import { SegmentStore } from '../segment-store.js';

function assert(cond, msg) { if (!cond) throw new Error('Assert failed: ' + msg); }
function log(msg) { process.stdout.write(msg + '\n'); }

const store = new SegmentStore({ windowSize: 4 });

// Setup streams
store.setMeta('v', { codecs: 'avc1.640028', width: 1920, height: 1080 });
store.setInit('v', 'video/mp4; codecs="avc1.640028"', new Uint8Array([1,2,3]));
store.setMeta('a-2', { codecs: 'mp4a.40.2', channels: 2, samplerate: 44100 });
store.setInit('a-2', 'audio/mp4; codecs="mp4a.40.2"', new Uint8Array([9,8,7]));
assert(store.getMeta('v').codecs === 'avc1.640028', 'meta retrieval');
assert(store.hasInit('v') === true, 'has init video');
assert(store.listStreamsWithMeta().length === 2, 'list streams with meta');

// Add segments with starts: 0, 0.8, 1.6, 2.4, … durations ~0.8
const mk = (len) => new Uint8Array(len).fill(0xaa);
for (let i = 1; i <= 6; i++) {
  const start = (i-1) * 0.8;
  store.addSegment('v', i, mk(10+i), start, i === 6 ? undefined : 0.8);
}
for (let i = 1; i <= 6; i++) {
  const start = (i-1) * 0.186;
  store.addSegment('a-2', i, mk(5+i), start, i === 6 ? undefined : 0.186);
}

// Window size is 4, so first two should have been evicted
const winV = store.getHlsWindow('v');
assert(winV.mediaSequence === 3, 'mediaSequence should be 3 after eviction');
assert(winV.segments.length === 4, 'window length 4');
assert(winV.segments[0].seq === 3 && winV.segments[3].seq === 6, 'seq range 3..6');
assert(winV.segments[2].duration >= 0.79 && winV.segments[2].duration <= 0.81, 'dur ~0.8');
assert(winV.targetDuration >= 1 && winV.targetDuration <= 2, 'targetDuration ceil(maxDur)');

// Check init retrieval
const initV = store.getInit('v');
assert(initV && initV.mime.includes('video/mp4'), 'video init present');

// End-of-stream flag
store.end('v');
assert(store.getHlsWindow('v').endList === true, 'endList true after end');

// Unknown stream
assert(store.getHlsWindow('x') === null, 'missing stream returns null');
assert(store.getSegment('v', 999) === null, 'missing seg null');

log('SegmentStore tests passed.');
