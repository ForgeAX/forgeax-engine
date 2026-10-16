import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
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
  'capability-matrix.json',
);
const deployments = [
  'isolated-production',
  'non-isolated-preview',
  'iframe-allow',
  'iframe-deny',
];

export function deriveSharedEligibility({ deployment, responseHeaders, worker }) {
  const reasons = [];
  if (responseHeaders.coop !== 'same-origin') reasons.push('COOP same-origin not observed');
  if (!['require-corp', 'credentialless'].includes(responseHeaders.coep)) {
    reasons.push('COEP require-corp or credentialless not observed');
  }
  if (!worker.crossOriginIsolated) reasons.push('Worker is not cross-origin isolated');
  if (!worker.sharedArrayBuffer) reasons.push('SharedArrayBuffer is unavailable in Worker');
  if (!worker.atomicsWait.available) reasons.push('Atomics.wait is unavailable in Worker');
  if (!worker.offscreenCanvas.available) reasons.push('OffscreenCanvas is unavailable in Worker');
  if (!worker.webgpu.available) reasons.push('WebGPU adapter is unavailable in Worker');
  if (deployment?.startsWith('iframe')) {
    if (responseHeaders.parentCoop !== 'same-origin') reasons.push('parent COOP same-origin not observed');
    if (!['require-corp', 'credentialless'].includes(responseHeaders.parentCoep)) {
      reasons.push('parent COEP require-corp or credentialless not observed');
    }
    if (responseHeaders.parentPermissionsPolicy === null) {
      reasons.push('parent cross-origin-isolated Permissions-Policy not observed');
    } else if (responseHeaders.parentPermissionsPolicy.includes('=()')) {
      reasons.push('parent Permissions-Policy denies cross-origin-isolated');
    }
  }
  return { sharedEligible: reasons.length === 0, reasons };
}

function headersFor(deployment, target, permissionsPolicy) {
  if (deployment === 'non-isolated-preview') return {};
  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Permissions-Policy': permissionsPolicy ?? 'cross-origin-isolated=(self)',
  };
  if (target === 'worker') headers['Cross-Origin-Resource-Policy'] = 'same-origin';
  return headers;
}

const workerSource = String.raw`
self.onmessage = async () => {
  const offscreenAvailable = typeof OffscreenCanvas === 'function';
  let offscreenContext = false;
  let offscreenReason = 'OffscreenCanvas constructor unavailable';
  if (offscreenAvailable) {
    try {
      const canvas = new OffscreenCanvas(2, 2);
      offscreenContext = canvas.getContext('2d') !== null || canvas.getContext('webgpu') !== null;
      offscreenReason = offscreenContext ? 'worker context acquired' : 'no worker context acquired';
    } catch (error) {
      offscreenReason = String(error);
    }
  }
  let webgpuAvailable = false;
  let webgpuReason = 'navigator.gpu unavailable';
  if (self.navigator?.gpu) {
    try {
      const adapter = await self.navigator.gpu.requestAdapter();
      webgpuAvailable = adapter !== null;
      webgpuReason = adapter === null ? 'requestAdapter returned null' : 'worker adapter acquired';
    } catch (error) {
      webgpuReason = String(error);
    }
  }
  let atomicsAvailable = false;
  let atomicsResult = null;
  let atomicsReason = 'SharedArrayBuffer unavailable';
  if (typeof SharedArrayBuffer === 'function') {
    try {
      const word = new Int32Array(new SharedArrayBuffer(4));
      atomicsResult = Atomics.wait(word, 0, 0, 0);
      atomicsAvailable = atomicsResult === 'timed-out' || atomicsResult === 'not-equal';
      atomicsReason = atomicsAvailable ? 'Atomics.wait executed in Worker' : 'unexpected wait result';
    } catch (error) {
      atomicsReason = String(error);
    }
  }
  self.postMessage({
    realm: 'dedicated-worker',
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    offscreenCanvas: { available: offscreenAvailable && offscreenContext, reason: offscreenReason },
    animationFrame: {
      available: typeof self.requestAnimationFrame === 'function',
      reason: typeof self.requestAnimationFrame === 'function' ? 'Worker requestAnimationFrame observed' : 'Worker requestAnimationFrame unavailable',
    },
    webgpu: { available: webgpuAvailable, reason: webgpuReason },
    atomicsWait: { available: atomicsAvailable, result: atomicsResult, reason: atomicsReason },
  });
};
`;

function probePage(deployment) {
  return `<!doctype html><meta charset="utf-8"><title>${deployment}</title><script>
    const worker = new Worker('/probe-worker.js?deployment=${deployment}');
    worker.onmessage = (event) => {
      window.__probeResult = {
        page: {
          crossOriginIsolated: globalThis.crossOriginIsolated === true,
          sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
        },
        worker: event.data,
      };
      parent.postMessage({ type: 'forgeax-m0-probe', value: window.__probeResult }, '*');
      worker.terminate();
    };
    worker.onerror = (event) => {
      window.__probeError = event.message || 'worker startup failed';
      parent.postMessage({ type: 'forgeax-m0-error', value: window.__probeError }, '*');
    };
    worker.postMessage('probe');
  </script>`;
}

function iframePage(deployment, childOrigin) {
  const allow = deployment === 'iframe-allow' ? ' allow="cross-origin-isolated"' : '';
  return `<!doctype html><meta charset="utf-8"><title>${deployment}</title>
    <iframe src="${childOrigin}/probe?deployment=${deployment}"${allow}></iframe>
    <script>
      addEventListener('message', (event) => {
        if (event.data?.type === 'forgeax-m0-probe') window.__probeResult = event.data.value;
        if (event.data?.type === 'forgeax-m0-error') window.__probeError = event.data.value;
      });
    </script>`;
}

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('M0 server has no TCP port');
  return `http://127.0.0.1:${address.port}`;
}

async function startServers() {
  const childServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const deployment = url.searchParams.get('deployment') ?? 'iframe-allow';
    const target = url.pathname === '/probe-worker.js' ? 'worker' : 'document';
    const headers = headersFor(deployment, target);
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/probe-worker.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(workerSource);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(probePage(deployment));
  });
  const childOrigin = await listen(childServer);
  const parentServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const deployment = url.searchParams.get('deployment') ?? url.pathname.slice(1);
    const target = url.pathname === '/probe-worker.js' ? 'worker' : 'document';
    const permissionsPolicy =
      deployment === 'iframe-allow'
        ? `cross-origin-isolated=(self "${childOrigin}")`
        : deployment === 'iframe-deny'
          ? 'cross-origin-isolated=()'
          : undefined;
    const headers = headersFor(deployment, target, permissionsPolicy);
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    if (url.pathname === '/probe-worker.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(workerSource);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (deployment === 'iframe-allow' || deployment === 'iframe-deny') {
      response.end(iframePage(deployment, childOrigin));
    } else response.end(probePage(deployment));
  });
  const parentOrigin = await listen(parentServer);
  return { childServer, childOrigin, parentServer, parentOrigin };
}

async function probeBrowser(name, browserType, parentOrigin, childOrigin) {
  const launchOptions = name === 'chrome'
    ? chromeLaunchOptions()
    : { headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0' };
  const browser = await browserType.launch({ ...(launchOptions), chromiumSandbox: true });
  const version = browser.version();
  const results = [];
  try {
    for (const deployment of deployments) {
      const page = await browser.newPage();
      const responses = new Map();
      page.on('response', (response) => responses.set(response.url(), response.headers()));
      const url = `${parentOrigin}/${deployment}`;
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(
        () => globalThis.__probeResult !== undefined || globalThis.__probeError !== undefined,
        undefined,
        { timeout: 15000 },
      );
      const error = await page.evaluate(() => globalThis.__probeError);
      if (error !== undefined) throw new Error(`${name}/${deployment}: ${error}`);
      const observed = await page.evaluate(() => globalThis.__probeResult);
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const targetUrl =
        deployment.startsWith('iframe') ? `${childOrigin}/probe?deployment=${deployment}` : url;
      const responseHeaders = responses.get(targetUrl) ?? {};
      const parentHeaders = responses.get(url) ?? {};
      const normalizedHeaders = {
        coop: responseHeaders['cross-origin-opener-policy'] ?? null,
        coep: responseHeaders['cross-origin-embedder-policy'] ?? null,
        permissionsPolicy: responseHeaders['permissions-policy'] ?? null,
        parentCoop: deployment.startsWith('iframe')
          ? (parentHeaders['cross-origin-opener-policy'] ?? null)
          : null,
        parentCoep: deployment.startsWith('iframe')
          ? (parentHeaders['cross-origin-embedder-policy'] ?? null)
          : null,
        parentPermissionsPolicy: deployment.startsWith('iframe')
          ? (parentHeaders['permissions-policy'] ?? null)
          : null,
      };
      const eligibility = deriveSharedEligibility({
        deployment,
        responseHeaders: normalizedHeaders,
        worker: observed.worker,
      });
      const expectedSharedEligible =
        name === 'chrome' &&
        (deployment === 'isolated-production' || deployment === 'iframe-allow');
      const mismatch = eligibility.sharedEligible !== expectedSharedEligible;
      results.push({
        browser: name,
        browserVersion: version,
        userAgent,
        deployment,
        url: targetUrl,
        command: 'node apps/hello/multithreaded-execution/m0/scripts/run-capability-matrix.mjs',
        responseHeaders: normalizedHeaders,
        page: observed.page,
        worker: observed.worker,
        verdict: {
          expectedSharedEligible,
          sharedEligible: eligibility.sharedEligible,
          passed: !mismatch,
          reasons: mismatch
            ? [
                `expected sharedEligible=${expectedSharedEligible}, observed ${eligibility.sharedEligible}`,
                ...eligibility.reasons,
              ]
            : eligibility.reasons,
        },
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

function requestedBrowser() {
  const option = process.argv.find((argument) => argument.startsWith('--browser='));
  const browser = option?.slice('--browser='.length) ?? 'all';
  if (browser === 'all' || browser === 'chrome' || browser === 'webkit') return browser;
  throw new Error(`unsupported browser selection: ${browser}`);
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const worker = {
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      atomicsWait: { available: true },
      offscreenCanvas: { available: true },
      webgpu: { available: true },
    };
    const good = deriveSharedEligibility({
      deployment: 'isolated-production',
      responseHeaders: { coop: 'same-origin', coep: 'require-corp' },
      worker,
    });
    const bad = deriveSharedEligibility({
      deployment: 'isolated-production',
      responseHeaders: { coop: null, coep: null },
      worker,
    });
    if (!good.sharedEligible || bad.sharedEligible || bad.reasons.length < 2) process.exitCode = 1;
    else console.log('[m0-capability] real-header policy fixture accepted; missing-header fixture rejected');
    return;
  }
  const browserSelection = requestedBrowser();
  const { childServer, childOrigin, parentServer, parentOrigin } = await startServers();
  try {
    const runs = [];
    if (browserSelection === 'all' || browserSelection === 'chrome') {
      runs.push(...(await probeBrowser('chrome', chromium, parentOrigin, childOrigin)));
    }
    if (browserSelection === 'all' || browserSelection === 'webkit') {
      runs.push(...(await probeBrowser('webkit', webkit, parentOrigin, childOrigin)));
    }
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(runs, null, 2)}\n`);
    console.log(JSON.stringify(runs, null, 2));
    const expectedRuns = browserSelection === 'all' ? 8 : 4;
    if (runs.length !== expectedRuns || runs.some((run) => !run.verdict.passed)) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all([
      new Promise((resolvePromise) => childServer.close(resolvePromise)),
      new Promise((resolvePromise) => parentServer.close(resolvePromise)),
    ]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
