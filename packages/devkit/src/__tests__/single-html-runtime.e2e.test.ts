// @perf-budget-skip: intentional real file:// browser integration gate covering the full runtime closure.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { DistManifest } from '../dist.js';
import { bundleSingleHtmlEntry, writeSingleHtml } from '../single-html.js';

const MINIMAL_WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

function browserExecutable(): string | undefined {
  const candidates = [
    process.env.FORGEAX_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/opt/google/chrome-beta/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    typeof chromium.executablePath === 'function' ? chromium.executablePath() : undefined,
  ];
  return candidates.find(
    (candidate): candidate is string => candidate !== undefined && existsSync(candidate),
  );
}

describe('single HTML runtime closure', () => {
  it('runs dynamic import, module worker, nested worker, WASM, JSON, and WGSL from file://', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-runtime-e2e-'));
    const dist = resolve(root, 'dist');
    const output = resolve(root, 'release', 'runtime.html');
    await mkdir(resolve(dist, 'assets'), { recursive: true });
    try {
      await Promise.all([
        writeFile(
          resolve(dist, 'index.html'),
          '<!doctype html><html data-preserve="a > b"><head><link rel="modulepreload" href="./main.js"><style>.fixture{color:red}</style></head><body><canvas id="canvas" width="64" height="64"></canvas><script type="module" src="./main.js"></script></body></html>',
        ),
        writeFile(
          resolve(dist, 'main.js'),
          `const lazy = await import('./lazy.js');
globalThis.loadOptionalHost = () => import('@fixture/node-only-server');
const canvas = document.querySelector('#canvas');
const context = canvas.getContext('2d');
context.fillStyle = '#14283d'; context.fillRect(0, 0, 64, 64);
context.fillStyle = '#f4c542'; context.fillRect(8, 8, 48, 48);
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (event) => {
  if (event.data?.kind !== 'worker-ready') return;
  document.documentElement.dataset.workerReady = JSON.stringify(event.data);
};
worker.postMessage({ run: true });
document.documentElement.dataset.lazyValue = String(lazy.value);
document.documentElement.dataset.forgeaxGameReady = 'true';
`,
        ),
        writeFile(resolve(dist, 'lazy.js'), 'export const value = 42;\n'),
        writeFile(
          resolve(dist, 'worker.js'),
          `self.onmessage = async () => {
  const data = await fetch(new URL('./data.json', import.meta.url)).then((response) => response.json());
  const shader = await fetch(new URL('./shader.wgsl', import.meta.url)).then((response) => response.text());
  const wasm = await WebAssembly.instantiate(await fetch(new URL('./sample.wasm', import.meta.url)).then((response) => response.arrayBuffer()));
  const nested = new Worker(new URL('./nested-worker.js', import.meta.url), { type: 'module' });
  nested.onmessage = (event) => postMessage({ kind: 'worker-ready', data: data.value, shader: shader.trim(), wasm: Object.keys(wasm.instance.exports).length, nested: event.data.value });
  nested.postMessage({ run: true });
};
`,
        ),
        writeFile(
          resolve(dist, 'nested-worker.js'),
          `self.onmessage = async () => {
  const data = await fetch(new URL('./data.json', import.meta.url)).then((response) => response.json());
  postMessage({ value: data.value });
};
`,
        ),
        writeFile(resolve(dist, 'data.json'), '{"value":"pack-ready"}\n'),
        writeFile(
          resolve(dist, 'shader.wgsl'),
          '@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }\n',
        ),
        writeFile(resolve(dist, 'sample.wasm'), MINIMAL_WASM),
        writeFile(resolve(dist, 'forgeax-dist.json'), '{}\n'),
      ]);
      const artifacts: DistManifest['artifacts'] = [
        { path: 'main.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
        { path: 'lazy.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
        { path: 'worker.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
        { path: 'nested-worker.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
        { path: 'data.json', mediaType: 'application/json', bytes: 0, sha256: '' },
        { path: 'shader.wgsl', mediaType: 'text/plain', bytes: 0, sha256: '' },
        {
          path: 'sample.wasm',
          mediaType: 'application/wasm',
          bytes: MINIMAL_WASM.byteLength,
          sha256: '',
        },
      ];
      const manifest: DistManifest = {
        schemaVersion: '1.0.0',
        project: { id: 'single-html-runtime-e2e', name: 'Single HTML Runtime E2E' },
        base: './',
        runtime: { packIndexUrl: 'data.json', shaderManifestUrl: 'shader.wgsl' },
        artifacts,
      };
      const indexHtml = await readFile(resolve(dist, 'index.html'), 'utf8');
      const bundle = await bundleSingleHtmlEntry(dist, indexHtml);
      expect(bundle.ok).toBe(true);
      if (!bundle.ok) return;
      const packaged = await writeSingleHtml({
        distRoot: dist,
        output,
        manifest,
        bundle: bundle.value,
      });
      expect(packaged.ok).toBe(true);
      if (!packaged.ok) return;

      const executablePath = browserExecutable();
      const browser = await chromium.launch({
        headless: true,
        ...(executablePath === undefined ? {} : { executablePath }),
        args: [
          '--force-color-profile=srgb',
          '--force-device-scale-factor=1',
          ...(process.platform === 'win32'
            ? ['--disable-gpu-compositing', '--disable-accelerated-2d-canvas']
            : []),
        ],
        chromiumSandbox: true,
      });
      const page = await browser.newPage({
        serviceWorkers: 'block',
        viewport: { width: 640, height: 480 },
      });
      const requests: string[] = [];
      const failed: string[] = [];
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      page.on('requestfailed', (request) =>
        failed.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`),
      );
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      try {
        await page.goto(pathToFileURL(output).href, { waitUntil: 'load', timeout: 120_000 });
        try {
          await page.waitForFunction(
            () => document.documentElement.dataset.workerReady !== undefined,
            undefined,
            { timeout: 15_000 },
          );
        } catch (cause) {
          const state = await page.evaluate(() => ({
            dataset: { ...document.documentElement.dataset },
            singleHtml: (
              globalThis as typeof globalThis & {
                __forgeaxSingleHtml?: { witness?: () => unknown };
              }
            ).__forgeaxSingleHtml?.witness?.(),
          }));
          throw new Error(
            `worker fixture did not become ready: ${cause instanceof Error ? cause.message : String(cause)}; state=${JSON.stringify(state)}; consoleErrors=${JSON.stringify(consoleErrors)}; pageErrors=${JSON.stringify(pageErrors)}`,
          );
        }
        const witness = await page.evaluate(() => ({
          lazy: document.documentElement.dataset.lazyValue,
          ready: document.documentElement.dataset.forgeaxSingleHtmlReady,
          gameReady: document.documentElement.dataset.forgeaxGameReady,
          worker: JSON.parse(document.documentElement.dataset.workerReady ?? '{}'),
          canvas: (() => {
            const canvas = document.querySelector('canvas');
            const context = canvas?.getContext('2d');
            const pixels =
              context?.getImageData(0, 0, canvas?.width ?? 0, canvas?.height ?? 0).data ??
              new Uint8ClampedArray();
            return {
              width: canvas?.width ?? 0,
              height: canvas?.height ?? 0,
              varying: new Set([...pixels].filter((_, index) => index % 4 !== 3)).size,
            };
          })(),
          singleHtml: (
            globalThis as typeof globalThis & {
              __forgeaxSingleHtml?: { witness?: () => Readonly<Record<string, unknown>> };
            }
          ).__forgeaxSingleHtml?.witness?.(),
        }));
        expect(witness.lazy).toBe('42');
        expect(witness.ready).toBe('true');
        expect(witness.gameReady).toBe('true');
        expect(witness.worker).toMatchObject({
          data: 'pack-ready',
          shader: expect.stringContaining('@fragment'),
          wasm: 0,
          nested: 'pack-ready',
        });
        expect(witness.canvas).toMatchObject({ width: 64, height: 64 });
        expect(witness.canvas.varying).toBeGreaterThan(2);
        expect(witness.singleHtml).toMatchObject({
          ready: true,
          resourceMisses: [],
          externalRequests: [],
        });
        expect(witness.singleHtml?.resourceHits).toBeGreaterThan(0);
        expect(requests.filter((url) => /^https?:/i.test(url))).toEqual([]);
        expect(failed).toEqual([]);
        expect(consoleErrors).toEqual([]);
        expect(requests.filter((url) => !url.startsWith('blob:'))).toEqual([
          pathToFileURL(output).href,
        ]);
        const unavailable = await page.evaluate(async () => {
          const probe = globalThis as typeof globalThis & {
            loadOptionalHost: () => Promise<unknown>;
            __forgeaxSingleHtml: { witness: () => { resourceMisses: unknown[] } };
          };
          const error = await probe.loadOptionalHost().then(
            () => 'unexpected success',
            (cause: unknown) => String(cause),
          );
          return { error, misses: probe.__forgeaxSingleHtml.witness().resourceMisses };
        });
        expect(unavailable.error).toContain('single-html');
        expect(unavailable.misses).toEqual([
          { kind: 'import', specifier: '@fixture/node-only-server', realm: 'main' },
        ]);
        expect(requests.filter((url) => /^https?:/i.test(url))).toEqual([]);
      } finally {
        await page.close();
        await browser.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
  it('opens a large single-html resource without decoding it during bootstrap', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-large-runtime-e2e-'));
    const dist = resolve(root, 'dist');
    const output = resolve(root, 'release', 'large-runtime.html');
    const large = Buffer.allocUnsafe(32 * 1024 * 1024);
    for (let index = 0; index < large.length; index += 1) {
      large[index] = (index * 17 + 23) & 0xff;
    }
    await mkdir(dist, { recursive: true });
    try {
      await Promise.all([
        writeFile(resolve(dist, 'index.html'), '<!doctype html><html><body></body></html>'),
        writeFile(resolve(dist, 'large.bin'), large),
        writeFile(resolve(dist, 'forgeax-dist.json'), '{}\n'),
      ]);
      const manifest: DistManifest = {
        schemaVersion: '1.0.0',
        project: { id: 'single-html-large-runtime-e2e', name: 'Single HTML Large Runtime E2E' },
        base: './',
        runtime: { packIndexUrl: 'large.bin', shaderManifestUrl: 'large.bin' },
        artifacts: [
          {
            path: 'large.bin',
            mediaType: 'application/octet-stream',
            bytes: large.byteLength,
            sha256: '',
          },
        ],
      };
      const packaged = await writeSingleHtml({
        distRoot: dist,
        output,
        manifest,
        bundle: {
          entrySource: "document.documentElement.dataset.largeRuntimeEntry = 'true';",
          artifacts: [],
        },
      });
      expect(packaged.ok).toBe(true);
      if (!packaged.ok) return;
      expect(packaged.value.html.bytes).toBeGreaterThan(40 * 1024 * 1024);

      const executablePath = browserExecutable();
      const browser = await chromium.launch({
        headless: true,
        ...(executablePath === undefined ? {} : { executablePath }),
        args: ['--force-color-profile=srgb', '--force-device-scale-factor=1'],
        chromiumSandbox: true,
      });
      const page = await browser.newPage({ serviceWorkers: 'block' });
      const requests: string[] = [];
      const failed: string[] = [];
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      page.on('requestfailed', (request) =>
        failed.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`),
      );
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      try {
        await page.goto(pathToFileURL(output).href, { waitUntil: 'load', timeout: 120_000 });
        await page.waitForFunction(
          () => document.documentElement.dataset.forgeaxSingleHtmlReady === 'true',
          undefined,
          { timeout: 15_000 },
        );
        const witness = await page.evaluate(() => ({
          entry: document.documentElement.dataset.largeRuntimeEntry,
          singleHtml: (
            globalThis as typeof globalThis & {
              __forgeaxSingleHtml?: { witness?: () => Readonly<Record<string, unknown>> };
            }
          ).__forgeaxSingleHtml?.witness?.(),
        }));
        expect(witness.entry).toBe('true');
        expect(witness.singleHtml).toMatchObject({
          ready: true,
          resourceHits: 0,
          resourceMisses: [],
          externalRequests: [],
        });
        expect(requests.filter((url) => /^https?:/i.test(url))).toEqual([]);
        expect(requests.filter((url) => /^file:/i.test(url))).toEqual([pathToFileURL(output).href]);
        expect(failed).toEqual([]);
        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
      } finally {
        await page.close();
        await browser.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('closes static Worker module graphs before Blob import', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-static-graph-e2e-'));
    const dist = resolve(root, 'dist');
    const output = resolve(root, 'release', 'static-graph.html');
    await mkdir(resolve(dist, 'assets'), { recursive: true });
    await mkdir(resolve(dist, 'decoy'), { recursive: true });
    try {
      await Promise.all([
        writeFile(
          resolve(dist, 'index.html'),
          '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>',
        ),
        writeFile(
          resolve(dist, 'main.js'),
          `const worker = new Worker(new URL('./execution-bootstrap.js', import.meta.url), { type: 'module' });
worker.onmessage = (event) => {
  if (event.data?.kind === 'static-ready') {
    document.documentElement.dataset.staticGraphReady = JSON.stringify(event.data);
  }
};
worker.onerror = (event) => {
  document.documentElement.dataset.staticGraphError = event.message || 'worker-error';
};
worker.postMessage({ run: true });
`,
        ),
        writeFile(
          resolve(dist, 'execution-bootstrap.js'),
          `import { loadValue } from './assets/loader.js';
self.onmessage = async (event) => {
  if (event.data?.run) self.postMessage({ kind: 'static-ready', value: await loadValue() });
};
`,
        ),
        writeFile(
          resolve(dist, 'assets/loader.js'),
          `export { loadValue } from './re-export.js';
`,
        ),
        writeFile(
          resolve(dist, 'assets/re-export.js'),
          `export const loadValue = async () => 41 + (await globalThis.__forgeaxImport('./lazy.js')).lazyValue;
`,
        ),
        writeFile(resolve(dist, 'assets/lazy.js'), 'export const lazyValue = 1;\n'),
        writeFile(resolve(dist, 'decoy/loader.js'), 'export const loadValue = async () => 1000;\n'),
        writeFile(resolve(dist, 'decoy/lazy.js'), 'export const lazyValue = 99;\n'),
        writeFile(resolve(dist, 'forgeax-dist.json'), '{}\n'),
      ]);
      const manifest: DistManifest = {
        schemaVersion: '1.0.0',
        project: { id: 'single-html-static-graph-e2e', name: 'Single HTML Static Graph E2E' },
        base: './',
        runtime: { packIndexUrl: 'pack-index.json', shaderManifestUrl: 'shaders/manifest.json' },
        artifacts: [
          'main.js',
          'execution-bootstrap.js',
          'assets/loader.js',
          'assets/re-export.js',
          'assets/lazy.js',
          'decoy/loader.js',
          'decoy/lazy.js',
        ].map((path) => ({ path, mediaType: 'text/javascript', bytes: 0, sha256: '' })),
      };
      const indexHtml = await readFile(resolve(dist, 'index.html'), 'utf8');
      const bundle = await bundleSingleHtmlEntry(dist, indexHtml);
      expect(bundle.ok).toBe(true);
      if (!bundle.ok) return;
      expect(
        bundle.value.artifacts.some(
          ({ path }) =>
            path.startsWith('__forgeax-bundle/') &&
            /(?:^|\/)execution-bootstrap(?:-[^/]+)?\.js$/i.test(path),
        ),
      ).toBe(true);
      const packaged = await writeSingleHtml({
        distRoot: dist,
        output,
        manifest,
        bundle: bundle.value,
      });
      expect(packaged.ok).toBe(true);
      if (!packaged.ok) return;

      const executablePath = browserExecutable();
      const browser = await chromium.launch({
        headless: true,
        ...(executablePath === undefined ? {} : { executablePath }),
        args: ['--force-color-profile=srgb', '--force-device-scale-factor=1'],
        chromiumSandbox: true,
      });
      const page = await browser.newPage({ serviceWorkers: 'block' });
      const requests: string[] = [];
      const failed: string[] = [];
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      page.on('requestfailed', (request) =>
        failed.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`),
      );
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      try {
        await page.goto(pathToFileURL(output).href, { waitUntil: 'load', timeout: 120_000 });
        await page.waitForFunction(
          () =>
            document.documentElement.dataset.staticGraphReady !== undefined ||
            document.documentElement.dataset.staticGraphError !== undefined,
          undefined,
          { timeout: 15_000 },
        );
        const result = await page.evaluate(() => ({ ...document.documentElement.dataset }));
        expect(result.staticGraphError).toBeUndefined();
        expect(JSON.parse(result.staticGraphReady ?? '{}')).toEqual({
          kind: 'static-ready',
          value: 42,
        });
        expect(requests.filter((url) => /^https?:/i.test(url))).toEqual([]);
        expect(failed).toEqual([]);
        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
      } finally {
        await page.close();
        await browser.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('consumes Worker broker control frames before game listeners', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-control-frame-e2e-'));
    const dist = resolve(root, 'dist');
    const output = resolve(root, 'release', 'control-frame.html');
    await mkdir(dist, { recursive: true });
    try {
      await Promise.all([
        writeFile(
          resolve(dist, 'index.html'),
          '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>',
        ),
        writeFile(
          resolve(dist, 'main.js'),
          `globalThis.controlFrameEvents = [];
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.addEventListener('message', (event) => {
  controlFrameEvents.push({ listener: 'capture', data: event.data });
}, { capture: true });
worker.onmessage = (event) => {
  controlFrameEvents.push({ listener: 'onmessage', data: event.data });
  if (event.data === 'game-response') document.documentElement.dataset.controlFrameReady = 'true';
};
worker.postMessage('game-request');
`,
        ),
        writeFile(
          resolve(dist, 'worker.js'),
          `self.onmessage = async (event) => {
  if (event.data !== 'game-request') return;
  await fetch('./data.json').then((response) => response.text());
  self.postMessage('game-response');
};
`,
        ),
        writeFile(resolve(dist, 'data.json'), '{"ready":true}\n'),
        writeFile(resolve(dist, 'forgeax-dist.json'), '{}\n'),
      ]);
      const manifest: DistManifest = {
        schemaVersion: '1.0.0',
        project: { id: 'single-html-control-frame-e2e', name: 'Single HTML Control Frame E2E' },
        base: './',
        runtime: { packIndexUrl: 'pack-index.json', shaderManifestUrl: 'shaders/manifest.json' },
        artifacts: [
          { path: 'main.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
          { path: 'worker.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
          { path: 'data.json', mediaType: 'application/json', bytes: 0, sha256: '' },
        ],
      };
      const indexHtml = await readFile(resolve(dist, 'index.html'), 'utf8');
      const bundle = await bundleSingleHtmlEntry(dist, indexHtml);
      expect(bundle.ok).toBe(true);
      if (!bundle.ok) return;
      const packaged = await writeSingleHtml({
        distRoot: dist,
        output,
        manifest,
        bundle: bundle.value,
      });
      expect(packaged.ok).toBe(true);
      if (!packaged.ok) return;

      const executablePath = browserExecutable();
      const browser = await chromium.launch({
        headless: true,
        ...(executablePath === undefined ? {} : { executablePath }),
        args: ['--force-color-profile=srgb', '--force-device-scale-factor=1'],
        chromiumSandbox: true,
      });
      const page = await browser.newPage({ serviceWorkers: 'block' });
      const failed: string[] = [];
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('requestfailed', (request) =>
        failed.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`),
      );
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      try {
        await page.goto(pathToFileURL(output).href, { waitUntil: 'load', timeout: 120_000 });
        await page.waitForFunction(
          () => document.documentElement.dataset.controlFrameReady === 'true',
          undefined,
          { timeout: 15_000 },
        );
        const events = await page.evaluate(() => {
          const pageGlobal = globalThis as typeof globalThis & {
            controlFrameEvents?: ReadonlyArray<{
              readonly listener?: string;
              readonly data?: unknown;
            }>;
          };
          return pageGlobal.controlFrameEvents ?? [];
        });
        expect(events).toEqual([
          { listener: 'capture', data: 'game-response' },
          { listener: 'onmessage', data: 'game-response' },
        ]);
        expect(failed).toEqual([]);
        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
      } finally {
        await page.close();
        await browser.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('fences packaged worker messages until module evaluation and replays FIFO once', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-worker-fence-e2e-'));
    const dist = resolve(root, 'dist');
    const output = resolve(root, 'release', 'worker-fence.html');
    await mkdir(resolve(dist, 'assets'), { recursive: true });
    try {
      await Promise.all([
        writeFile(
          resolve(dist, 'index.html'),
          '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>',
        ),
        writeFile(
          resolve(dist, 'main.js'),
          `const events = [];
globalThis.__forgeaxWorkerFenceEvents = events;
const workerPath = './message-fence-worker.js';
const worker = new Worker(new URL(workerPath, import.meta.url), { type: 'module' });
worker.onmessage = (event) => {
  events.push(event.data);
  if (event.data?.kind === 'module-started') {
    worker.postMessage({ kind: 'queued', value: 'first' });
    worker.postMessage({ kind: 'queued', value: 'second' });
  }
  if (event.data?.kind === 'module-complete') worker.postMessage({ kind: 'post-ready', value: 'after' });
  if (event.data?.kind === 'done') document.documentElement.dataset.messageFenceReady = 'true';
};
`,
        ),
        writeFile(
          resolve(dist, 'message-fence-worker.js'),
          `const report = (listener, event) => {
  if (event.data?.kind !== 'queued' && event.data?.kind !== 'post-ready') return;
  postMessage({ kind: 'delivery', listener, value: event.data.value });
  if (listener === 'onmessage' && event.data.value === 'after') postMessage({ kind: 'done' });
};
addEventListener('message', (event) => report('capture', event), { capture: true });
onmessage = (event) => report('onmessage', event);
postMessage({ kind: 'module-started' });
await new Promise((resolve) => setTimeout(resolve, 250));
postMessage({ kind: 'module-complete' });
`,
        ),
        writeFile(resolve(dist, 'forgeax-dist.json'), '{}\n'),
      ]);
      const artifacts: DistManifest['artifacts'] = [
        { path: 'main.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
        {
          path: 'message-fence-worker.js',
          mediaType: 'text/javascript',
          bytes: 0,
          sha256: '',
        },
      ];
      const manifest: DistManifest = {
        schemaVersion: '1.0.0',
        project: { id: 'single-html-worker-fence-e2e', name: 'Single HTML Worker Fence E2E' },
        base: './',
        runtime: { packIndexUrl: 'data.json', shaderManifestUrl: 'shader.wgsl' },
        artifacts,
      };
      const indexHtml = await readFile(resolve(dist, 'index.html'), 'utf8');
      const bundle = await bundleSingleHtmlEntry(dist, indexHtml);
      expect(bundle.ok).toBe(true);
      if (!bundle.ok) return;
      const packaged = await writeSingleHtml({
        distRoot: dist,
        output,
        manifest,
        bundle: bundle.value,
      });
      expect(packaged.ok).toBe(true);
      if (!packaged.ok) return;

      const executablePath = browserExecutable();
      const browser = await chromium.launch({
        headless: true,
        ...(executablePath === undefined ? {} : { executablePath }),
        args: ['--force-color-profile=srgb', '--force-device-scale-factor=1'],
        chromiumSandbox: true,
      });
      const page = await browser.newPage({ serviceWorkers: 'block' });
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      try {
        await page.goto(pathToFileURL(output).href, { waitUntil: 'load', timeout: 120_000 });
        await page.waitForFunction(
          () => document.documentElement.dataset.messageFenceReady === 'true',
          undefined,
          { timeout: 15_000 },
        );
        const events = await page.evaluate(() => {
          const pageGlobal = globalThis as typeof globalThis & {
            __forgeaxWorkerFenceEvents?: ReadonlyArray<{
              readonly kind?: string;
              readonly listener?: string;
              readonly value?: string;
            }>;
          };
          return pageGlobal.__forgeaxWorkerFenceEvents ?? [];
        });
        const completionIndex = events.findIndex((event) => event.kind === 'module-complete');
        const deliveryIndices = events.flatMap((event, index) =>
          event.kind === 'delivery' ? [index] : [],
        );
        expect(completionIndex).toBeGreaterThanOrEqual(0);
        expect(deliveryIndices.every((index) => index > completionIndex)).toBe(true);
        expect(
          events
            .filter((event) => event.kind === 'delivery')
            .map((event) => ({ listener: event.listener, value: event.value })),
        ).toEqual([
          { listener: 'capture', value: 'first' },
          { listener: 'onmessage', value: 'first' },
          { listener: 'capture', value: 'second' },
          { listener: 'onmessage', value: 'second' },
          { listener: 'capture', value: 'after' },
          { listener: 'onmessage', value: 'after' },
        ]);
        expect(events.filter((event) => event.kind === 'done')).toHaveLength(1);
        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
      } finally {
        await page.close();
        await browser.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
