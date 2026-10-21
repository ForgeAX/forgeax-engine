import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { chromium } from 'playwright';

const falsifyCompanion = process.argv.includes('--falsify-companion');
const reloadBeforeCapture = process.argv.includes('--reload-before-capture');
const maxServerOutputChars = 8_000;
const MAX_SERVER_TIMEOUT_MS = 180_000;
const SERVER_TIMEOUT_MS = Math.min(
  Math.max(Number.parseInt(process.env.FORGEAX_PREVIEW_SERVER_TIMEOUT_MS ?? '180000', 10) || 180_000, 1),
  MAX_SERVER_TIMEOUT_MS,
);
const appDir = fileURLToPath(new URL('..', import.meta.url));
const viteBin = fileURLToPath(new URL('../../../node_modules/vite/bin/vite.js', import.meta.url));
const viteConfig = fileURLToPath(new URL('../vite.ui-authoring.config.ts', import.meta.url));
const port = await availablePort();
const server = spawn(process.execPath, [
  viteBin,
  '--config',
  viteConfig,
  '--host',
  '127.0.0.1',
  '--port',
  String(port),
  '--strictPort',
], {
  cwd: appDir,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
let serverError;
const appendServerOutput = (chunk) => {
  serverOutput = (serverOutput + String(chunk)).slice(-maxServerOutputChars);
};
server.stdout?.on('data', appendServerOutput);
server.stderr?.on('data', appendServerOutput);
server.once('error', (error) => {
  serverError = error;
});

async function stopServer(timeoutMs = 5_000) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function availablePort() {
  const probe = createServer();
  await once(probe.listen(0, '127.0.0.1'), 'listening');
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('preview smoke could not allocate a TCP port');
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForServer(origin) {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverError !== undefined) {
      throw new Error(
        `preview Vite server failed to start: ${serverError.message}; output: ${serverOutput.trim() || 'none'}`,
      );
    }
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(
        `preview Vite server exited before becoming ready (exit ${server.exitCode}, signal ${server.signalCode}; output: ${serverOutput.trim() || 'none'})`,
      );
    }
    try {
      await fetch(origin);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }
  throw new Error(
    `preview Vite server did not become ready within ${SERVER_TIMEOUT_MS}ms (output: ${serverOutput.trim() || 'none'})`,
  );
}

let browser;
try {
  const origin = `http://127.0.0.1:${port}`;
  await waitForServer(`${origin}/`);
  const chromeChannel = process.env.FORGEAX_CHROME_CHANNEL;
  const headless = process.env.FORGEAX_BROWSER_HEADLESS !== '0';
  browser = await chromium.launch({
    headless,
    ...(chromeChannel ? { channel: chromeChannel } : {}),
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
      '--autoplay-policy=no-user-gesture-required',
    ],
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
  const pageFailures = [];
  page.on('console', (message) => {
    if (message.type() === 'error') pageFailures.push(message.text());
  });
  page.on('pageerror', (error) => pageFailures.push(error.message));
  await page.goto(`${origin}/?game=empty`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(globalThis.__forgeaxUiAuthoring), null, { timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const host = globalThis.__forgeaxUiAuthoring;
      return Boolean(
        host?.discover().some((entry) => entry.guid.toLowerCase() === '019f8354-6386-4386-849d-f2ab4b96229d') ||
          document.querySelector('[data-forgeax-preview-engine-failure]'),
      );
    },
    null,
    { timeout: 30_000 },
  );
  let captureSequence = 0;
  const waitForPaint = async () => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.evaluate(() => document.fonts.ready);
  };
  const screenshotHash = (bytes) => {
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };
  const screenshotRenderable = async (scenario) => {
    const attempts = [];
    let previousSignature = null;
    let stableCaptures = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const captureToken = `ui-capture-${captureSequence++}`;
      await waitForPaint();
      await page.waitForFunction(
        async ({ scenario, captureToken }) => {
          const host = globalThis.__forgeaxUiAuthoring;
          if (!host) return false;
          if (!host.getCaptureTarget()) {
            const opened = await host.open(scenario);
            if (!opened.ok) throw new Error(`scenario failed: ${JSON.stringify(opened.error)}`);
          }
          const target = host.getCaptureTarget();
          if (!(target instanceof HTMLElement) || !target.isConnected) return false;
          const rect = target.getBoundingClientRect();
          if (rect.width !== 320 || rect.height !== 180) return false;
          const authoringRoot = target.closest('[data-ui-authoring-root]');
          if (!(authoringRoot instanceof HTMLElement)) return false;
          target.dataset.uiCaptureToken = captureToken;
          authoringRoot.dataset.uiCaptureRootToken = captureToken;
          authoringRoot.dataset.uiCaptureZIndex = authoringRoot.style.zIndex;
          authoringRoot.dataset.uiCaptureBackground = authoringRoot.style.backgroundColor;
          authoringRoot.style.zIndex = '2147483647';
          authoringRoot.style.backgroundColor = 'rgb(0, 0, 0)';
          return true;
        },
        { scenario, captureToken },
        { timeout: 30_000 },
      );
      try {
        const target = page.locator(`[data-ui-capture-token="${captureToken}"]`);
        const bytes = await target.screenshot({ animations: 'disabled' });
        const state = await page.evaluate((captureToken) => {
          const host = globalThis.__forgeaxUiAuthoring;
          const target = host?.getCaptureTarget();
          const root = host?.root;
          const rect = target?.getBoundingClientRect();
          return {
            token: captureToken,
            connected: target?.isConnected ?? false,
            rect: { width: rect?.width ?? 0, height: rect?.height ?? 0 },
            shadowChildren: target?.shadowRoot?.childElementCount ?? 0,
            captureTarget: target?.dataset.uiCaptureToken === captureToken,
            captureRoot: root?.dataset.uiCaptureRootToken === captureToken,
          };
        }, captureToken);
        if (state.connected && state.rect.width === 320 && state.rect.height === 180 && state.captureTarget && state.captureRoot) {
          const signature = `${bytes.length}:${screenshotHash(bytes)}`;
          attempts.push({ ...state, bytes: bytes.length, hash: signature });
          if (bytes.length >= 100) {
            stableCaptures = signature === previousSignature ? stableCaptures + 1 : 1;
            previousSignature = signature;
            if (stableCaptures >= 2) return bytes;
          }
        } else {
          attempts.push(state);
        }
      } catch (error) {
        attempts.push({ token: captureToken, state: error instanceof Error ? error.message : String(error) });
      } finally {
        await page.evaluate((captureToken) => {
          const host = globalThis.__forgeaxUiAuthoring;
          const captureTarget = host?.getCaptureTarget();
          if (captureTarget?.dataset.uiCaptureToken === captureToken) {
            delete captureTarget.dataset.uiCaptureToken;
          }
          const authoringRoot = host?.root;
          if (authoringRoot?.dataset.uiCaptureRootToken === captureToken) {
            authoringRoot.style.backgroundColor = authoringRoot.dataset.uiCaptureBackground ?? '';
            authoringRoot.style.zIndex = authoringRoot.dataset.uiCaptureZIndex ?? '';
            delete authoringRoot.dataset.uiCaptureBackground;
            delete authoringRoot.dataset.uiCaptureZIndex;
            delete authoringRoot.dataset.uiCaptureRootToken;
          }
        }, captureToken);
      }
    }
    throw new Error(
      `preview screenshot did not converge: ${JSON.stringify({ attempts, pageFailures })}`,
    );
  };
  const captureWithBytes = async (bytes, scenario) =>
    page.evaluate(async ({ pngBytes, scenario }) => {
      const host = globalThis.__forgeaxUiAuthoring;
      if (!host) throw new Error('preview authoring host is unavailable');
      if (!host.getCaptureTarget()) {
        const opened = await host.open(scenario);
        if (!opened.ok) throw new Error(`scenario failed: ${JSON.stringify(opened.error)}`);
      }
      const mountedHost = () => host.getCaptureTarget()?.shadowRoot;
      return host.capture({
        viewport: { width: 320, height: 180 },
        deviceScaleFactor: 1,
        readiness: async () => ({
          viewport: window.innerWidth === 320 && window.innerHeight === 180,
          deviceScale: window.devicePixelRatio === 1,
          fonts: document.fonts.status === 'loaded',
          resources: [...(mountedHost()?.querySelectorAll('img') ?? [])].every(
            (image) => image.complete && image.naturalWidth > 0,
          ),
          scenario: (mountedHost()?.querySelectorAll('[data-ui-scenario-ready]').length ?? 0) >= 2,
          clock: true,
          failures: { console: [], page: [], request: [] },
        }),
        freezeClock: async () => ({ ok: true, value: { timeMs: 1000 } }),
        screenshot: async () => new Uint8Array(pngBytes),
      });
    }, { pngBytes: Array.from(bytes), scenario });
  const setup = await page.evaluate(async ({ falsify }) => {
    const host = globalThis.__forgeaxUiAuthoring;
    if (!host) throw new Error('preview authoring host is unavailable');
    const discovered = host.discover();
    const selected = discovered.find((entry) => entry.guid.toLowerCase() === host.guid.toLowerCase());
    if (!selected || selected.guid === 'ui-preview-default' || !selected.sourcePath?.endsWith('preview-hud.ui.html')) {
      throw new Error(`authoring host did not select the real catalog UI source: ${JSON.stringify({ selected, discovered })}`);
    }
    const before = await host.validate();
    const opened = await host.open('default');
    if (!opened.ok) throw new Error(`default scenario failed: ${JSON.stringify({ error: opened.error, validation: before })}`);
    const invalid = await host.repair({ html: '<script>bad</script>', css: '' });
    if (invalid.ok) throw new Error('invalid authoring source unexpectedly passed');
    const failure = host.getLastRefreshError();
    if (!failure || failure.code !== 'preview-load-failed' || !failure.detail.diagnostics?.length) {
      throw new Error(`invalid edit did not fail the mounted session with diagnostics: ${JSON.stringify(failure)}`);
    }
    const repaired = await host.repair({
      html: '<section data-ui-part="root"><strong data-ui-part="score">Score 1</strong><span data-ui-part="stress-meter">Recovered</span><button type="button" data-ui-action="preview-action">Action</button></section>',
      css: ':host { display: block; color: white; font: 16px sans-serif; } section { display: grid; gap: 8px; padding: 12px; } button { width: max-content; pointer-events: auto; }',
    });
    if (!repaired.ok) throw new Error('repaired authoring source failed validation');
    const retried = await host.getSession()?.retry();
    if (!retried?.ok || host.getSession()?.state !== 'mounted') {
      throw new Error(`same-page retry did not remount the repaired source: ${JSON.stringify(retried)}`);
    }
    const action = host.getCaptureTarget()?.shadowRoot?.querySelector('[data-ui-action="preview-action"]');
    if (!(action instanceof HTMLElement)) throw new Error('repaired action control is missing');
    action.click();
    if (host.getLastAction() !== 'preview-action') throw new Error('repaired action did not recover');
    if (falsify) {
      const missingResource = await host.repair({
        html: '<section data-ui-part="root"><strong data-ui-part="score">Score 1</strong><span data-ui-part="stress-meter">Recovered</span><button type="button" data-ui-action="preview-action">Action</button><img alt="" /></section>',
        css: ':host { display: block; }',
      });
      if (!missingResource.ok) throw new Error('missing-resource falsification source failed validation');
      const rebuilt = await host.getSession()?.rebuild();
      if (!rebuilt?.ok || host.getSession()?.state !== 'mounted') {
        throw new Error(`missing-resource source did not remount for readiness falsification: ${JSON.stringify(rebuilt)}`);
      }
    }
    if (falsify) {
      return {
        initiallyValid: before.ok,
        invalidCode: failure.code,
        diagnostics: failure.detail.diagnostics,
        repaired: repaired.ok,
        retried: retried.ok,
        action: host.getLastAction(),
        selected,
        falsified: true,
      };
    }
    return {
      initiallyValid: before.ok,
      invalidCode: failure.code,
      diagnostics: failure.detail.diagnostics,
      repaired: repaired.ok,
      retried: retried.ok,
      action: host.getLastAction(),
      selected,
    };
  }, { falsify: falsifyCompanion });
  if (falsifyCompanion) {
    await waitForPaint();
    const failed = await captureWithBytes(new Uint8Array(), 'default');
    if (failed.ok || failed.error.code !== 'capture-not-ready') {
      throw new Error('companion falsification did not identify resources');
    }
    if (!failed.error.detail.unmet.includes('resources')) {
      throw new Error('companion falsification did not identify resources');
    }
    await page.evaluate(() => {
      const host = globalThis.__forgeaxUiAuthoring;
      host?.dispose();
      host?.dispose();
    });
    console.log(JSON.stringify({ ...setup, falsified: true, unmet: failed.error.detail.unmet }));
    await browser.close();
  } else {
    const captures = [];
    if (reloadBeforeCapture) {
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    await screenshotRenderable('default');
    for (let index = 0; index < 3; index += 1) {
      const bytes = await screenshotRenderable('default');
      captures.push(await captureWithBytes(bytes, 'default'));
    }
    if (captures.some((capture) => !capture.ok)) {
      throw new Error(`default capture failed: ${JSON.stringify(captures)}`);
    }
    const defaultBytes = captures.map((capture) =>
      capture.ok ? Array.from(capture.value.png) : [],
    );
    if (defaultBytes.some((bytes) => bytes.length < 100)) {
      throw new Error('real preview screenshot was unexpectedly tiny');
    }
    await page.evaluate(async () => {
      const host = globalThis.__forgeaxUiAuthoring;
      if (!host) throw new Error('preview authoring host is unavailable');
      const extreme = await host.open('extreme');
      if (!extreme.ok) throw new Error(`extreme scenario failed: ${extreme.error.code}`);
    });
    const extremeBytes = await screenshotRenderable('extreme');
    const extremeCapture = await captureWithBytes(extremeBytes, 'extreme');
    if (!extremeCapture.ok) throw new Error('extreme capture failed');
    const discovered = await page.evaluate(() => {
      const host = globalThis.__forgeaxUiAuthoring;
      if (!host) throw new Error('preview authoring host is unavailable');
      const value = host.discover();
      host.dispose();
      return value;
    });
    const report = {
      ...setup,
      defaultBytes,
      extremeEvidence: extremeCapture.value.evidence,
      discovered,
    };
    if (report.defaultBytes.some((bytes) => JSON.stringify(bytes) !== JSON.stringify(report.defaultBytes[0]))) {
      throw new Error('capture PNG bytes were not deterministic');
    }
    const selectedGuid = report.selected.guid.toLowerCase();
    if (
      !report.initiallyValid ||
      report.invalidCode !== 'preview-load-failed' ||
      !report.repaired ||
      !report.retried ||
      report.action !== 'preview-action' ||
      !report.discovered.some((entry) => entry.guid.toLowerCase() === selectedGuid)
    ) {
      throw new Error(
        `authoring smoke report failed: ${JSON.stringify({
          initiallyValid: report.initiallyValid,
          invalidCode: report.invalidCode,
          repaired: report.repaired,
          retried: report.retried,
          action: report.action,
          selected: report.selected,
          discovered: report.discovered,
        })}`,
      );
    }
    console.log(JSON.stringify(report));
  }
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
}
