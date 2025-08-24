// import inflateBuffer from './inflateWeb.js';
import { inflateSync } from 'zlib'


import { arr2text, concat } from 'uint8-util'
import { EbmlIteratorDecoder, EbmlTagId } from 'ebml-iterator'
import 'fast-readable-async-iterator'

import Util from './util.js'

const SSA_TYPES = new Set(['ssa', 'ass'])
const SSA_KEYS = ['readOrder', 'layer', 'style', 'name', 'marginL', 'marginR', 'marginV', 'effect', 'text']

/**
 * @param {import('ebml-iterator').EbmlMasterTag} chunk
 * @param {number} tag
 */
function getChild (chunk, tag) {
  return chunk?.Children?.find(({ id }) => id === tag)
}
/**
 * @param {import('ebml-iterator').EbmlMasterTag} chunk
 * @param {number} tag
 */
function getData (chunk, tag) {
  return getChild(chunk, tag)?.data
}

export default class Metadata extends Util {
  implementsSlice = false
  timecodeScale = 1
  currentClusterTimecode = null
  destroyed = false

  /**
   * @type {Map<any, {number: string, language: string, type: string, _compressed?: boolean}>}
   */
  subtitleTracks = new Map();
  audioTracks    = new Map()
  videoTracks    = new Map()
  trackMap       = new Map()   // ← NEW

  /**
   * @param {Blob} file
   */
  constructor (file) {
    super()
    this.file = file
    this.implementsSlice = !!file.slice

    this._lastSample = new Map()

    this._recentDurations = new Map();

    this._windowSize   = 20;
    this._hardFallback = 100;
   
 

    this.segment = this.getSegment()
    this.seekHead = this.getSeekHead()
    this.duration = this.getDuration()
    this.tracks = this.getTracks()
  }

  _onPacketDuration(duration, pktTrackNumber) {
    let arr = this._recentDurations.get(pktTrackNumber) || [];
    arr.push(duration);
    if (arr.length > this._windowSize) arr.shift();
    this._recentDurations.set(pktTrackNumber, arr);
  }

  /**
   * @returns {Promise<{filename: string, mimetype: string, data: Uint8Array}[]>}
   */
  async getAttachments () {
    return (await this.readSeekHeadTag('Attachments'))?.Children?.map((/** @type {import("ebml-iterator").EbmlMasterTag} */ chunk) => ({
      filename: getData(chunk, EbmlTagId.FileName),
      mimetype: getData(chunk, EbmlTagId.FileMimeType),
      data: getData(chunk, EbmlTagId.FileData)
    })) || []
  }

  /**
   * @returns {Promise<{number: string, language: string, type: string, _compressed?: boolean}[]>}
   */
  async getTracks () {
        if (this.tracks) return await this.tracks
        const Tracks = await this.readSeekHeadTag('Tracks')

        if (!Tracks?.Children?.length) return []

        this.subtitleTracks.clear();
        this.audioTracks.clear()
        this.videoTracks.clear()
        this.trackMap.clear()


        for (const entry of Tracks.Children.filter(c => c.id === EbmlTagId.TrackEntry)) {
            const trackType = getData(entry, EbmlTagId.TrackType);
            if (![0x01, 0x02, 0x11].includes(trackType)) continue

            const codecID = getData(entry, EbmlTagId.CodecID) || ''
            const track = {
              number   : getData(entry, EbmlTagId.TrackNumber),
              language : getData(entry, EbmlTagId.Language),
              name     : getData(entry, EbmlTagId.Name),
              codec    : codecID,
              type     : trackType === 0x02 ? 'audio'
                       : trackType === 0x01 ? 'video'
                       : codecID.startsWith('S_TEXT/') ? codecID.substring(7).toLowerCase()
                       : codecID.toLowerCase(),
            }
            
            this.trackMap.set(track.number, track)

            const priv = getData(entry, EbmlTagId.CodecPrivate);
            if (priv) track.header = priv;

            if (trackType === 0x11) {
                const header = getData(entry, EbmlTagId.CodecPrivate);
                if (header) track.header = arr2text(header);
        
                const compressed = entry.Children.find(c =>
                c.id === EbmlTagId.ContentEncodings &&
                c.Children.find(cc =>
                    cc.id === EbmlTagId.ContentEncoding &&
                    getChild(cc, EbmlTagId.ContentCompression)
                )
                );
                if (compressed) track._compressed = true;
        
                this.subtitleTracks.set(track.number, track); 
            } else if (trackType === 0x02) {   // audio
              track.header = getData(entry, EbmlTagId.CodecPrivate) || null;
              const audioElem = getChild(entry, EbmlTagId.Audio);

              if (audioElem) {
                track.samplingFrequency = getData(audioElem, EbmlTagId.SamplingFrequency);
                track.channels          = getData(audioElem, EbmlTagId.Channels);
              }
              
              this.audioTracks.set(track.number, track);

            } else if (trackType === 0x01) {   // video
              const videoElem = getChild(entry, EbmlTagId.Video);

              if (videoElem) {
                track.width  = getData(videoElem, EbmlTagId.PixelWidth);
                track.height = getData(videoElem, EbmlTagId.PixelHeight);
              }

              this.videoTracks.set(track.number, track);
            }
        
        }

        // merge and cache
        const all = [...this.videoTracks.values(), ...this.audioTracks.values(), ...this.subtitleTracks.values()]
        this.tracks = Promise.resolve(all);
        return all;
    }

  async getChapters () {
    const Chapters = await this.readSeekHeadTag('Chapters')

    const timecodeScale = this.timecodeScale || ((await this.readUntilTag(this.getFileStream(), EbmlTagId.TimecodeScale))?.data / 1000000)

    if (!Chapters?.Children?.length) return []

    const editions = Chapters.Children.filter(c => c.id === EbmlTagId.EditionEntry)

    // https://www.matroska.org/technical/chapters.html#default-edition
    // finds first default edition, or first entry
    const defaultEdition = editions.find(c => {
      return c.Children.some(cc => {
        return cc.id === EbmlTagId.EditionFlagDefault && Boolean(cc.data)
      })
    }) || editions[0]

    // exclude hidden atoms
    const atoms = defaultEdition.Children.filter(c => c.id === EbmlTagId.ChapterAtom && !getData(c, EbmlTagId.ChapterFlagHidden))

    const chapters = []
    for (let i = atoms.length - 1; i >= 0; --i) {
      const start = getData(atoms[i], EbmlTagId.ChapterTimeStart) / timecodeScale / 1000000
      const end = (getData(atoms[i], EbmlTagId.ChapterTimeEnd) / timecodeScale / 1000000) || chapters[i + 1]?.start || await this.duration || 0
      const disp = getChild(atoms[i], EbmlTagId.ChapterDisplay)

      chapters[i] = {
        start,
        end,
        text: getData(disp, EbmlTagId.ChapString),
        language: getData(disp, EbmlTagId.ChapLanguage)
      }
    }

    return chapters
  }

  /**
   * @returns {Promise<number | undefined>}
   */
  async getDuration () {
    if (this.duration) return this.duration
    const Info = await this.readSeekHeadTag('Info')

    if (!Info?.Children?.length) return undefined
    const Duration = getChild(Info, EbmlTagId.Duration)
    return Duration?.data
  }

  /**
   * @param {import("ebml-iterator").EbmlMasterTag} chunk
   */
  async handleBlockGroup (chunk, timecodeScale, currentClusterTimecode) {
    await this.tracks

    const block = chunk.id === EbmlTagId.SimpleBlock
                ? chunk           // SimpleBlock *is* the payload container
                : getChild(chunk, EbmlTagId.Block)
    if (!block) return            // defensive: shouldn't happen

    const track = this.trackMap.get(block.track)
    if (!track) return

    const pts = (block.value + currentClusterTimecode) * timecodeScale


    if (this.subtitleTracks.has(block.track)) {
      const blockDuration = getData(chunk, EbmlTagId.BlockDuration)
      const payload = track._compressed ? inflateSync(block.payload) : block.payload
      const subtitle = { text: arr2text(payload), time: pts, duration: blockDuration * timecodeScale }

      if (SSA_TYPES.has(track.type)) {
        const v = subtitle.text.split(',')
        for (let i = track.type === 'ssa' ? 2 : 1; i < 8; i++) subtitle[SSA_KEYS[i]] = v[i]
        subtitle.text = v.slice(8).join(',')
      }
      this.emit('subtitle', subtitle, block.track)

    } else if (track.type === 'audio') {
        const pkt = {
          trackNumber: block.track,
          pts,
          data:      block.payload,
          // no duration yet
        };

        const rawDur = getData(chunk, EbmlTagId.BlockDuration);
        if (rawDur != null) {
          const duration = rawDur * timecodeScale;
          pkt.duration = duration;
          this._lastSample.set(pkt.trackNumber, pkt);

          this._onPacketDuration(duration, pkt.trackNumber);

          return this.emit('audio-packet', {
            trackNumber: block.track,
            pts,
            duration,
            data: block.payload
          });
        }
        const last = this._lastSample.get(pkt.trackNumber);
        if (last) {
          // 1) we have a previous packet → compute its duration
          last.duration = pkt.pts - last.pts;
          // 2) now emit that previous packet
          this.emit(`${track.type}-packet`, last);

          // 3) store duration
          this._onPacketDuration(last.duration, pkt.trackNumber);

        }

        this._lastSample.set(pkt.trackNumber, pkt);
        

    } else if (track.type === 'video') {
        const pkt = {
          trackNumber: block.track,
          pts,
          data:      block.payload,
          isKeyframe: Boolean(block.keyframe)
          // no duration yet
        };

        const last = this._lastSample.get(pkt.trackNumber);
        if (last) {
          // 1) we have a previous packet → compute its duration
          last.duration = pkt.pts - last.pts;
          // 2) now emit that previous packet
          this.emit(`${track.type}-packet`, last);
          this._onPacketDuration(last.duration, pkt.trackNumber);
        }
        
        this._lastSample.set(pkt.trackNumber, pkt);
    }
  }


  flush() {
    const average = arr => arr.length ? arr.reduce((a, b) => a + b) / arr.length : 0;

    for (const [trackNumber, last] of this._lastSample.entries()) {
      if (last.duration == null) {
        // fallback: use average or a fixed guess
        const arr = this._recentDurations.get(trackNumber) || [];
        if (arr != []) {
          const avgDur = average(arr);
          last.duration = avgDur || 100; // in ms timebase
        }    
      }

      this.emit(`${last.isKeyframe != null ? 'video' : 'audio'}-packet`, last);
    }
    this._lastSample.clear();
  }

  destroy () {
    this.destroyed = true
  }

  /**
   * @param {AsyncIterable<Uint8Array>} stream
   */
  async * parseStream (stream, stable = false) {
    const decoder = new EbmlIteratorDecoder({
      bufferTagIds: [
        EbmlTagId.TimecodeScale,
        EbmlTagId.BlockGroup,
        EbmlTagId.Timecode
      ]
    })

    let timecodeScale = this.timecodeScale
    let currentClusterTimecode = this.currentClusterTimecode

    const tagMap = {
      // Segment Information
      [EbmlTagId.TimecodeScale]: tag => {
        this.timecodeScale = timecodeScale = tag.data / 1000000
      },
      // Assumption: This is a Cluster `Timecode`
      [EbmlTagId.Timecode]: tag => {
        this.currentClusterTimecode = currentClusterTimecode = tag.data
      },

      [EbmlTagId.SimpleBlock]: blk => this.handleBlockGroup(blk, timecodeScale, currentClusterTimecode),

      [EbmlTagId.BlockGroup]: data => this.handleBlockGroup(data, timecodeScale, currentClusterTimecode)
    }

    let buffer = new Uint8Array()

    for await (const chunk of stream) {
      if (!stable) {
        for (let i = 0; i < chunk.length - 12; i++) {
          // EbmlTagId.Cluster: 524531317 aka 0x1F43B675
          // https://matroska.org/technical/elements.html#LevelCluster
          if (chunk[i] === 0x1f && chunk[i + 1] === 0x43 && chunk[i + 2] === 0xb6 && chunk[i + 3] === 0x75) {
            // length of cluster size tag
            const len = 8 - Math.floor(Math.log2(chunk[i + 4]))
            // first tag in cluster is a valid EbmlTag
            if (EbmlTagId[chunk[i + 4 + len]]) {
              // okay this is probably a cluster
              stable = true
              buffer = null
              for (const tag of decoder.parseTags(chunk.slice(i))) {
                tagMap[tag.id]?.(tag)
              }
              break
            }
          }
        }
        if (!stable) {
          buffer = concat([buffer, chunk])
        }
      } else {
        for (const tag of decoder.parseTags(chunk)) {
          tagMap[tag.id]?.(tag)
        }
      }
      yield chunk
      if (this.destroyed) return null
    }
  }

  /* ----------  NEW for Step 2  ---------- */
  cueIndex = null               // Array<{time, offset}>

  async buildCueIndex() {
    if (this.cueIndex) return this.cueIndex        // already built

    /* 1. grab the <Cues> element via SeekHead */
    const Cues = await this.readSeekHeadTag('Cues')
    if (!Cues?.Children?.length) return (this.cueIndex = [])

    /* 2. make sure we know the timecodeScale, even if <Info> wasn’t parsed yet */
    if (this.timecodeScale === 1) {
      const Info = await this.readSeekHeadTag('Info')
      const scale = Info && getData(Info, EbmlTagId.TimecodeScale)
      if (scale) this.timecodeScale = scale / 1_000_000         // ns → ms
    }

    /* 3. Segment start = where the <Segment> master tag begins */
    const segmentStart =
      (this.segment?.tagStart ?? this.segment?.pos ?? this.segment?.offset ?? 0)

    const idx = []
    for (const point of Cues.Children.filter(c => c.id === EbmlTagId.CuePoint)) {
      const cueTime = getData(point, EbmlTagId.CueTime)
      const posTag  = point.Children.find(c => c.id === EbmlTagId.CueTrackPositions)
      const rel     = posTag && getData(posTag, EbmlTagId.CueClusterPosition)
      if (rel == null) continue
      idx.push({ time: cueTime * this.timecodeScale, offset: segmentStart + rel })
    }

    idx.sort((a, b) => a.time - b.time)
    return (this.cueIndex = idx)
  }

  /** O(log n) search for the cue ≤ given time (ms) */
  lookupCue(ms) {
    if (!this.cueIndex?.length) return null
    let lo = 0, hi = this.cueIndex.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      this.cueIndex[mid].time <= ms ? (lo = mid) : (hi = mid - 1)
    }
    return this.cueIndex[lo]
  }

  async parseFile () {
    this.stable = true
    // eslint-disable-next-line no-unused-vars
    for await (const _ of this.parseStream(this.getFileStream(), true)) {
      if (this.destroyed) return null
    }
  }
}


