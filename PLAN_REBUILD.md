# Seek/Continuity Rebuild Plan

## Goal
Rebuild the player pipeline so every seek spins up a fresh continuity with deterministic timestamps, enabling instant seeking (even post-demux) and glitch-free audio track switching.

## Milestones

1. **Seek Controller Skeleton**
   - Centralize all seek requests (UI + internal) through a state machine.
   - States: `idle`, `pending`, `tearingDown`, `restarting`, `awaitKeyframe`.
   - Track `targetSec`, `epochId`, and provide hooks (`onStart`, `onRestart`, `onCommit`, `onAbort`).

2. **Pipeline Teardown & Restart**
   - On `onStart`:
     - Close audio gate, mark video gate awaiting keyframe.
     - Pause packet delivery to remuxers.
     - Finalize current video/audio remuxers and wait for completion.
     - Save `epochId` and push discontinuity into segment store.
   - After teardown, call `restartParserAt(targetSec, epochId)`.

3. **Cue-based Parser Restart**
   - Use `metadata.lookupCue` to derive byte offset.
   - Cancel existing WebTorrent stream, prioritize new range, spawn fresh `SimpleParser`.
   - Tag the parser/remuxers with `epochId` for sanity checks.

4. **Remuxer Rebuild via Tracks Event**
   - On `tracks`, start fresh remuxers tied to `epochId`.
   - Reset sequence counters, drop prior overrides, and record new init segments.
   - Keep audio gate closed until first video fragment (keyframe) arrives.

5. **Epoch-aware Segment Store & Playlists**
   - Store `epochId` with every init/segment.
   - Clear prior segments on seek, bump discontinuity counters, ensure playlists emit `EXT-X-DISCONTINUITY` for new epoch.

6. **Video Keyframe + Audio Gating**
   - Drop video packets until keyframe in new epoch.
   - Once keyframe is stored, reopen audio gate and flush buffered audio.

7. **Diagnostics & Regression Harness** *(done)*
   - Dedicated `diagnostics/run-*/seek-state.jsonl` plus enriched `timeline-reset` entries (cue lookup, parser restart, keyframe completion) for easy log tailing.
   - Added `tools/seek-regression.js` harness to automate repeated seek requests against `/control/seek-reset` with configurable timings/delays.

## Implementation Order
1. Implement Milestones 1–4 (seek controller through remuxer rebuild) with minimal gating.
2. Extend segment store for epoch awareness (Milestone 5).
3. Add keyframe/audio gating and ensure remuxer baselines reset (Milestone 6).
4. Wire diagnostics and create automated seek tests (Milestone 7).
