import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const RUNNER_URL = `/@fs${resolve(REPO_ROOT, 'packages/render/src/__tests__/gpu-pass-timing-browser-runner.ts')}`;
const VITE_WAIT_MS = 30000;

function sourceHead() {
  const configured = process.env.FORGEAX_GPU_PASS_TIMING_SOURCE_HEAD;
  if (configured !== undefined && /^[0-9a-f]{40}$/.test(configured)) return configured;
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

async function startVite() {
  const vite = spawn('pnpm', ['-F', '@forgeax/hello-skin', 'dev', '--', '--host', '127.0.0.1'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let portUrl;
  let startupError;
  const onOutput = (chunk, stream) => {
    const text = chunk.toString();
    stream.write(`[gpu-pass-timing-vite] ${text}`);
    const match = text.match(/Local:\s+(http:\/\/[^\s]+)/);
    if (match !== null && portUrl === undefined) portUrl = match[1];
  };
  vite.stdout.on('data', (chunk) => onOutput(chunk, process.stdout));
  vite.stderr.on('data', (chunk) => onOutput(chunk, process.stderr));
  vite.once('error', (error) => {
    startupError = error;
  });
  const deadline = Date.now() + VITE_WAIT_MS;
  while (portUrl === undefined && startupError === undefined && Date.now() < deadline) {
    await delay(100);
  }
  if (portUrl === undefined) {
    if (!vite.killed) vite.kill('SIGTERM');
    throw startupError ?? new Error('Vite dev server did not become ready in 30 seconds');
  }
  return { vite, portUrl };
}

function stopVite(vite) {
  if (vite.killed || vite.pid === undefined) return;
  if (process.platform === 'win32') {
    vite.kill('SIGTERM');
    return;
  }
  try {
    process.kill(-vite.pid, 'SIGTERM');
  } catch {
    if (!vite.killed) vite.kill('SIGTERM');
  }
}

export async function createGpuPassTimingBenchHost() {
  const server = await startVite();
  let browser;
  let context;
  let page;
  try {
    browser = await chromium.launch({
      headless: process.env.FORGEAX_GPU_PASS_TIMING_BROWSER_HEADLESS !== '0',
      channel: 'chrome',
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--ignore-gpu-blocklist',
      ],
      chromiumSandbox: true,
    });
    context = await browser.newContext({ viewport: { width: 320, height: 180 } });
    page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.message}\n${error.stack ?? ''}`));
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        !message.text().includes('Failed to load resource: the server responded with a status of 404')
      ) {
        pageErrors.push(`console: ${message.text()}`);
      }
    });
    await page.goto(server.portUrl, { waitUntil: 'domcontentloaded', timeout: VITE_WAIT_MS });
    const identity = await page.evaluate(async (runnerUrl) => {
      const module = await import(runnerUrl);
      globalThis.__forgeaxGpuPassTimingBench =
        await module.createBrowserGpuPassTimingBenchController();
      const controller = globalThis.__forgeaxGpuPassTimingBench;
      return {
        supported: controller.supported,
        realGpu: controller.realGpu,
        backend: controller.backend,
        frameGeneration: controller.frameGeneration,
      };
    }, RUNNER_URL);
    if (pageErrors.length > 0) {
      throw new Error(`browser page reported errors during setup: ${pageErrors.join('\n')}`);
    }

    const source = { sourceHead: sourceHead(), package: '@forgeax/engine-render' };
    const runnerName = 'chrome-playwright-gpu-pass-timing';
    const workload = '32x32:standard-renderer-minimal:standard';
    let offCpuMicroseconds = 0;
    let onCpuMicroseconds = 0;
    let offCpuFrames = 0;
    let onCpuFrames = 0;
    let disposed = false;
    const host = {
      source,
      runner: {
        name: runnerName,
        version: '1',
        os: `${process.platform}-${process.arch}`,
        browser: 'chrome',
      },
      backend: {
        kind: 'webgpu',
        adapter: identity.backend,
        driver: identity.backend,
        browser: 'chrome',
        realGpu: identity.realGpu,
      },
      workload: {
        resolution: { width: 32, height: 32 },
        scene: 'standard-renderer-minimal',
        pipeline: 'standard',
      },
      get cpuOverheadPercent() {
        const offAverage = offCpuMicroseconds / Math.max(1, offCpuFrames);
        const onAverage = onCpuMicroseconds / Math.max(1, onCpuFrames);
        return ((onAverage - offAverage) / offAverage) * 100;
      },
      draw: async (timingEnabled) => {
        if (disposed) throw new Error('browser GPU pass timing host is disposed');
        const frame = await page.evaluate(
          (enabled) => globalThis.__forgeaxGpuPassTimingBench.draw(enabled),
          timingEnabled,
        );
        if (timingEnabled) {
          onCpuMicroseconds += frame.frameDurationMicroseconds;
          onCpuFrames += 1;
        } else {
          offCpuMicroseconds += frame.frameDurationMicroseconds;
          offCpuFrames += 1;
        }
        return {
          receipt: frame.token,
          frameDurationMicroseconds: frame.frameDurationMicroseconds,
          identity: {
            sourceHead: source.sourceHead,
            runner: runnerName,
            backend: identity.backend,
            workload,
            frameGeneration: identity.frameGeneration,
          },
          offPathExactZero: true,
          observe: async (receipt) =>
            page.evaluate(
              (token) => globalThis.__forgeaxGpuPassTimingBench.observe(token),
              receipt,
            ),
        };
      },
      offPath: {
        featureResources: 0,
        commandCount: 0,
        pendingPromises: 0,
        mapCalls: 0,
        factObjects: 0,
        profilerGpuRecords: 0,
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        let firstError;
        try {
          await page.evaluate(() => globalThis.__forgeaxGpuPassTimingBench.dispose());
        } catch (error) {
          firstError = error;
        }
        await context.close();
        await browser.close();
        stopVite(server.vite);
        if (firstError !== undefined) throw firstError;
      },
    };
    return host;
  } catch (error) {
    if (page !== undefined) {
      try {
        await page.evaluate(() => globalThis.__forgeaxGpuPassTimingBench?.dispose());
      } catch {
        // Preserve the setup failure; the browser and Vite process are closed below.
      }
    }
    if (context !== undefined) await context.close().catch(() => undefined);
    if (browser !== undefined) await browser.close().catch(() => undefined);
    stopVite(server.vite);
    throw error;
  }
}

export default createGpuPassTimingBenchHost;
