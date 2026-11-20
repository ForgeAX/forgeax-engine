// Native qualification: node --expose-gc scripts/bench/level-streaming-runtime-native.mjs /tmp/result.json

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { create, globals } from '../../packages/dawn-node/src/index.mjs';
import { ok } from '../../packages/types/dist/index.mjs';
import { buildEngineShaderManifest } from '../../packages/vite-plugin-shader/dist/index.mjs';
import { patchDawnAdapterPrototype } from '../ci/normalize-dawn-device-limits.mjs';
import { teardownDawnInstance } from '../lib/dawn-teardown.mjs';
import { createLevelStreamingPack } from './fixtures/level-streaming-pack.mjs';
import { runLevelStreamingRuntime } from './level-streaming-runtime.mjs';

const output = resolve(process.argv[2] ?? '/tmp/forgeax-level-runtime-native-20261118.json');
if (output.startsWith(`${process.cwd()}/`))
  throw Error('raw measurements must stay outside checkout');
if (typeof global.gc !== 'function')
  throw Error('native retained-memory qualification requires --expose-gc');
const profileText = await readFile(
  new URL('./level-streaming-profile.json', import.meta.url),
  'utf8',
);
const profile = JSON.parse(profileText);
const fixture = await createLevelStreamingPack(profile, {
  withInstances: process.argv.includes('--with-instances'),
});
Object.assign(globalThis, globals);
patchDawnAdapterPrototype(globals);
const gpu = create([]),
  devices = new Set(),
  adapters = [];
Object.defineProperty(globalThis.navigator, 'gpu', { configurable: true, value: gpu });
const requestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (...args) => {
  const adapter = await requestAdapter(...args);
  if (adapter !== null) {
    const info = adapter.info;
    adapters.push({
      vendor: info?.vendor,
      architecture: info?.architecture,
      device: info?.device,
      description: info?.description,
    });
    const request = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (...descriptors) => {
      const device = await request(...descriptors);
      devices.add(device);
      return device;
    };
  }
  return adapter;
};
let native, target;
const canvas = {
  width: 1280,
  height: 720,
  getContext: () => ({
    configure(options) {
      native = options.device;
      target?.destroy();
      target = native.createTexture({
        size: [1280, 720],
        format: options.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: options.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      return target;
    },
    unconfigure() {},
  }),
};
const timers = new Set();
let frameTarget = performance.now();
const platform = {
  now: () => ok(performance.now()),
  requestFrame(callback) {
    const period = 1000 / 60;
    const now = performance.now();
    frameTarget = Math.max(frameTarget + period, Math.ceil(now / period) * period);
    const next = frameTarget;
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        callback();
      },
      Math.max(0, next - performance.now()),
    );
    timers.add(timer);
    return ok(() => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  },
  display: () =>
    ok({
      width: 1280,
      height: 720,
      drawingWidth: 1280,
      drawingHeight: 720,
      pixelRatio: 1,
      safeArea: { x: 0, y: 0, width: 1280, height: 720 },
    }),
  visible: () => true,
  subscribe: () => ok(() => {}),
  dispose() {},
};
const manifestUrl = URL.createObjectURL(
  new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }),
);
const diagnosis = process.argv.includes('--diagnose-first-cycle');
const controller = new AbortController();
let report;
try {
  report = await runLevelStreamingRuntime({
    canvas,
    platform,
    profile,
    producer: fixture.facts,
    catalog: fixture.producer.catalog,
    fetcher: fixture.producer.fetch,
    rootGuid: fixture.rootGuid,
    shaderManifestUrl: manifestUrl,
    signal: controller.signal,
    backend: 'dawn-metal',
    identity: {
      platform: process.platform,
      architecture: process.arch,
      cpu: os.cpus()[0]?.model,
      os: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
      node: process.version,
      clock: {
        performanceMs: performance.now(),
        monotonicMicros: Number(process.hrtime.bigint() / 1000n),
      },
      adapters,
      profileSha256: createHash('sha256').update(profileText).digest('hex'),
      source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
      hostBefore: { load: os.loadavg(), freeMemoryBytes: os.freemem() },
    },
    progress: (event) => {
      console.log(JSON.stringify(event));
      if (diagnosis && event.phase === 'copies-0/cycle-1/prepare')
        controller.abort(
          Error('first complete cycle diagnostic ends; original full profile remains unqualified'),
        );
    },
    heap: async () => {
      global.gc();
      const usage = process.memoryUsage();
      return {
        jsHeapBytes: usage.heapUsed,
        externalBytes: usage.external,
        arrayBufferBytes: usage.arrayBuffers,
      };
    },
  });
  report.producer = fixture.facts;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      output,
      qualified: report.qualified,
      failures: report.failures,
      failedChecks: report.checks.filter((check) => !check.pass).map((check) => check.name),
    }),
  );
} finally {
  for (const timer of timers) clearTimeout(timer);
  URL.revokeObjectURL(manifestUrl);
  target?.destroy();
  await fixture.producer.dispose();
  await teardownDawnInstance(devices, () => {
    devices.clear();
    delete globalThis.navigator.gpu;
  });
}
if (!report?.qualified) process.exitCode = 1;
