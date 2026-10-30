// Probe the Chromium carrier used by the browser WebGL2 fallback lane.
// This is deliberately a capability probe, not a soft skip: the lane must
// prove that WebGPU is disabled and that a real WebGL2 context is available.

import { chromium } from 'playwright';

const headless = !['0', 'false'].includes(
  (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase(),
);
const launchArgs = [
  '--disable-features=WebGPU,WebGPUService',
  '--disable-gpu',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-driver-bug-workarounds',
];
const configuredExecutable = process.env.FORGEAX_CHROMIUM_EXECUTABLE;
const configuredChannel = process.env.FORGEAX_CHROME_CHANNEL;
// Playwright rejects channel and executablePath together. Prefer an explicit
// executable, then the configured Chrome channel, and otherwise use its
// managed Chromium so the emitted identity describes the actual launch.
let carrier;
let carrierLaunchOptions = {};
if (configuredExecutable !== undefined) {
  carrier = { kind: 'executable', value: configuredExecutable };
  carrierLaunchOptions = { executablePath: configuredExecutable };
} else if (configuredChannel !== undefined) {
  carrier = { kind: 'channel', value: configuredChannel };
  carrierLaunchOptions = { channel: configuredChannel };
} else {
  carrier = { kind: 'playwright-managed-chromium', value: null };
}
const launchOptions = {
  headless,
  ...carrierLaunchOptions,
  args: launchArgs,
};

const operationTimeoutMs = Number(process.env.FORGEAX_BROWSER_OPERATION_TIMEOUT_MS ?? 30000);
const withTimeout = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${operationTimeoutMs}ms`)),
          operationTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

let browser;
try {
  console.log(`[chromium-webgl2] launch ${JSON.stringify({ carrier, launchArgs })}`);
  browser = await withTimeout(
    chromium.launch({ ...launchOptions, chromiumSandbox: true }),
    'Chromium fallback launch',
  );
  const page = await withTimeout(
    browser.newPage({ viewport: { width: 320, height: 180 } }),
    'Chromium fallback page creation',
  );
  const probe = await withTimeout(
    page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
      const gpu = typeof navigator !== 'undefined' ? navigator.gpu : undefined;
      let webgpuAdapterStatus = 'absent';
      if (gpu !== undefined && typeof gpu.requestAdapter === 'function') {
        try {
          webgpuAdapterStatus = (await gpu.requestAdapter()) === null ? 'unavailable' : 'available';
        } catch {
          webgpuAdapterStatus = 'error';
        }
      }
      return {
        userAgent: navigator.userAgent,
        hasGpu: gpu !== undefined && !!gpu,
        webgpuAdapterStatus,
        webgl2: gl !== null,
        vendor:
          debugInfo === null ? null : (gl?.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? null),
        renderer:
          debugInfo === null ? null : (gl?.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? null),
      };
    }),
    'Chromium fallback capability evaluation',
  );
  const evidence = {
    browser: 'chromium',
    carrier,
    launchArgs,
    probe,
  };
  console.log(`[chromium-webgl2] capability ${JSON.stringify(evidence)}`);
  if (
    probe.webgpuAdapterStatus === 'available' ||
    probe.webgpuAdapterStatus === 'error' ||
    !probe.webgl2
  ) {
    throw new Error(`Chromium WebGL2 fallback capability mismatch: ${JSON.stringify(evidence)}`);
  }
} catch (error) {
  console.error(
    `[chromium-webgl2] capability probe failed: ${JSON.stringify({
      carrier,
      launchArgs,
      error: error instanceof Error ? error.message : String(error),
    })}`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
}
