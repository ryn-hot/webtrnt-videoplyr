import fs from 'fs';
import path from 'path';

class Diagnostics {
  static instance = null;

  static start(meta = {}) {
    if (Diagnostics.instance) return Diagnostics.instance;
    Diagnostics.instance = new Diagnostics(meta);
    return Diagnostics.instance;
  }

  constructor(meta) {
    this.enabled = Boolean(process.env.DIAGNOSTICS || process.env.DIAG);
    if (!this.enabled) {
      this.dir = null;
      return;
    }
    const root = path.resolve(process.cwd(), 'diagnostics');
    fs.mkdirSync(root, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(root, `run-${ts}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.append('meta', { event: 'start', meta, cwd: process.cwd() });
  }

  append(name, payload) {
    if (!this.enabled || !this.dir) return;
    const line = JSON.stringify({ ...payload, time: Date.now() });
    fs.appendFileSync(path.join(this.dir, `${name}.jsonl`), line + '\n');
  }

  writeSnapshot(name, data) {
    if (!this.enabled || !this.dir) return;
    fs.writeFileSync(path.join(this.dir, name), data);
  }

  demux(kind, info) {
    this.append('demux', { kind, ...info });
  }

  remux(kind, info) {
    this.append('remux', { kind, ...info });
  }

  queue(kind, info) {
    this.append('queue', { kind, ...info });
  }

  hls(kind, info) {
    this.append('hls', { kind, ...info });
  }

  error(scope, err) {
    const message = typeof err === 'string' ? err : err?.message || String(err);
    this.append('errors', { scope, message });
  }

  summary(info) {
    this.append('summary', info);
  }
}

export default Diagnostics;
