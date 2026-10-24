import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { afterEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => {
  let captureReady: string | null = null;
  let rootChildren = 1;
  let openShadowRoots = 1;
  let engineFrameId = 1;
  let canvasRendered = true;
  let adapterDevice = 'SwiftShader Device (LLVM)';
  let adapterAvailable = true;
  const canvasScreenshot = vi.fn(async (options?: { readonly style?: string }) => {
    const overlayHidden = options?.style?.includes('visibility: hidden') === true;
    return Buffer.from(canvasRendered || !overlayHidden ? 'canvas-rendered' : 'canvas-black');
  });
  const page = {
    on: vi.fn(),
    off: vi.fn(),
    goto: vi.fn(),
    waitForFunction: vi.fn(async (_predicate: unknown, value: unknown) => {
      if (typeof value === 'string') captureReady = value;
    }),
    waitForTimeout: vi.fn(),
    screenshot: vi.fn(async (options?: { readonly style?: string }) =>
      options?.style ? canvasScreenshot(options) : Buffer.from('compositor-png'),
    ),
    locator: vi.fn((_selector?: string) => ({
      first: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 1280, height: 720 }) }),
    })),
    evaluate: vi.fn(async (callback: unknown) =>
      String(callback).includes('requestAdapter')
        ? {
            title: 'Persistent fixture',
            canvas: { width: 1280, height: 720 },
            domUi: { rootChildren, openShadowRoots, textWitness: rootChildren > 0 ? 'HUD' : '' },
            adapter: adapterAvailable ? { device: adapterDevice } : null,
            adapterError: adapterAvailable ? null : 'fixture adapter unavailable',
            engineFrameId,
            captureReady,
            fatalError: null,
            userAgent: 'Chrome Beta fixture',
          }
        : String(callback).includes('innerWidth')
          ? { width: 1280, height: 720 }
          : undefined,
    ),
  };
  const browser = {
    newPage: vi.fn(async () => page),
    version: vi.fn(() => '153.0.0.0'),
    close: vi.fn(),
  };
  const server = {
    resolvedUrls: { local: ['http://127.0.0.1:43123/'] },
    listen: vi.fn(),
    close: vi.fn(),
  };
  return {
    page,
    canvasScreenshot,
    browser,
    server,
    launch: vi.fn(async () => browser),
    createServer: vi.fn(async () => server),
    reset() {
      captureReady = null;
      rootChildren = 1;
      openShadowRoots = 1;
      engineFrameId = 1;
      canvasRendered = true;
      adapterDevice = 'SwiftShader Device (LLVM)';
      adapterAvailable = true;
      for (const mock of [
        page.on,
        page.off,
        page.goto,
        page.waitForFunction,
        page.waitForTimeout,
        page.screenshot,
        page.locator,
        canvasScreenshot,
        page.evaluate,
        browser.newPage,
        browser.version,
        browser.close,
        server.listen,
        server.close,
        this.launch,
        this.createServer,
      ]) {
        mock.mockClear();
      }
    },
    setUiWitness(nextRootChildren: number, nextOpenShadowRoots: number) {
      rootChildren = nextRootChildren;
      openShadowRoots = nextOpenShadowRoots;
    },
    setCanvasRendered(nextCanvasRendered: boolean) {
      canvasRendered = nextCanvasRendered;
    },
    setAdapterDevice(value: string) {
      adapterDevice = value;
    },
    setAdapterAvailable(value: boolean) {
      adapterAvailable = value;
    },
  };
});

vi.mock('playwright', () => ({ chromium: { launch: browserMocks.launch } }));
vi.mock('vite', () => ({ createServer: browserMocks.createServer }));
vi.mock('../host.js', () => ({ createViteConfig: vi.fn(async () => ({})) }));
vi.mock('@forgeax/engine-image/parse-image', () => ({
  parseImage: (encoded: Uint8Array) => {
    const bytes = new Uint8Array(16 * 16 * 4);
    const rendered = Buffer.from(encoded).toString() !== 'canvas-black';
    for (let index = 0; index < 16 * 16; index += 1) {
      const value = rendered && index % 2 === 0 ? 255 : 0;
      bytes.set([value, 255 - value, value, 255], index * 4);
    }
    return { ok: true, value: { bytes, width: 16, height: 16 } };
  },
}));

import { createBrowserCapture } from '../browser-capture.js';
import { createViteConfig } from '../host.js';
import type { BrowserCarrierAdapter } from '../tools/display-carrier.js';

afterEach(() => {
  browserMocks.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type PageHandler = (value: unknown) => void;
function pageHandler(event: string): PageHandler {
  const call = [...browserMocks.page.on.mock.calls].reverse().find(([name]) => name === event) as
    | [string, PageHandler]
    | undefined;
  if (call === undefined) throw new Error(`no ${event} listener`);
  return call[1];
}
function emitRequest(url: string, status: number | null): void {
  const request = {
    url: () => url,
    resourceType: () => 'fetch',
    frame: () => undefined,
    failure: () => null,
  };
  pageHandler('request')(request);
  if (status !== null)
    pageHandler('response')({
      request: () => request,
      status: () => status,
      frame: () => undefined,
    });
}

describe('software browser session', () => {
  it.each([
    { message: 'probe-script-failed', elapsedMs: 0 },
    { message: 'Execution context was destroyed', elapsedMs: 120_001 },
  ])('does not retry startup failure outside its navigation budget: $message', async ({
    message,
    elapsedMs,
  }) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-probe-failure-'));
    const executable = resolve(root, 'chrome');
    const capture = createBrowserCapture(root);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const failure = new Error(message);
    browserMocks.page.evaluate.mockImplementationOnce(async () => {
      clock.mockReturnValue(1_000 + elapsedMs);
      throw failure;
    });
    try {
      await Promise.all([
        writeFile(executable, ''),
        writeFile(
          resolve(root, 'forge.json'),
          JSON.stringify({ id: 'probe', name: 'Probe', schemaVersion: '3.0.0', roots: {} }),
        ),
        writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'probe' })),
      ]);
      await expect(capture.open({ browser: executable, headless: true })).rejects.toBe(failure);
      expect(browserMocks.page.evaluate).toHaveBeenCalledTimes(1);
      expect(browserMocks.browser.close).toHaveBeenCalledTimes(1);
    } finally {
      await capture.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a structured backend failure when auto has no adapter in either lane', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-no-adapter-'));
    const executable = resolve(root, 'chrome-beta');
    await Promise.all([
      writeFile(executable, ''),
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'no-adapter',
          name: 'No Adapter',
          schemaVersion: '3.0.0',
          roots: {},
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), `${JSON.stringify({ name: 'no-adapter' })}\n`),
    ]);
    browserMocks.setAdapterAvailable(false);
    const browser = createBrowserCapture(root);
    try {
      await expect(
        browser.open({ backend: 'auto', browser: executable, launchProfile: 'release' }),
      ).rejects.toMatchObject({
        code: 'browser-capture-backend-unavailable',
        detail: {
          requested: 'auto',
          actual: 'unknown',
          launchProfile: 'release',
          initialAdapterError: 'fixture adapter unavailable',
          fallbackAdapterError: 'fixture adapter unavailable',
        },
      });
      expect(browserMocks.launch).toHaveBeenCalledTimes(2);
      expect(browserMocks.browser.close).toHaveBeenCalledTimes(2);
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forwards the exact borrowed Host to its owned project server', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-capture-host-'));
    const executable = resolve(root, 'chrome');
    const backend = await createBackendHost();
    const host = { backend, pairs: [] };
    const capture = createBrowserCapture(root);
    try {
      await Promise.all([
        writeFile(executable, ''),
        writeFile(
          resolve(root, 'forge.json'),
          JSON.stringify({ id: 'bound', name: 'Bound', schemaVersion: '3.0.0', roots: {} }),
        ),
        writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'bound' })),
      ]);
      const session = await capture.open({ host, browser: executable, headless: false });
      expect(createViteConfig).toHaveBeenLastCalledWith(
        expect.anything(),
        'serve',
        '/',
        expect.objectContaining({ host }),
      );
      await session.close();
      const client = backend.transport.connect();
      expect(client.connected).toBe(true);
      client.close();
    } finally {
      await capture.close();
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps browser pointer-lock limitations observable without failing capture', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-pointer-lock-warning-'));
    const executable = resolve(root, 'chrome');
    await Promise.all([
      writeFile(executable, ''),
      writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({
          id: 'pointer-lock-warning',
          name: 'Pointer Lock Warning',
          schemaVersion: '3.0.0',
          roots: {},
        }),
      ),
      writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'pointer-lock-warning' })),
    ]);
    const capture = createBrowserCapture(root);
    try {
      const session = await capture.open({
        backend: 'auto',
        browser: executable,
        headless: true,
      });
      const consoleListener = browserMocks.page.on.mock.calls.find(
        ([event]) => event === 'console',
      )?.[1] as ((message: { type(): string; text(): string }) => void) | undefined;
      expect(consoleListener).toBeDefined();
      consoleListener?.({
        type: () => 'error',
        text: () =>
          'AppError: [AppError app-pointer-lock-failed] path: w3c; cause: WrongDocumentError: The root document of this element is not valid for pointer lock.',
      });
      expect(session.report()).toMatchObject({
        consoleErrors: [],
        inputWarnings: [expect.stringContaining('app-pointer-lock-failed')],
      });
      await session.close();
    } finally {
      await capture.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('opens a single-html candidate directly with the release launch profile', async () => {
    browserMocks.setAdapterDevice('Hardware adapter');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-browser-'));
    const executable = resolve(root, 'chrome-beta');
    const candidate = resolve(root, 'release', 'game-offline.html');
    await mkdir(resolve(root, 'release'), { recursive: true });
    await Promise.all([
      writeFile(executable, ''),
      writeFile(candidate, '<!doctype html><canvas></canvas>'),
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'single-html-browser-fixture',
          name: 'Single HTML Browser Fixture',
          schemaVersion: '3.0.0',
          roots: {},
        })}\n`,
      ),
      writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify({ name: 'single-html-browser-fixture' })}\n`,
      ),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    ]);

    const browser = createBrowserCapture(root);
    const session = await browser.open({
      target: { kind: 'single-html', path: candidate },
      launchProfile: 'release',
      backend: 'hardware',
      browser: executable,
    });
    try {
      expect(browserMocks.createServer).not.toHaveBeenCalled();
      expect(browserMocks.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.not.arrayContaining(['--enable-unsafe-webgpu']),
        }),
      );
      expect(browserMocks.page.goto).toHaveBeenCalledWith(
        pathToFileURL(candidate).href,
        expect.objectContaining({ waitUntil: 'domcontentloaded' }),
      );
      expect(session.report()).toMatchObject({
        target: { kind: 'single-html', path: candidate },
        launchProfile: 'release',
      });
      emitRequest(pathToFileURL(candidate).href, 200);
      emitRequest('https://cdn.example.com/font.woff2', 200);
      emitRequest(pathToFileURL(resolve(root, 'release', 'late.bin')).href, null);
    } finally {
      await session.close();
      await browser.close();
    }
    const report = JSON.parse(await readFile(session.reportPath, 'utf8'));
    expect(report.ok).toBe(false);
    expect(report.requests).toMatchObject({ total: 3, https: 1, pending: 1 });
    expect(report.requests.notable.map(({ url }: { url: string }) => url)).toEqual([
      'https://cdn.example.com/font.woff2',
      pathToFileURL(resolve(root, 'release', 'late.bin')).href,
    ]);
    expect(report.requests.entries).toHaveLength(3);
  });

  it('keeps one page alive across ordered named checkpoint captures', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-software-session-'));
    const executable = resolve(root, 'chrome-beta');
    await Promise.all([
      writeFile(executable, ''),
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'session-fixture',
          name: 'Session Fixture',
          schemaVersion: '3.0.0',
          roots: {},
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), `${JSON.stringify({ name: 'session-fixture' })}\n`),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    ]);

    const software = createBrowserCapture(root);
    const session = await software.open({
      backend: 'software',
      browser: executable,
      headless: false,
      deterministic: true,
      requireUi: true,
      runId: 'ordered-checkpoints',
    });
    expect(browserMocks.browser.newPage).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: null }),
    );
    expect(browserMocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.not.arrayContaining(['--force-device-scale-factor=1']),
      }),
    );

    emitRequest('http://127.0.0.1:43123/assets/ready.json', 200);
    emitRequest('http://127.0.0.1:43123/assets/hung.bin', null);
    const first = await session.capture('spawn');
    expect(browserMocks.browser.close).not.toHaveBeenCalled();
    const second = await session.capture('boss-hit');
    expect(browserMocks.browser.newPage).toHaveBeenCalledTimes(1);
    expect(browserMocks.page.screenshot).toHaveBeenCalledTimes(4);
    expect(browserMocks.canvasScreenshot).toHaveBeenCalledTimes(2);
    expect(first.output).toMatch(/001-spawn\.png$/);
    expect(second.output).toMatch(/002-boss-hit\.png$/);
    expect(session.report().captures.map((capture) => capture.checkpoint)).toEqual([
      'spawn',
      'boss-hit',
    ]);

    await session.close();
    expect(browserMocks.browser.close).toHaveBeenCalledTimes(1);
    expect(browserMocks.server.close).toHaveBeenCalledTimes(1);
    const report = JSON.parse(await readFile(session.reportPath, 'utf8'));
    expect(report.requests.entries).toBeUndefined();
    expect(report).toMatchObject({
      schemaVersion: '3.0.0',
      ok: true,
      runId: 'ordered-checkpoints',
      requests: {
        total: 2,
        failed: 0,
        resourceMisses: 0,
        pending: 1,
        notable: [{ url: 'http://127.0.0.1:43123/assets/hung.bin', status: null, failed: false }],
      },
      captures: [
        { index: 1, checkpoint: 'spawn', ok: true },
        { index: 2, checkpoint: 'boss-hit', ok: true },
      ],
    });

    const generic = createBrowserCapture(root);
    await expect(
      generic.open({ backend: 'hardware', browser: executable, requireUi: true }),
    ).rejects.toMatchObject({ code: 'browser-capture-backend-unavailable' });
    const autoSession = await generic.open({
      backend: 'auto',
      browser: executable,
      headless: true,
    });
    try {
      expect(browserMocks.launch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining([
            process.platform === 'win32'
              ? '--use-webgpu-adapter=swiftshader'
              : '--use-angle=swiftshader',
          ]),
        }),
      );
      expect(autoSession.report()).toMatchObject({
        backendRequested: 'auto',
        backend: 'software',
        fallbackReason: 'The browser selected a software adapter.',
      });
      expect(browserMocks.browser.newPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }),
      );
    } finally {
      await generic.close();
    }
  });

  it('does not treat ShadowRoots outside the game UI root as mounted game UI', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    browserMocks.setUiWitness(0, 15);
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-software-ui-witness-'));
    const executable = resolve(root, 'chrome-beta');
    await Promise.all([
      writeFile(executable, ''),
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'ui-witness-fixture',
          name: 'UI Witness Fixture',
          schemaVersion: '3.0.0',
          roots: {},
        })}\n`,
      ),
      writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify({ name: 'ui-witness-fixture' })}\n`,
      ),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    ]);

    const software = createBrowserCapture(root);
    const session = await software.open({
      backend: 'software',
      browser: executable,
      deterministic: true,
      requireUi: true,
    });
    try {
      await expect(session.capture('ready')).rejects.toMatchObject({
        code: 'browser-capture-runtime-failed',
      });
      expect(session.report().captures).toEqual([
        expect.objectContaining({
          ok: false,
          runtime: expect.objectContaining({
            domUi: { rootChildren: 0, openShadowRoots: 15, textWitness: '' },
          }),
        }),
      ]);
    } finally {
      await session.close();
    }
  });

  it('reserves full composition for the settled capture within its original budget', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    browserMocks.setCanvasRendered(false);
    const screenshot = browserMocks.page.screenshot.getMockImplementation();
    if (screenshot === undefined)
      throw new Error('The screenshot fixture requires an implementation');
    browserMocks.page.screenshot.mockImplementation(async (options) => {
      if (options?.style) return browserMocks.canvasScreenshot(options);
      // Model the measured expensive software compositor without a wall-clock sleep.
      now += 100;
      return Buffer.from('compositor-png');
    });
    browserMocks.page.waitForTimeout.mockImplementation(async () => {
      now += 1;
      browserMocks.setCanvasRendered(true);
    });
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-settled-composition-'));
    const executable = resolve(root, 'chrome-beta');
    await Promise.all([
      writeFile(executable, ''),
      writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({
          schemaVersion: '3.0.0',
          id: 'settled-capture',
          name: 'Settled',
          roots: {},
        }),
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"settled-capture"}'),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    ]);
    const browser = createBrowserCapture(root);
    try {
      const session = await browser.open({ backend: 'software', browser: executable });
      const capture = await session.capture(undefined, { timeoutMs: 150, waitMs: 10 });
      expect(capture.ok).toBe(true);
      expect(capture.pixels.rendered).toBe(true);
      expect(await readFile(capture.output, 'utf8')).toBe('compositor-png');
      expect(now).toBeLessThan(150);
      expect(
        browserMocks.page.screenshot.mock.calls.filter(([options]) => !options?.style),
      ).toHaveLength(1);
    } finally {
      await browser.close();
      browserMocks.page.screenshot.mockImplementation(screenshot);
      browserMocks.page.waitForTimeout.mockReset();
    }
  });

  it('does not treat visible page UI as proof that the game canvas rendered', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    browserMocks.page.waitForTimeout.mockImplementationOnce(async () => {
      now = 120_001;
    });
    vi.stubEnv('DISPLAY', ':fixture');
    browserMocks.setCanvasRendered(false);
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-software-canvas-witness-'));
    const executable = resolve(root, 'chrome-beta');
    await Promise.all([
      writeFile(executable, ''),
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'canvas-witness-fixture',
          name: 'Canvas Witness Fixture',
          schemaVersion: '3.0.0',
          roots: {},
        })}\n`,
      ),
      writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify({ name: 'canvas-witness-fixture' })}\n`,
      ),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    ]);

    const software = createBrowserCapture(root);
    const session = await software.open({
      backend: 'software',
      browser: executable,
      deterministic: true,
      requireUi: true,
    });
    try {
      await expect(session.capture('ready')).rejects.toMatchObject({
        code: 'browser-capture-runtime-failed',
      });
      expect(session.report().captures).toEqual([
        expect.objectContaining({
          ok: false,
          pixels: expect.objectContaining({ rendered: false }),
        }),
      ]);
      const observed = await session.capture('ready', { purpose: 'observe' });
      expect(observed).toMatchObject({ ok: true, pixels: { rendered: false } });
      expect(session.report().captures.map((capture) => capture.ok)).toEqual([false, true]);
      expect(browserMocks.page.screenshot).toHaveBeenCalled();
      expect(browserMocks.canvasScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({ style: expect.stringContaining('visibility: hidden') }),
      );
    } finally {
      await session.close();
    }
  });

  it('attaches an exact borrowed carrier page and releases only that lease', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-borrowed-carrier-'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({ id: 'borrowed-carrier-fixture', name: 'Borrowed carrier fixture', schemaVersion: '3.0.0', roots: {} })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"borrowed-carrier-fixture"}\n'),
    ]);
    const target = {
      leaseId: 'lease-1',
      targetId: 'target-7',
      kind: 'browser-page',
      surfaceId: 'surface-7',
      run: { serviceId: 'engine-service', runId: 'run-1' },
      generation: 3,
      width: 1280,
      height: 720,
      gpu: 'software' as const,
    };
    const close = vi.fn(async () => undefined);
    const carrier = {
      select: vi.fn(async (request: unknown) => {
        expect(request).toMatchObject({
          run: target.run,
          generation: target.generation,
          headless: false,
          gpu: 'software',
          width: target.width,
          height: target.height,
          url: 'http://127.0.0.1:43123/',
        });
        return { carrier: 'borrowed' as const, target, release: close };
      }),
      attach: vi.fn(async () => ({
        page: browserMocks.page,
        target,
        execution: {
          kind: 'page' as const,
          ownerPage: browserMocks.page,
          realm: browserMocks.page,
        },
        close,
      })),
    } as unknown as BrowserCarrierAdapter;
    const browser = createBrowserCapture(root);
    const session = await browser.open({
      backend: 'software',
      headless: false,
      serverUrl: 'http://127.0.0.1:43123/',
      carrier,
      carrierRun: target.run,
      carrierGeneration: target.generation,
    });
    try {
      expect(carrier.select).toHaveBeenCalledTimes(1);
      expect(carrier.attach).toHaveBeenCalledTimes(1);
      expect(browserMocks.launch).not.toHaveBeenCalled();
      expect(session.report()).toMatchObject({
        carrier: 'borrowed',
        carrierTarget: target,
        browser: { executable: 'borrowed-carrier' },
      });
    } finally {
      await session.close();
      expect(close).toHaveBeenCalledTimes(1);
      expect(browserMocks.page.off).toHaveBeenCalledTimes(5);
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps frame navigation scoped and clips its canvas from the owner compositor', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-borrowed-frame-'));
    const executable = resolve(root, 'chrome');
    await Promise.all([
      writeFile(executable, ''),
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({ id: 'borrowed-frame-fixture', name: 'Borrowed frame fixture', schemaVersion: '3.0.0', roots: {} })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"borrowed-frame-fixture"}\n'),
    ]);
    const target = {
      leaseId: 'lease-frame-1',
      targetId: 'target-frame-7',
      kind: 'view-iframe',
      surfaceId: 'display-frame',
      run: { serviceId: 'engine-service', runId: 'frame-run-1' },
      generation: 4,
      width: 320,
      height: 240,
      gpu: 'software' as const,
    };
    const frameSurfaceScreenshot = vi.fn(async () => Buffer.from('compositor-png'));
    const frame = {
      goto: vi.fn(async () => undefined),
      waitForFunction: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined),
      page: vi.fn(() => browserMocks.page),
      locator: vi.fn((selector: string) =>
        selector === 'canvas'
          ? {
              first: () => ({
                boundingBox: async () => ({ x: 120, y: 80, width: 320, height: 240 }),
              }),
            }
          : { screenshot: frameSurfaceScreenshot },
      ),
      evaluate: vi.fn(async (callback: unknown) =>
        String(callback).includes('requestAdapter')
          ? {
              title: 'Frame fixture',
              canvas: { width: 320, height: 240 },
              domUi: { rootChildren: 1, openShadowRoots: 1, textWitness: 'HUD' },
              adapter: { device: 'SwiftShader Frame Device' },
              adapterError: null,
              engineFrameId: 4,
              captureReady: 'true',
              fatalError: null,
              userAgent: 'Chrome Frame fixture',
            }
          : undefined,
      ),
    };
    browserMocks.page.locator.mockImplementation(
      (selector?: string) =>
        (selector === '#display-frame'
          ? {
              count: vi.fn(async () => 1),
              elementHandle: vi.fn(async () => ({
                evaluate: vi.fn(async () => ({
                  tagName: 'IFRAME',
                  id: 'display-frame',
                  leaseId: target.leaseId,
                  generation: String(target.generation),
                })),
                contentFrame: vi.fn(async () => frame),
                dispose: vi.fn(async () => undefined),
              })),
              screenshot: frameSurfaceScreenshot,
            }
          : {
              first: () => ({
                boundingBox: async () => ({ x: 0, y: 0, width: 1280, height: 720 }),
              }),
            }) as never,
    );
    const close = vi.fn(async () => undefined);
    const carrier = {
      select: vi.fn(async () => ({ carrier: 'borrowed' as const, target, release: close })),
      attach: vi.fn(async () => ({
        page: browserMocks.page,
        target,
        execution: {
          kind: 'frame' as const,
          ownerPage: browserMocks.page,
          realm: frame,
          surfaceSelector: '#display-frame',
        },
        close,
      })),
    } as unknown as BrowserCarrierAdapter;
    const browser = createBrowserCapture(root);
    const session = await browser.open({
      backend: 'software',
      browser: executable,
      headless: false,
      deterministic: true,
      width: target.width,
      height: target.height,
      serverUrl: 'http://127.0.0.1:43123/',
      carrier,
      carrierRun: target.run,
      carrierGeneration: target.generation,
    });
    try {
      expect(session.page).toBe(browserMocks.page);
      expect(frame.goto).toHaveBeenCalledWith(
        'http://127.0.0.1:43123/?forgeaxCapture=1',
        expect.objectContaining({ waitUntil: 'domcontentloaded' }),
      );
      expect(browserMocks.page.goto).not.toHaveBeenCalled();
      const capture = await session.capture('true');
      expect(capture.ok).toBe(true);
      expect(frameSurfaceScreenshot).toHaveBeenCalled();
      expect(browserMocks.page.screenshot).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          clip: { x: 120, y: 80, width: 320, height: 240 },
          style: expect.stringContaining('visibility: hidden'),
        }),
      );
    } finally {
      await session.close();
      expect(close).toHaveBeenCalledTimes(1);
      await browser.close();
      await rm(root, { recursive: true, force: true });
      browserMocks.page.locator.mockImplementation(
        () =>
          ({
            first: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 1280, height: 720 }) }),
          }) as never,
      );
    }
  });
});
