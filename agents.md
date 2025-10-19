# Agent Reflection

## Project Goal
Build a production-ready player that ingests live WebTorrent MKV streams, demuxes audio/video/subtitles, remuxes them into CMAF fragments, serves them over a local HLS endpoint, and supports seamless live audio-track switching during arbitrary seek operations.

## Baseline State Observed
- The repository already handled streaming, demuxing, and basic remuxing; both video and audio played correctly when watching linearly.
- Audio drift only surfaced when seeking far forward: the first post-seek video keyframe arrived late while audio kept buffering ahead, creating several seconds of lead.
- Backward seeks and continued playback after long runs still produced audible desync but the core pipeline remained functional.

## Changes Attempted This Session
1. **Audio queue gating** – introduced per-track queues in `test.js` so audio fragments would only publish once a matching video segment arrived. Included TFDT rewrites and offset tracking (`latestVideoEndSec`, `audioSync`).
2. **Timeline logging** – wrote `debug-output/segment-timeline.csv` entries for every segment to measure gaps.
3. **Discontinuity handling** – reset queues and offsets when video jumps backwards, intended to avoid runaway audio post-seek.
4. **Dynamic TFDT adjustment** – rewrote audio tfdt bases on flush to snap start times to the current video window, attempting to keep hls.js happy.
5. **Per-packet offset corrections** – subtracted a mutable offset from every queued audio frame prior to remuxer push, constraining timestamps to be monotonic.
6. **HLS harness tweaks** – patched `tools/hls.html` autoplay helper to guard undefined callbacks.

## Failures Introduced
- **Early segment starvation**: the audio drop check used `latestVideoEndSec`, which is initially ahead of audio. That logic discarded the earliest audio segment, yielding stalls around 3 s because no audio existed for the first video keyframe.
- **Timestamp jitter**: repeatedly rewriting TFDT and per-packet offsets without synchronising `lastPts` correctly fed older timestamps back into Mediabunny, throwing `Timestamps cannot be smaller than the highest timestamp…` errors.
- **Queue starvation and spam**: the queue flushed while references like `sampleRate` and `noteAudioProgress` were undefined; each failure logged an error and skipped segment emission, degrading audio further.
- **Severe audio degradation**: successive rewrites, drops, and offset clamps truncated or duplicated fragments. By the end of playback only ~750 audio segments existed (vs. ~1 700 previously), so the stream sounded choppy and unintelligible.

## Root Cause Insight
The original issue is that video can stall waiting for an IDR frame after a large seek while audio keeps streaming, leading to a large lead. The quick fixes tried to micro-adjust timestamps instead of handling the underlying keyframe alignment, which compounded errors.

## Recommendation
Treat seek-induced discontinuities explicitly:
- Flush and recreate the Mediabunny audio remuxer (and WebCodecs timestamp baselines) whenever the video decoder is restarted. Start both tracks from the same post-seek PTS with a fresh offset rather than attempting to offset-guess queued packets.
- Gate demux delivery: pause `audio-packet` forwarding until the first post-seek video keyframe arrives, then resume with aligned baselines. Dropping or trimming packets before the muxer is safer than retroactively rewriting TFDT.
- Add deterministic discontinuity markers in the HLS playlists (`EXT-X-DISCONTINUITY`) when resetting; most hls.js stalls come from silent shifts in timeline rather than shortage of data.

Reset to the previously working baseline before reintroducing changes; then implement the seek-reset flow above with thorough instrumentation instead of pervasive timestamp rewriting.

## Current Plan (in progress)
1. Restore the known-good baseline (no queue-based TFDT rewrites).
2. Implement a true seek-reset flow: pause demux, flush/remake remuxers, restart both tracks from the same timestamp, emit `EXT-X-DISCONTINUITY`.
3. Reintroduce validation logging to verify audio/video stay aligned after large forward/backward seeks before adding further heuristics.

## Next Action Proposal
- Built `diagnostics.js` harness with JSONL appenders and added `npm run diagnostics` (`DIAGNOSTICS=1 node test.js`).
- Instrumented demux, queue, remux, and HLS playlist emission in `test.js`; each run emits `diagnostics/run-*/demux.jsonl`, `queue.jsonl`, `remux.jsonl`, `hls.jsonl`, `errors.jsonl`, etc.
- Extended `tools/hls.html` with a probe buffer (records player events, buffered ranges, HLS errors) plus a “Download Probe Log” button for correlation.
- Sandbox blocks binding to port 8081, so local CLI diagnostics can’t complete here, but harness writes to disk when run outside the sandbox.

## Latest Diagnostics (run-2025-10-19T06-08-45-750Z)
- Video emitted 709 segments; audio only 746 (vs. ~1.7k previously) with `queue.jsonl` showing a single drain that dropped 1 001 segments when `startSec` fell behind `lastVideoStartSec`.
- Emitted audio segments kept an offset of roughly –5 s (`offsetMs ≈ -5007`), so Mediabunny still sees pts backtracking and the player receives garbled audio.
- Stalling at 17 s coincides with the first dropped fragment; the early audio window never repopulates after the queue purge.
- Takeaway: the queue/TFDT rewrite path is over-correcting—dropping valid audio and clamping timestamps wildly.

## Next Steps
1. Revert repository to last known-good baseline (before queue gating and timestamp rewrites) while preserving the new diagnostics harness and HLS probe.
2. Confirm baseline run yields correct audio/video segment counts and clean playback.
3. Implement seek-reset flow on top of baseline (flush/remake remuxers, issue `EXT-X-DISCONTINUITY`, etc.) with diagnostics verifying behaviour after large forward/back seeks.
