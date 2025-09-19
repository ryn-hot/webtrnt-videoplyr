// simple-parser.js
import { EventEmitter } from 'events';
// import Metadata from 'matroska-metadata';
import Metadata from './metadata/index.js';
import { hex2bin, arr2hex } from 'uint8-util';
import { SUPPORTS } from './support.js';
import { fontRx } from './util.js';
import Debug from 'debug';


const debug = Debug('torrent:parser');

export default class Parser extends EventEmitter {
    metadata = null;
    file = null;
    destroyed = false;
    eventEmitter = null;
    streamPiper = null; // To manage the stream passed to parseStream

    constructor(file, eventEmitter) {
        super(); // Call super() for EventEmitter
        // debug(`Initializing parser for file: ${file?.name}`);
        if (!file || !eventEmitter) {
            throw new Error("Parser requires 'file' and 'eventEmitter' arguments.");
        }
        this.file = file;
        this.eventEmitter = eventEmitter;

        try {
            // *** CORRECT: Initialize with the file object ***
            this.metadata = new Metadata(this.file);
            // debug('matroska-metadata initialized successfully.');
        } catch (error) {
            // debug(`Error initializing Metadata: ${error.message}`);
            this.eventEmitter.emit('parser-error', new Error(`Metadata initialization failed: ${error.message}`));
            this.destroy();
            return;
        }
        
        // Listener for subtitles emitted FROM the metadata instance
        this.metadata.on('subtitle', (subtitle, trackNumber) => {
            if (this.destroyed) return;
            // Use a more prominent log for actual subtitle data emission
            //debug(`***** Parser emitting subtitle for track ${trackNumber} *****`);
            this.eventEmitter.emit('subtitle-cue', {
                trackNumber: trackNumber,
                subtitle: subtitle
            });
        });

        // Audio and Video Packets are commented out becasue they cause memory leaks
        // -----------------------------------------------
        this.metadata.on('audio-packet', pkt => {
            if (!this.destroyed) this.eventEmitter.emit('audio-packet', pkt)
        })

        this.metadata.on('video-packet', pkt => {
            if (!this.destroyed) this.eventEmitter.emit('video-packet', pkt)
        }) 

        this.metadata.buildCueIndex().then(idx => {
            if (!this.destroyed) this.eventEmitter.emit('cue-index-ready', idx)
        })

        // Promises for initial metadata (Tracks, Attachments, Chapters)
        this.metadata.getTracks().then(tracks => {
            if (this.destroyed) return;
            // debug(`Parser found ${tracks?.length || 0} tracks via getTracks()`);
            // debug('getTracks() promise resolved. Raw tracks:', JSON.stringify(tracks || [], null, 2));
            this.eventEmitter.emit('tracks', tracks);
        }).catch(err => debug("Parser error getting tracks:", err));


        this.metadata.getAttachments().then(attachments => {
            if (this.destroyed) return;
            // debug(`Parser found ${attachments?.length || 0} attachments via getAttachments()`);
            // debug(`getAttachments() promise resolved. Raw attachments count: ${attachments?.length || 0}`);
            attachments.forEach(attachment => {
                 if (fontRx.test(attachment.filename) || attachment.mimetype?.toLowerCase().includes('font')) {
                     try {
                         const data = hex2bin(arr2hex(attachment.data));
                         if (SUPPORTS.isAndroid && data.length > 15_000_000) {
                             // debug('Skipping large font file on Android: ' + attachment.filename);
                             return;
                         }
                         // debug(`Parser found font: ${attachment.filename}`);
                         this.eventEmitter.emit('subtitle-font-data', {
                             filename: attachment.filename,
                             mimetype: attachment.mimetype,
                             data: data
                         });
                     } catch (bufferError) {
                        debug(`Error processing attachment ${attachment.filename}: ${bufferError.message}`);
                     }
                 }
            });
        }).catch(err => debug("Error getting attachments:", err));

        this.metadata.on('error', (err) => {
            debug(`matroska-metadata error: ${err.message}`);
            this.eventEmitter.emit('parser-error', err);
         });

         // *** NO file.on('iterator', ...) listener here ***
         debug(`Parser instance created for ${this.file.name}. Waiting for startParsingFromStream.`);
    }

    // Method to start parsing from an EXTERNALLY provided stream
    async startParsingFromStream(stream) { // Make async
        if (this.destroyed) {
             debug('Parser destroyed. Aborting startParsingFromStream.');
             if (stream && typeof stream.destroy === 'function') { stream.destroy(); }
             return;
        }
        if (!stream || (typeof stream[Symbol.asyncIterator] !== 'function' && typeof stream.pipe !== 'function')) { // Check if it's stream-like or async iterable
            debug('Error: Invalid stream provided (not async iterable or pipeable).');
            this.eventEmitter.emit('parser-error', new Error('Invalid stream provided to parser'));
            return;
        }
        debug(`>>> Consuming stream via parseStream for ${this.file?.name}...`);
        try {
            // Call parseStream and consume the async generator it returns.
            // This drives the internal parsing and event emission.
            // We don't need to assign the result or pipe manually.
            // eslint-disable-next-line no-unused-vars
            for await (const _chunk of this.metadata.parseStream(stream)) {
                // Loop MUST be consumed. Body can be empty.
                if (this.destroyed) {
                     debug('Parser destroyed during stream consumption.');
                     if (stream && typeof stream.destroy === 'function') {
                         stream.destroy(); // Ensure source stream is closed
                     }
                     break;
                }
            }
            // If loop finishes without being destroyed:
            if (!this.destroyed) {
                debug(`Parsing stream finished naturally for ${this.file?.name}.`);
                this.parsed = true;
                this.eventEmitter.emit('parsing-finished');
            }

        } catch (error) {
             debug(`Error during stream consumption/parsing for ${this.file?.name}: ${error.stack || error.message}`); // Log stack
             if (this.eventEmitter && typeof this.eventEmitter.emit === 'function') {
                 this.eventEmitter.emit('parser-error', error);
             }
             if (stream && typeof stream.destroy === 'function') {
                  stream.destroy(); // Ensure source stream is closed on error
             }
        } finally {
             debug(`Exiting startParsingFromStream async generator loop/try-catch for ${this.file?.name}.`);
        }
    }

    destroy() {
        if (this.destroyed) return;
        debug(`Destroying Parser for ${this.file?.name}`);
        this.destroyed = true; // Set flag early to stop ongoing operations
        // No streamPiper to destroy, the stream is managed by the caller (test-subtitles.js)
        if (this.metadata) {
            // It's crucial to remove listeners to prevent memory leaks
            // and stop processing if parseStream is still somehow running
            this.metadata.removeAllListeners();
            // Check if matroska-metadata itself has a destroy method
             if (typeof this.metadata.destroy === 'function') {
                 this.metadata.destroy();
             }
            this.metadata = null;
        }
        this.eventEmitter = null;
        this.removeAllListeners(); // Remove listeners from this Parser instance

    }
}
