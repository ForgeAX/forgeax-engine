import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserCarrierAdapter } from '../display-carrier.js';

const fixtures = vi.hoisted(() => {
  const capturePage = {
    on: vi.fn(),
    off: vi.fn(),
    goto: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    locator: vi.fn(),
    evaluate: vi.fn(async () => ({ ok: true, result: { captureId: 'capture-1' } })),
    screenshot: vi.fn(async () => Buffer.from('capture-png')),
    close: vi.fn(async () => undefined),
  };
  const replayPage = {
    on: vi.fn(),
    goto: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => ({
      ok: true,
      result: {
        actualCarrier: 'headed-private',
        operationTiming: {},
        trace: { events: [] },
        captureId: 'capture-1',
        drawCalls: 1,
        committedDrawIndex: 0,
        nonBlackPixels: 1,
        actionTrace: [],
        tape: {},
        profile: {},
        capturePng: { uri: 'data:image/png;base64,Yw==', width: 640, height: 360 },
        png: { uri: 'data:image/png;base64,cA==', width: 640, height: 360 },
        manifest: {
          identity: { runId: 'preview-1', snapshotDigest: 'sha256:test' },
          artifacts: [],
        },
        artifacts: [],
      },
    })),
    screenshot: vi.fn(async () => Buffer.from('replay-png')),
    close: vi.fn(async () => undefined),
  };
  const captureBrowser = {
    newPage: vi.fn(async () => capturePage),
    close: vi.fn(async () => undefined),
  };
  const replayBrowser = {
    newPage: vi.fn(async () => replayPage),
    close: vi.fn(async () => undefined),
  };
  let launchCount = 0;
  let borrowedSelected = false;
  const launch = vi.fn(async () =>
    borrowedSelected ? replayBrowser : launchCount++ === 0 ? captureBrowser : replayBrowser,
  );
  const server = {
    httpServer: {
      address: vi.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: 43125 })),
    },
    listen: vi.fn(async () => undefined),
    transformRequest: vi.fn(async () => ({ code: 'fixture' })),
    close: vi.fn(async () => undefined),
  };
  const createServer = vi.fn(async () => server);
  const createViteConfig = vi.fn(async () => ({}));
  const readProjectFacts = vi.fn(async (root: string) => ({
    ok: true as const,
    value: { root, projectId: 'fixture', packageManager: 'pnpm' },
  }));
  const target = {
    leaseId: 'preview-lease-1',
    targetId: 'preview-target-1',
    kind: 'browser-page',
    surfaceId: 'display-frame',
    run: { serviceId: 'preview-service-1', runId: 'preview-run-1' },
    generation: 4,
    width: 640,
    height: 360,
    gpu: 'auto' as const,
  };
  const release = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const select = vi.fn(async () => ({ carrier: 'borrowed' as const, target, release }));
  const attach = vi.fn(async () => ({
    page: capturePage,
    target,
    execution: { kind: 'page' as const, ownerPage: capturePage, realm: capturePage },
    close,
  }));
  const adapter = {
    select,
    attach,
  } as unknown as BrowserCarrierAdapter;
  const reset = () => {
    launchCount = 0;
    borrowedSelected = false;
    for (const mock of [
      capturePage.on,
      capturePage.off,
      capturePage.goto,
      capturePage.waitForFunction,
      capturePage.waitForTimeout,
      capturePage.locator,
      capturePage.evaluate,
      capturePage.screenshot,
      capturePage.close,
      replayPage.on,
      replayPage.goto,
      replayPage.waitForFunction,
      replayPage.evaluate,
      replayPage.screenshot,
      replayPage.close,
      captureBrowser.newPage,
      captureBrowser.close,
      replayBrowser.newPage,
      replayBrowser.close,
      launch,
      server.httpServer.address,
      server.listen,
      server.transformRequest,
      server.close,
      createServer,
      createViteConfig,
      readProjectFacts,
      select,
      attach,
      release,
      close,
    ])
      mock.mockClear();
  };
  select.mockImplementation(async () => {
    borrowedSelected = true;
    return { carrier: 'borrowed' as const, target, release };
  });
  return {
    capturePage,
    replayPage,
    captureBrowser,
    replayBrowser,
    launch,
    server,
    createServer,
    createViteConfig,
    readProjectFacts,
    target,
    release,
    close,
    select,
    attach,
    adapter,
    reset,
  };
});

vi.mock('playwright', () => ({ chromium: { launch: fixtures.launch } }));
vi.mock('vite', () => ({ createServer: fixtures.createServer }));
vi.mock('../../host.js', () => ({ createViteConfig: fixtures.createViteConfig }));
vi.mock('../../project.js', () => ({ readProjectFacts: fixtures.readProjectFacts }));
vi.mock('@forgeax/engine-preview', () => ({ createResourcePreviewReport: vi.fn() }));
vi.mock('@forgeax/engine-tool-runtime', () => ({
  createPreviewArtifactManifest: vi.fn((value) => value),
  validatePreviewArtifactManifest: vi.fn(() => ({ ok: true, value: {} })),
}));

import { runBrowserPreviewHost } from '../browser-host.js';

afterEach(() => {
  fixtures.reset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-browser-host-carrier-'));
  await mkdir(join(root, '.forgeax'), { recursive: true });
  return root;
}

const recipe = {
  presentation: 'visible',
  viewport: { width: 640, height: 360 },
  frames: 1,
} as never;
const snapshot = { revision: 1, digest: 'sha256:test' } as never;

describe('one-shot Browser Host borrowed carrier boundary', () => {
  it.each([
    undefined,
    'chrome-beta',
  ])('uses shared browser discovery unless channel is explicit: %s', async (channel) => {
    const root = await fixtureRoot();
    const executable = join(root, 'installed-chromium');
    await writeFile(executable, 'fixture browser');
    vi.stubEnv('FORGEAX_BROWSER_EXECUTABLE', executable);
    vi.stubEnv('FORGEAX_CHROME_CHANNEL', channel);
    try {
      const result = await runBrowserPreviewHost(
        root,
        recipe,
        snapshot,
        'preview-1',
        new AbortController().signal,
        'project-bootstrap',
        undefined,
        { publish: false },
      );
      expect(result.ok).toBe(true);
      expect(fixtures.launch).toHaveBeenCalledTimes(2);
      for (const [options] of fixtures.launch.mock.calls as unknown as [
        Record<string, unknown>,
      ][]) {
        if (channel === undefined) {
          expect(options.executablePath).toBe(executable);
          expect(options.channel).toBeUndefined();
        } else {
          expect(options.channel).toBe(channel);
          expect(options.executablePath).toBeUndefined();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('observes and captures the borrowed page, keeps replay private, and releases one lease', async () => {
    const root = await fixtureRoot();
    try {
      const result = await runBrowserPreviewHost(
        root,
        recipe,
        snapshot,
        'preview-1',
        new AbortController().signal,
        'project-bootstrap',
        undefined,
        {
          publish: false,
          carrier: fixtures.adapter,
          carrierRun: fixtures.target.run,
          carrierGeneration: fixtures.target.generation,
        },
      );
      expect(result).toMatchObject({
        ok: true,
        value: { actualCarrier: 'visible-consumer', carrierTarget: fixtures.target },
      });
      expect(fixtures.adapter.select).toHaveBeenCalledWith(
        expect.objectContaining({
          run: fixtures.target.run,
          generation: fixtures.target.generation,
          headless: false,
          gpu: 'auto',
          width: 640,
          height: 360,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(fixtures.adapter.attach).toHaveBeenCalledTimes(1);
      expect(fixtures.launch).toHaveBeenCalledTimes(1);
      expect(fixtures.capturePage.goto).toHaveBeenCalledWith(
        expect.stringContaining('forgeax-tool-run-id=preview-1'),
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );
      expect(fixtures.capturePage.close).not.toHaveBeenCalled();
      expect(fixtures.close).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to private headed capture with the carrier reason', async () => {
    const root = await fixtureRoot();
    const fallback = {
      select: vi.fn(async () => ({
        carrier: 'private-browser' as const,
        fallbackReason: 'view-busy',
      })),
      attach: vi.fn(),
    } as unknown as BrowserCarrierAdapter;
    try {
      const result = await runBrowserPreviewHost(
        root,
        recipe,
        snapshot,
        'preview-1',
        new AbortController().signal,
        'project-bootstrap',
        undefined,
        {
          publish: false,
          carrier: fallback,
          carrierRun: fixtures.target.run,
          carrierGeneration: fixtures.target.generation,
        },
      );
      expect(result).toMatchObject({
        ok: true,
        value: { actualCarrier: 'headed-private', carrierFallbackReason: 'view-busy' },
      });
      expect(fallback.attach).not.toHaveBeenCalled();
      expect(fixtures.launch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses the Engine canvas image for resource previews', async () => {
    const root = await fixtureRoot();
    fixtures.capturePage.evaluate.mockResolvedValueOnce({
      ok: true,
      result: {
        captureId: 'capture-resource-1',
        capturePng: { uri: 'data:image/png;base64,Yw==', width: 64, height: 64 },
      },
    } as never);
    try {
      const result = await runBrowserPreviewHost(
        root,
        { presentation: 'hidden', viewport: { width: 640, height: 360 }, frames: 1 } as never,
        snapshot,
        'preview-resource-1',
        new AbortController().signal,
        'resource-bootstrap',
        { kind: 'mesh', guid: 'mesh-1', size: 64 },
        { publish: false },
      );
      expect(result).toMatchObject({ ok: true });
      expect(fixtures.capturePage.screenshot).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the complete capture when a skinned material capability is reported as a page error', async () => {
    const root = await fixtureRoot();
    fixtures.capturePage.on.mockImplementationOnce(() => undefined);
    fixtures.capturePage.on.mockImplementationOnce(
      (_event: string, listener: (message: unknown) => void) => {
        listener({
          type: () => 'error',
          text: () =>
            '[RenderSystem.extract (material-skin-attr-missing)] MaterialSkinAttrMissingError: missing skin attributes',
          location: () => ({ url: '' }),
        });
      },
    );
    fixtures.capturePage.on.mockImplementationOnce(() => undefined);
    fixtures.capturePage.evaluate.mockImplementationOnce(async () => ({
      ok: true,
      result: {
        recipe,
        snapshot,
        trace: { events: ['renderer-created', 'world-updated', 'draw-submitted'] },
        captureId: 'capture-skin-1',
        actionTrace: [],
        tape: {
          runId: 'preview-skin-1',
          jsonUri: 'data:application/octet-stream;base64,Yw==',
          blobUri: 'data:application/octet-stream;base64,Yg==',
          byteLength: 1,
        },
        profile: {
          captureId: 'profile-skin-1',
          uri: 'data:application/json;base64,e30=',
        },
        capturePng: { uri: 'data:image/png;base64,Yw==', width: 640, height: 360 },
        executeDurationMs: 1,
        captureDurationMs: 1,
        appErrors: [],
      },
    }));
    try {
      const result = await runBrowserPreviewHost(
        root,
        recipe,
        snapshot,
        'preview-skin-1',
        new AbortController().signal,
        'resource-bootstrap',
        { kind: 'material', guid: 'material-skin-1', size: 64 },
        { publish: false },
      );
      expect(result).toMatchObject({
        ok: true,
        value: { capabilityFailure: { code: 'tool-preview-capability-unavailable' } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps unrelated page errors fatal beside a known skin capability error', async () => {
    const root = await fixtureRoot();
    fixtures.capturePage.on.mockImplementationOnce(() => undefined);
    fixtures.capturePage.on.mockImplementationOnce(
      (_event: string, listener: (message: unknown) => void) => {
        const makeMessage = (text: string) => ({
          type: () => 'error',
          text: () => text,
          location: () => ({ url: '' }),
        });
        listener(
          makeMessage(
            '[RenderSystem.extract (material-skin-attr-missing)] MaterialSkinAttrMissingError: missing skin attributes',
          ),
        );
        listener(makeMessage('unrelated preview page failure'));
      },
    );
    fixtures.capturePage.on.mockImplementationOnce(() => undefined);
    try {
      const result = await runBrowserPreviewHost(
        root,
        recipe,
        snapshot,
        'preview-skin-mixed-1',
        new AbortController().signal,
        'resource-bootstrap',
        { kind: 'material', guid: 'material-skin-mixed-1', size: 64 },
        { publish: false },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'tool-preview-browser-host-failed',
          detail: { phase: 'capture-page-runtime' },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the borrowed execution frame for navigation, host evaluation, and capture', async () => {
    const root = await fixtureRoot();
    const frameScreenshot = vi.fn(async () => Buffer.from('frame-capture-png'));
    fixtures.capturePage.locator.mockReturnValue({
      count: vi.fn(async () => 1),
      elementHandle: vi.fn(async () => ({
        evaluate: vi.fn(async () => ({
          tagName: 'IFRAME',
          id: 'display-frame',
          leaseId: fixtures.target.leaseId,
          generation: String(fixtures.target.generation),
        })),
        contentFrame: vi.fn(async () => frame),
        dispose: vi.fn(async () => undefined),
      })),
      screenshot: frameScreenshot,
    });
    const frame = {
      goto: vi.fn(async () => undefined),
      waitForFunction: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => ({ ok: true, result: { captureId: 'capture-frame-1' } })),
      locator: vi.fn(() => ({ screenshot: frameScreenshot })),
      waitForTimeout: vi.fn(async () => undefined),
      page: vi.fn(() => fixtures.capturePage),
    };
    fixtures.attach.mockImplementationOnce(
      async () =>
        ({
          page: fixtures.capturePage,
          target: fixtures.target,
          execution: {
            kind: 'frame' as const,
            ownerPage: fixtures.capturePage,
            realm: frame,
            surfaceSelector: '#display-frame',
          },
          close: fixtures.close,
        }) as never,
    );
    try {
      const result = await runBrowserPreviewHost(
        root,
        recipe,
        snapshot,
        'preview-frame-1',
        new AbortController().signal,
        'project-bootstrap',
        undefined,
        {
          publish: false,
          carrier: fixtures.adapter,
          carrierRun: fixtures.target.run,
          carrierGeneration: fixtures.target.generation,
        },
      );
      expect(result).toMatchObject({ ok: true });
      expect(frame.goto).toHaveBeenCalledWith(
        expect.stringContaining('forgeax-tool-run-id=preview-frame-1'),
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );
      expect(frame.evaluate).toHaveBeenCalled();
      expect(frameScreenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
      expect(fixtures.capturePage.goto).not.toHaveBeenCalled();
      expect(
        (fixtures.capturePage.evaluate.mock.calls as unknown as Array<[unknown]>).some(
          ([callback]) => String(callback).includes('__forgeaxToolHost'),
        ),
      ).toBe(false);
      expect(fixtures.capturePage.screenshot).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
