#!/usr/bin/env node
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  assertApplicationBootstrap,
  isAlphaShaderReady,
  isTargetShaderUrl,
  isTargetViteHmrUpdate,
  startViteServer,
  pollHttpReady,
  probeFailureRecord,
  withRestoredFile,
  withServerLifecycle,
} from './shared-inputs-browser-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..', '..');
const packageName = '@forgeax/app-learn-render-4-advanced-opengl-3-blending';
const alphaPath = resolve(appRoot, 'src/alpha-test.wgsl');
const require = createRequire(import.meta.url);
const shaderRoot = resolve(dirname(require.resolve('@forgeax/engine-shader/package.json')), 'src');
const EXTERNAL_INSTANCE_LOSS_MESSAGE = 'A valid external Instance reference no longer exists';
const MAX_BROWSER_RECOVERIES = 2;
const chromeChannel = process.env.FORGEAX_CHROME_CHANNEL || 'chrome';
const browserHeadless = !['0', 'false'].includes(
  (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase(),
);
const chromeArgs = [
  '--disable-features=MacAppCodeSignClone',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
  '--ignore-gpu-blocklist',
];
if (chromeChannel === 'chrome-beta') {
  chromeArgs.push(
    '--use-vulkan=swiftshader',
    '--use-angle=swiftshader',
    '--disable-gpu-driver-bug-workarounds',
    '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
  );
}
const browserLaunchOptions = Object.freeze({ headless: browserHeadless, channel: chromeChannel, args: chromeArgs });
const lightweight = process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';
const positiveEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const browserViewport = lightweight
  ? {
      viewport: {
        width: positiveEnv('FORGEAX_BROWSER_CI_VIEWPORT_WIDTH', 320),
        height: positiveEnv('FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT', 180),
      },
    }
  : {};
const settleMs = lightweight ? 250 : 1_000;

function isTransientExternalInstanceError(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.includes(EXTERNAL_INSTANCE_LOSS_MESSAGE);
}

async function collectApplicationErrors(page, consoleErrors) {
  const busErrors = await page.evaluate(() => {
    const errors = globalThis.__learnRenderErrors ?? [];
    return errors.map((error) => {
      try {
        return `BUS-ERR app.onError: ${JSON.stringify(error)}`;
      } catch {
        return `BUS-ERR app.onError: ${String(error.code)}`;
      }
    });
  });
  // Prefer the structured bus over its one-line console mirror so hosted
  // external-Instance failures retain the nested provider cause for recovery
  // classification instead of being reduced to `device-operation-failed`.
  return [...busErrors, ...consoleErrors];
}

async function withBrowserRecovery(label, launchOptions, callback) {
  let recoveryCount = 0;
  while (true) {
    let browser;
    try {
      browser = await chromium.launch({ ...(launchOptions), chromiumSandbox: true });
      return await callback(browser);
    } catch (error) {
      if (!isTransientExternalInstanceError(error) || recoveryCount >= MAX_BROWSER_RECOVERIES) throw error;
      recoveryCount += 1;
      console.warn(
        `[blending] transient WebGPU external Instance loss; restarting ${label} (recovery ${recoveryCount}/${MAX_BROWSER_RECOVERIES})`,
      );
    } finally {
      await browser?.close().catch(() => {});
    }
  }
}

async function buildSharedInputs(sharedRoot) {
  const { execa } = await import('execa');
  await execa(
    'node',
    [
      'scripts/ci/build-shared-app-inputs.mjs',
      '--out',
      sharedRoot,
      '--shader-root',
      shaderRoot,
      '--catalog-only',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  return resolve(sharedRoot, 'manifest.json');
}

async function resolveSharedInputs(sharedRoot) {
  const injected = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
  if (injected === undefined) return buildSharedInputs(sharedRoot);
  const manifest = resolve(injected);
  const parsed = JSON.parse(await readFile(manifest, 'utf8'));
  if (parsed.schemaVersion !== 1 || typeof parsed.inputFingerprint !== 'string') {
    throw new Error(`shared input manifest is incompatible: ${manifest}`);
  }
  return manifest;
}

async function buildApp(manifest) {
  // The shared-inputs producer job owns full payload generation; this probe only needs catalog/manifest data.
  const env = {
    ...process.env,
    FORGEAX_SHARED_APP_INPUTS_MANIFEST: manifest,
    FORGEAX_SHARED_APP_INPUTS_MODE: 'catalog-only',
  };
  const { execa } = await import('execa');
  await execa('pnpm', ['-F', packageName, 'exec', 'vite', 'build', '--base', '/blending/'], { cwd: repoRoot, env, stdio: 'inherit' });
}

async function browserCheck(origin, resource) {
  return withBrowserRecovery(
    'preview browser',
    browserLaunchOptions,
    async (browser) => {
      const page = await browser.newPage(browserViewport);
      await page.addInitScript(() => { globalThis.__learnRenderErrors = []; });
      const applicationErrors = [];
      page.on('pageerror', (error) => applicationErrors.push(`PAGEERROR: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') applicationErrors.push(`CONSOLE-ERR: ${message.text()}`);
      });
      const failedRequests = [];
      page.on('requestfailed', (request) => pushRecent(failedRequests, {
        url: request.url(),
        error: request.failure()?.errorText,
      }));
      await page.goto(`${origin}/blending/`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(settleMs);
      try {
        assertApplicationBootstrap(await collectApplicationErrors(page, applicationErrors), `${origin}/blending/`);
      } catch (error) {
        console.error('[blending] preview bootstrap evidence', JSON.stringify({
          pageUrl: page.url(),
          shaderManifest: await page.evaluate(() => globalThis.__forgeaxShaderManifest ?? null),
          failedRequests,
          viteOutput: resource?.diagnosticOutput?.() ?? '',
        }));
        throw error;
      }
      const urls = ['/blending/pack-index.json', '/blending/shaders/manifest.json'];
      const payloads = await Promise.all(urls.map(async (path) => {
        const response = await page.evaluate(async (url) => { const r = await fetch(url); return { ok: r.ok, status: r.status, body: await r.text() }; }, path).catch((cause) => {
          throw new Error(`preview fetch failed ${path}: ${JSON.stringify({
            pageUrl: page.url(),
            failedRequests,
            applicationErrors,
            viteOutput: resource?.diagnosticOutput?.() ?? '',
          })}`, { cause });
        });
        if (!response.ok) throw new Error(`preview fetch failed ${path}: ${response.status}`);
        return response.body;
      }));
      const catalog = decodeCatalogWire(JSON.parse(payloads[0])).unwrap();
      const manifest = JSON.parse(payloads[1]);
      const originUrl = new URL(origin);
      const hasSharedAsset = Array.isArray(catalog) && catalog.some((entry) => {
        if (typeof entry.packageUrl !== 'string') return false;
        const packageUrl = new URL(entry.packageUrl, originUrl);
        return packageUrl.origin === originUrl.origin && packageUrl.pathname.includes('/assets/');
      });
      if (!hasSharedAsset) throw new Error('catalog omitted shared asset URL');
      const source = JSON.stringify(manifest);
      if (!source.includes('alpha-test.wgsl') || !source.includes('discard')) throw new Error('shader manifest omitted alpha-test marker/discard');
      assertApplicationBootstrap(await collectApplicationErrors(page, applicationErrors), `${origin}/blending/`);
    },
  );
}

const pushRecent = (entries, value, limit = 24) => {
  entries.push(value);
  if (entries.length > limit) entries.shift();
};

function diagnosticsForHmrFailure(frames, requests, responses, resource) {
  return JSON.stringify({
    recentWebSocketFrames: frames,
    shaderRequests: requests,
    shaderResponses: responses,
    viteOutput: resource.diagnosticOutput?.() ?? '',
  });
}

async function waitForDeadline(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function hmrCheck(origin, original, resource) {
  return withBrowserRecovery(
    'HMR browser',
    browserLaunchOptions,
    async (browser) => {
      const page = await browser.newPage(browserViewport);
      await page.addInitScript(() => { globalThis.__learnRenderErrors = []; });
      const applicationErrors = [];
      page.on('pageerror', (error) => applicationErrors.push(`PAGEERROR: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') applicationErrors.push(`CONSOLE-ERR: ${message.text()}`);
      });
      const session = await page.context().newCDPSession(page);
      const frames = [];
      const shaderRequests = [];
      const shaderResponses = [];
      let connected = false;
      let shaderReady = false;
      let resolveReady;
      const ready = new Promise((resolve) => { resolveReady = resolve; });
      const maybeResolveReady = () => {
        if (connected && shaderReady) resolveReady();
      };
      await session.send('Network.enable');
      page.on('request', (request) => {
        if (isTargetShaderUrl(request.url())) pushRecent(shaderRequests, { url: request.url(), method: request.method() });
      });
      page.on('response', (response) => {
        if (!isTargetShaderUrl(response.url())) return;
        const record = { url: response.url(), status: response.status(), ok: response.ok() };
        pushRecent(shaderResponses, record);
        if (isAlphaShaderReady(record)) {
          shaderReady = true;
          maybeResolveReady();
        }
      });
      session.on('Network.webSocketFrameReceived', ({ response }) => {
        pushRecent(frames, response.payloadData);
        try {
          const frame = JSON.parse(response.payloadData);
          if (frame?.type === 'connected') {
            connected = true;
            maybeResolveReady();
          }
        } catch {}
      });
      await page.goto(`${origin}/blending/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      assertApplicationBootstrap(await collectApplicationErrors(page, applicationErrors), `${origin}/blending/`);
      await waitForDeadline(
        ready,
        10_000,
        `custom-shader-hmr: shader/HMR readiness not observed ${diagnosticsForHmrFailure(frames, shaderRequests, shaderResponses, resource)}`,
      );
      let resolveUpdate;
      const update = new Promise((resolve) => { resolveUpdate = resolve; });
      const onUpdate = ({ response }) => {
        if (isTargetViteHmrUpdate(response.payloadData)) resolveUpdate();
      };
      session.on('Network.webSocketFrameReceived', onUpdate);
      try {
        await writeFile(alphaPath, `${original}\n// probe alpha threshold variant ${Date.now()}\n`);
        await waitForDeadline(
          update,
          10_000,
          `custom-shader-hmr: target alpha-test update was not observed ${diagnosticsForHmrFailure(frames, shaderRequests, shaderResponses, resource)}`,
        );
      } finally {
        session.off('Network.webSocketFrameReceived', onUpdate);
      }
    },
  );
}

async function main() {
  const previousSharedMode = process.env.FORGEAX_SHARED_APP_INPUTS_MODE;
  const previousSharedManifest = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
  process.env.FORGEAX_SHARED_APP_INPUTS_MODE = 'catalog-only';
  const tempRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-blending-probe-'));
  try {
    const sharedRoot = resolve(tempRoot, 'shared-app-inputs');
    const manifest = await resolveSharedInputs(sharedRoot);
    // The preview and dev servers must consume the exact immutable projection
    // produced above.  buildApp() passes it only to its child process; without
    // forwarding it here the HMR server silently falls back to source shader
    // compilation, making cold startup both much slower and unlike CI.
    process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = manifest;
    await buildApp(manifest);
    await withServerLifecycle(startViteServer({ mode: 'preview', root: appRoot, base: '/blending/', port: 0 }), async (resource) => {
      await pollHttpReady(`${resource.origin}/blending/`, { stage: 'preview-readiness' });
      await browserCheck(resource.origin, resource);
      if (!resource.process) throw new Error('preview server process missing');
    });
    await withRestoredFile(alphaPath, async (original) => {
      await withServerLifecycle(startViteServer({ mode: 'dev', root: appRoot, base: '/blending/', port: 0 }), async (resource) => {
        await pollHttpReady(`${resource.origin}/blending/`, { stage: 'preview-fetch' });
        await hmrCheck(resource.origin, original, resource);
      });
    });
    process.stdout.write('shared-input browser probe passed\n');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    if (previousSharedMode === undefined) delete process.env.FORGEAX_SHARED_APP_INPUTS_MODE;
    else process.env.FORGEAX_SHARED_APP_INPUTS_MODE = previousSharedMode;
    if (previousSharedManifest === undefined) delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    else process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = previousSharedManifest;
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    const record = probeFailureRecord(error);
    if (record !== null) console.error(JSON.stringify(record));
    else console.error(error);
    process.exit(1);
  },
);
