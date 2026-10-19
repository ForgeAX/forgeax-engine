import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpus } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromeLaunchOptions } from '../../scripts/chrome-options.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const evidencePath = resolve(
  repoRoot,
  'artifacts',
  'forgeax-loop',
  'feat-20260807-web-ts-multithreaded-engine-architecture',
  'm0',
  'evidence',
  'raw-kernel.json',
);
const configuration = {
  length: Number.parseInt(process.env.M0_KERNEL_LENGTH ?? '1048576', 10),
  iterations: Number.parseInt(process.env.M0_KERNEL_ITERATIONS ?? '48', 10),
  workers: Math.min(4, Math.max(2, cpus().length - 1)),
  warmup: Number.parseInt(process.env.M0_KERNEL_WARMUP ?? '4', 10),
  samples: Number.parseInt(process.env.M0_KERNEL_SAMPLES ?? '15', 10),
  seed: 20260809,
};

const kernelBody = String.raw`
function runKernel(values, start, end, iterations) {
  for (let index = start; index < end; index += 1) {
    let x = values[index];
    let y = values[index + values.length / 2];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const next = x * 1.0000001192092896 + y * 0.00031 + iteration * 0.000001;
      y = y * 0.9999999403953552 - x * 0.00017 + iteration * 0.000002;
      x = next;
    }
    values[index] = x;
    values[index + values.length / 2] = y;
  }
}
`;

const kernelWorkerSource = `${kernelBody}
self.postMessage({ type: 'ready' });
self.onmessage = (event) => {
  const { dataBuffer, controlBuffer, workerIndex, start, end, iterations } = event.data;
  const values = new Float32Array(dataBuffer);
  const control = new Int32Array(controlBuffer);
  runKernel(values, start, end, iterations);
  Atomics.add(control, 0, 1);
  Atomics.notify(control, 0, 1);
};
`;

const controllerSource = `${kernelBody}
let values;
let dataBuffer;
let control;
let controlBuffer;
let pool = [];
let config;
let startupMs = 0;

function absoluteNow() {
  return performance.timeOrigin + performance.now();
}

function resetValues(seed) {
  let state = seed >>> 0;
  const half = values.length / 2;
  for (let index = 0; index < half; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values[index] = (state / 4294967296) * 2 - 1;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values[index + half] = (state / 4294967296) * 2 - 1;
  }
}

function checksum() {
  const half = values.length / 2;
  const stride = Math.max(1, Math.floor(half / 1024));
  let sum = 0;
  for (let index = 0; index < half; index += stride) {
    sum += values[index] + values[index + half];
  }
  return sum;
}

async function initialize(nextConfig) {
  config = nextConfig;
  dataBuffer = new SharedArrayBuffer(config.length * 2 * Float32Array.BYTES_PER_ELEMENT);
  values = new Float32Array(dataBuffer);
  controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  control = new Int32Array(controlBuffer);
  resetValues(config.seed);
  const start = performance.now();
  pool = Array.from({ length: config.workers }, () => new Worker('/kernel-worker.js'));
  await Promise.all(pool.map((worker) => new Promise((resolveReady, reject) => {
    worker.addEventListener('message', (event) => {
      if (event.data?.type === 'ready') resolveReady();
    }, { once: true });
    worker.addEventListener('error', (event) => reject(new Error(event.message)), { once: true });
  })));
  startupMs = performance.now() - start;
}

function runForcedInline(sentAt) {
  const receivedAt = absoluteNow();
  const start = performance.now();
  runKernel(values, 0, config.length, config.iterations);
  const kernelMs = performance.now() - start;
  return {
    startupMs,
    messageMs: Math.max(0, receivedAt - sentAt),
    kernelMs,
    waitJoinMs: 0,
    totalMs: Math.max(0, absoluteNow() - sentAt),
    checksum: checksum(),
  };
}

function runShared(sentAt) {
  const receivedAt = absoluteNow();
  Atomics.store(control, 0, 0);
  const chunk = Math.ceil(config.length / config.workers);
  const start = performance.now();
  for (let workerIndex = 0; workerIndex < pool.length; workerIndex += 1) {
    const rangeStart = Math.min(config.length, workerIndex * chunk);
    const rangeEnd = Math.min(config.length, rangeStart + chunk);
    pool[workerIndex].postMessage({
      dataBuffer,
      controlBuffer,
      workerIndex,
      start: rangeStart,
      end: rangeEnd,
      iterations: config.iterations,
    });
  }
  const waitStart = performance.now();
  while (Atomics.load(control, 0) < pool.length) {
    const observed = Atomics.load(control, 0);
    Atomics.wait(control, 0, observed, 30000);
  }
  const end = performance.now();
  return {
    startupMs,
    messageMs: Math.max(0, receivedAt - sentAt),
    kernelMs: end - start,
    waitJoinMs: end - waitStart,
    totalMs: Math.max(0, absoluteNow() - sentAt),
    checksum: checksum(),
  };
}

self.onmessage = async (event) => {
  const { id, type, sentAt, config: nextConfig, seed } = event.data;
  try {
    if (type === 'initialize') {
      await initialize(nextConfig);
      self.postMessage({ id, ok: true, value: { startupMs, timeOrigin: performance.timeOrigin } });
      return;
    }
    if (type === 'reset') {
      resetValues(seed);
      self.postMessage({ id, ok: true });
      return;
    }
    const value = type === 'forced-inline' ? runForcedInline(sentAt) : runShared(sentAt);
    startupMs = 0;
    self.postMessage({ id, ok: true, value });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.stack ?? error) });
  }
};
`;

function pageSource() {
  return `<!doctype html><meta charset="utf-8"><title>M0 raw kernel</title><script>
    const controller = new Worker('/controller.js');
    let nextId = 1;
    const pending = new Map();
    controller.onmessage = (event) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data.value);
      else entry.reject(new Error(event.data.error));
    };
    controller.onerror = (event) => {
      for (const entry of pending.values()) entry.reject(new Error(event.message));
      pending.clear();
    };
    window.__m0Command = (type, payload = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      controller.postMessage({
        id,
        type,
        ...payload,
        sentAt: performance.timeOrigin + performance.now(),
      });
    });
  </script>`;
}

async function startServer() {
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Permissions-Policy', 'cross-origin-isolated=(self)');
    if (request.url === '/controller.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      response.end(controllerSource);
      return;
    }
    if (request.url === '/kernel-worker.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      response.end(kernelWorkerSource);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(pageSource());
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('benchmark server has no port');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;
  return (sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction;
}

function componentStats(samples, key) {
  const values = samples.map((sample) => sample[key]);
  const p50 = quantile(values, 0.5);
  return {
    p50,
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    jitter: p50 === 0 ? 0 : (quantile(values, 0.95) - quantile(values, 0.05)) / p50,
  };
}

function pathStats(samples) {
  return Object.fromEntries(
    ['startupMs', 'messageMs', 'kernelMs', 'waitJoinMs', 'totalMs'].map((key) => [
      key,
      componentStats(samples, key),
    ]),
  );
}

export function assessSpeedup(forcedInlineSamples, sharedSamples) {
  const forcedInline = pathStats(forcedInlineSamples);
  const shared = pathStats(sharedSamples);
  const value = forcedInline.kernelMs.p50 / shared.kernelMs.p50;
  return {
    stats: { forcedInline, shared },
    speedup: {
      formula: 'forcedInline.kernelMs.p50/shared.kernelMs.p50',
      aggregation: 'p50',
      value,
      threshold: 1.5,
      passed: value >= 1.5,
    },
  };
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const sample = (kernelMs) => ({
      startupMs: 0,
      messageMs: 0.1,
      kernelMs,
      waitJoinMs: 0,
      totalMs: kernelMs + 0.1,
      checksum: 1,
    });
    const good = assessSpeedup(Array.from({ length: 10 }, () => sample(3)), Array.from({ length: 10 }, () => sample(1)));
    const bad = assessSpeedup(
      [sample(100), ...Array.from({ length: 9 }, () => sample(1))],
      Array.from({ length: 10 }, () => sample(1)),
    );
    if (!good.speedup.passed || bad.speedup.passed) process.exitCode = 1;
    else console.log('[m0-bench] p50 threshold fixture accepted; fastest-single outlier rejected');
    return;
  }

  const { server, origin } = await startServer();
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'load' });
    const isolated = await page.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === 'function');
    if (!isolated) throw new Error('raw kernel page is not cross-origin isolated with SharedArrayBuffer');
    const initialized = await page.evaluate((config) => globalThis.__m0Command('initialize', { config }), configuration);
    const forcedInlineSamples = [];
    const sharedSamples = [];
    for (let index = 0; index < configuration.warmup + configuration.samples; index += 1) {
      await page.evaluate((seed) => globalThis.__m0Command('reset', { seed }), configuration.seed + index);
      const forcedInline = await page.evaluate(() => globalThis.__m0Command('forced-inline'));
      await page.evaluate((seed) => globalThis.__m0Command('reset', { seed }), configuration.seed + index);
      const shared = await page.evaluate(() => globalThis.__m0Command('shared'));
      const tolerance = Math.max(0.001, Math.abs(forcedInline.checksum) * 0.000001);
      if (Math.abs(forcedInline.checksum - shared.checksum) > tolerance) {
        throw new Error(`kernel parity mismatch at sample ${index}`);
      }
      if (index >= configuration.warmup) {
        forcedInlineSamples.push(forcedInline);
        sharedSamples.push(shared);
      }
    }
    const assessment = assessSpeedup(forcedInlineSamples, sharedSamples);
    const result = {
      browser: 'chrome',
      browserVersion: browser.version(),
      userAgent: await page.evaluate(() => navigator.userAgent),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
      command: 'node apps/hello/multithreaded-execution/m0/scripts/run-raw-kernel.mjs',
      timeOrigin: initialized.timeOrigin,
      data: configuration,
      waitState: 'controller-worker-atomics-wait',
      forcedInlineSamples,
      sharedSamples,
      ...assessment,
    };
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    if (!assessment.speedup.passed) process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
