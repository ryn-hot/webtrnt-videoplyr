#!/usr/bin/env node
import http from 'http';
import { URL } from 'url';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    base: process.env.SEEK_BASE || 'http://localhost:8081',
    iterations: Number(process.env.SEEK_ITERATIONS || 5),
    delayMs: Number(process.env.SEEK_DELAY_MS || 2000),
    times: null,
    random: false,
    min: 0,
    max: Number(process.env.SEEK_RANDOM_MAX || 900)
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--base':
        options.base = args[++i];
        break;
      case '--iterations':
        options.iterations = Number(args[++i]);
        break;
      case '--delay':
        options.delayMs = Number(args[++i]);
        break;
      case '--times':
        options.times = args[++i].split(',').map(Number).filter(Number.isFinite);
        break;
      case '--random':
        options.random = true;
        break;
      case '--min':
        options.min = Number(args[++i]);
        break;
      case '--max':
        options.max = Number(args[++i]);
        break;
      default:
        console.warn(`Unknown arg: ${arg}`);
    }
  }
  if (!options.times || !options.times.length) {
    options.times = [15, 45, 90, 150, 220, 300];
  }
  return options;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendSeek(base, seconds, reason = 'regression') {
  return new Promise((resolve, reject) => {
    const url = new URL('/control/seek-reset', base);
    url.searchParams.set('reason', reason);
    if (Number.isFinite(seconds)) {
      url.searchParams.set('time', seconds.toString());
    }
    const req = http.request(url, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body ? JSON.parse(body) : {});
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function pickTime(opts, iteration) {
  if (opts.random) {
    const span = Math.max(opts.max - opts.min, 1);
    return opts.min + Math.random() * span;
  }
  const idx = iteration % opts.times.length;
  return opts.times[idx];
}

async function main() {
  const opts = parseArgs();
  console.log(`Seek regression harness starting → base=${opts.base} iterations=${opts.iterations}`);
  for (let i = 0; i < opts.iterations; i++) {
    const target = pickTime(opts, i);
    const reason = `regression-${i + 1}`;
    process.stdout.write(`Seek ${i + 1}/${opts.iterations} → ${target.toFixed(3)}s ... `);
    try {
      const result = await sendSeek(opts.base, target, reason);
      console.log('ok', result?.ok ? '' : JSON.stringify(result));
    } catch (err) {
      console.log(`failed (${err.message})`);
    }
    if (i < opts.iterations - 1) {
      await sleep(opts.delayMs);
    }
  }
  console.log('Seek regression run complete.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('seek-regression.js')) {
  main().catch(err => {
    console.error('Seek regression harness failed:', err);
    process.exit(1);
  });
}
