// seek-controller.js
// Simple state machine to serialize seek requests, ensuring only one
// continuity rebuild is in flight at a time while coalescing new targets.

export default class SeekController {
  constructor({ diag, logger, performSeek }) {
    if (typeof performSeek !== 'function') {
      throw new TypeError('SeekController requires performSeek callback');
    }
    this.diag = diag;
    this.log = logger || (() => {});
    this.performSeek = performSeek;

    this._state = 'idle';
    this._latestRequest = null;
    this._processing = false;
    this._requestCounter = 0;
    this._epochCounter = 0;
    this._active = null; // { epochId, request }
    this._completion = null; // { promise, resolve, reject }
  }

  requestSeek(targetSec, meta = {}) {
    const request = {
      id: ++this._requestCounter,
      targetSec,
      meta,
      enqueuedAt: Date.now()
    };
    this._latestRequest = request;
    this._emit('enqueue', { requestId: request.id, targetSec, meta });
    if (!this._processing) {
      this._processLoop().catch(err => {
        this.log(`seek-controller: unhandled error ${err?.stack || err}`);
      });
    }
  }

  setState(state, info = {}) {
    this._state = state;
    this._emit('state', { state, ...info });
  }

  complete(info = {}) {
    if (this._completion?.resolve) {
      this._completion.resolve(info);
    }
  }

  fail(err) {
    if (this._completion?.reject) {
      this._completion.reject(err);
    }
  }

  isActive() {
    return this._processing || this._state !== 'idle';
  }

  isAwaitingKeyframe() {
    return this._state === 'awaiting-keyframe';
  }

  getActiveEpoch() {
    return this._active?.epochId ?? 0;
  }

  getState() {
    return this._state;
  }

  async _processLoop() {
    this._processing = true;
    try {
      while (this._latestRequest) {
        const request = this._latestRequest;
        this._latestRequest = null;
        const epochId = ++this._epochCounter;
      this._active = { epochId, request };
      this._completion = createDeferred();
      try {
        await this.performSeek({ controller: this, request, epochId });
        await this._completion.promise;
        this._emit('complete', { epochId, requestId: request.id });
      } catch (err) {
        if (this._completion) {
          this._completion.reject(err);
        }
        this.setState('error', {
          epochId,
          requestId: request.id,
          message: err?.message || String(err)
        });
        this._emit('error', {
          epochId,
          requestId: request.id,
          message: err?.message || String(err)
        });
        this.log(`seek-controller error epoch=${epochId} request=${request.id}: ${err?.stack || err}`);
        } finally {
          this._active = null;
          this._completion = null;
          this._state = 'idle';
        }
      }
    } finally {
      this._processing = false;
      this._emit('idle', {});
    }
  }

  _emit(action, payload) {
    if (this.diag && typeof this.diag.queue === 'function') {
      this.diag.queue('seek-state', { action, ...payload, time: Date.now() });
    }
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
