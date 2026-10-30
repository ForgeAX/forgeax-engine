// config/vitest.setup-webgpu.ts — dawn.node native binding setup for vitest `dawn` project.
//
// race-window mitigation: bug-20260511-dawn-worker-glibc-pthread-mutex-crash
// race-window narrowing rationale: see .forgeax-harness/forgeax-loop/bug-20260511-dawn-worker-glibc-pthread-mutex-crash/research.md §F-5
//
// 4-step teardown design (see afterAll below; plan-strategy §2 K-1):
//   1. device.destroy()              — drop GPU resources owned by every tracked device
//   2. queue.onSubmittedWorkDone()   — flush pending submitted work as an in-process barrier
//   3. delete globalThis.navigator.gpu — drop the only handle dawn-node exposes for instance teardown
//   4. await setTimeout 100 ms       — yield to dawn-node native pthread cleanup, collapsing the
//                                      Linux+lavapipe race window observed in CI before this fix
// Each step wraps errors in explicit console.error rather than swallow, per AI User Charter
// proposition 4 (explicit failure beats silent error); see plan-strategy §3 R-6.
//
// New .dawn.test.ts files do not need to repeat any afterAll logic in their own file:
// setup-webgpu.ts hooks globalThis.navigator.gpu.requestAdapter -> adapter.requestDevice
// to track every GPUDevice created by any dawn-project test, so the 4-step teardown
// covers them automatically (plan-strategy §7.4 discoverability — adding new
// .dawn.test.ts files inherits the mitigation for free).
//
// Referenced by root vitest.config.ts dawn project `setupFiles` (K-4 naming convention).
// dawn project test files (`**/*.dawn.test.ts`) execute under node env; we need to
// mount the dawn.node-created GPU instance on global `globalThis.navigator.gpu` and
// inject spec constants such as `GPUBufferUsage` into globalThis.
//
// research §1 Finding 1.3 integration pattern:
//   import { create, globals } from '@forgeax/engine-dawn-node'
//   Object.assign(globalThis, globals)         (inject GPUBufferUsage and other constants)
//   globalThis.navigator.gpu = create([])     (empty flags array)
//
// research §1 Finding 1.4 critical pitfalls:
//   - macOS Gatekeeper `com.apple.quarantine`: when first require fails, manually run
//     `xattr -d com.apple.quarantine packages/dawn-node/dist/native/*.dawn.node`
//     (cannot install with --ignore-scripts).
//   - chromium issue 387965810 — `globalThis.navigator.gpu` global pollution prevents
//     the node process from exiting; R10 mitigation: explicitly delete the reference in `afterAll`.
//   - dawn.node lacks `HTMLCanvasElement` / `VideoFrame` / `HTMLImageElement`;
//     `*.dawn.test.ts` cases focus on command recording + queue.submit + GPUBuffer readback,
//     not relying on canvas DOM.
//
// F-1 / D-P2 revision — structured wrapping of dawn.node binding errors:
//   When `create([])` throws (missing prebuild / Gatekeeper / unsupported platform), catch +
//   rethrow a structured Error containing `code` / `hint` fields; raw exceptions must not
//   propagate through (charter proposition 4 explicit failure: same structured channel as
//   the silent-skip fix). AI users can identify the root cause by reading the reason in the
//   vitest report; no need to assert against error message strings.

import { afterAll } from 'vitest';
import { observeByteEqualityWork } from './byte-equality-work';

const byteEqualityWork = observeByteEqualityWork();

import {
  normalizeDawnAdapter,
  normalizeDawnDeviceDescriptor,
  patchDawnAdapterPrototype,
} from '../scripts/ci/normalize-dawn-device-limits.mjs';
import { teardownDawnInstance } from '../scripts/lib/dawn-teardown.mjs';

// Lavapipe otherwise sizes its pool from the host's logical CPUs, which can
// greatly exceed a CI container's CPU quota. Four software-rendering threads
// reduced the unchanged 300-frame shadow probe from 22.6s to 10.3s on Linux.
// Keep an explicitly requested driver setting; physical GPU drivers ignore it.
if (process.platform === 'linux' && process.env.LP_NUM_THREADS === undefined) {
  process.env.LP_NUM_THREADS = '4';
}

let gpuRefCleanup: (() => void) | undefined;

// trackedDevices: M2 t-010 module-scoped collector for every GPUDevice created via the
// installed globalThis.navigator.gpu. afterAll's 4-step teardown (M2 t-011) iterates this
// Set to call device.destroy() + queue.onSubmittedWorkDone() before instance-level cleanup.
// Naming follows plan-strategy §7.2 — no abbreviation (no `td` / `devs`).
const trackedDevices = new Set<GPUDevice>();

// `FORGEAX_WEBGPU_NODE=wgpu-native` installs the opt-in native wgpu `GPU`
// (`@forgeax/engine-rhi-wgpu-native`, Ray Query extension included) instead of dawn.node,
// so the unchanged dawn fleet runs on the native device with the same device tracking.
async function installWgpuNative(): Promise<void> {
  const { installNavigatorGpu } = await import('../packages/rhi-wgpu-native/src/index');
  const native = installNavigatorGpu();
  if (!native.ok) {
    throw new Error(
      `[setup-webgpu] code: 'wgpu-native-binding-failed'; hint: ${native.error.hint}`,
      { cause: native.error },
    );
  }
  const gpu = native.value;
  const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
  (gpu as { requestAdapter: typeof gpu.requestAdapter }).requestAdapter = async (...args) => {
    const adapter = await originalRequestAdapter(...args);
    if (adapter === null) return adapter;
    const originalRequestDevice = adapter.requestDevice.bind(adapter);
    (adapter as { requestDevice: typeof adapter.requestDevice }).requestDevice = async (
      ...deviceArgs
    ) => {
      const device = await originalRequestDevice(...deviceArgs);
      trackedDevices.add(device as unknown as GPUDevice);
      return device;
    };
    return adapter;
  };
  gpuRefCleanup = () => {
    delete (globalThis.navigator as { gpu?: unknown }).gpu;
  };
}

if (process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native') {
  await installWgpuNative();
} else
  try {
    // dawn.node binding entry; create / globals are provided by require dist/<platform>.dawn.node.
    const { create, globals } = await import('@forgeax/engine-dawn-node');
    // Inject spec global constants (GPUBufferUsage / GPUTextureUsage / GPUMapMode, etc.).
    Object.assign(globalThis as Record<string, unknown>, globals);
    // Dawn's native binding otherwise fills omitted dynamic-buffer limits with
    // the wgpu default (1,000,000), which lavapipe immediately clamps to its
    // adapter limit and reports as a warning. Patch the binding prototype before
    // creating the instance so every adapter returned to a test is normalized.
    patchDawnAdapterPrototype(globals);
    // Fallback globalThis.navigator placeholder (node has none by default).
    if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
      Object.defineProperty(globalThis, 'navigator', {
        value: {} as Navigator,
        configurable: true,
        writable: true,
      });
    }
    const gpu = create([]);
    // M2 t-010: shim requestAdapter -> requestDevice to collect every created GPUDevice.
    // Wrapping at gpu.requestAdapter is the single chokepoint covering all *.dawn.test.ts
    // entry paths (research §F-1/§F-2 — every test calls navigator.gpu.requestAdapter()).
    // Tracking by device reference (not adapter) is required because requestAdapter returns
    // a fresh proxy each call (M1 probe §5); adapter identity cannot be used for dedup.
    const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
    (gpu as { requestAdapter: typeof gpu.requestAdapter }).requestAdapter = async (
      ...adapterArgs: Parameters<typeof gpu.requestAdapter>
    ) => {
      const adapter = await originalRequestAdapter(...adapterArgs);
      if (adapter) {
        if (process.platform === 'win32') {
          const info = adapter.info;
          console.error(
            '[setup-webgpu] adapter=',
            JSON.stringify({
              vendor: info.vendor,
              architecture: info.architecture,
              device: info.device,
              description: info.description,
            }),
          );
        }
        const normalizedAdapter = normalizeDawnAdapter(adapter);
        const originalRequestDevice = normalizedAdapter.requestDevice.bind(normalizedAdapter);
        (
          normalizedAdapter as { requestDevice: typeof normalizedAdapter.requestDevice }
        ).requestDevice = async (
          ...deviceArgs: Parameters<typeof normalizedAdapter.requestDevice>
        ) => {
          const device = await originalRequestDevice(
            normalizeDawnDeviceDescriptor(normalizedAdapter, deviceArgs[0]),
          );
          trackedDevices.add(device);
          if (process.env.FORGEAX_SETUP_DEBUG === '1') {
            console.error('[setup-webgpu] tracked device count=', trackedDevices.size);
          }
          return device;
        };
        return normalizedAdapter;
      }
      return adapter;
    };
    Object.defineProperty(globalThis.navigator, 'gpu', {
      value: gpu,
      configurable: true,
      writable: true,
    });
    // bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so the
    // pre-existing dawn-node test fleet (MSAA target / FXAA dispatcher / urp-pipeline.ts:185-192
    // / render-graph-primitives.ts:506 — all hardcoded rgba8unorm viewFormats) keeps using the
    // rgba8unorm-based swap-chain + MSAA + FXAA fixture chain. Browser project (test:browser)
    // does NOT load this setup file and validates the real Channel 2 BGRA path through the
    // canvas helper unmodified. Plan §4 R-5 anticipated 'pipeline format mismatch ... one of
    // the 8 callsites missed a rewrite'; rather than thread the M2 helper output into every dawn fixture
    // (large blast radius), we narrow the dawn surface to RGBA. Dawn-node's actual return value
    // varies per platform — patch is idempotent if it already returns 'rgba8unorm'.
    (gpu as { getPreferredCanvasFormat: () => GPUTextureFormat }).getPreferredCanvasFormat = () =>
      'rgba8unorm';
    gpuRefCleanup = () => {
      // R10 / chromium issue 387965810 mitigation: drop the reference at test teardown to
      // mitigate node process not exiting.
      delete (globalThis.navigator as { gpu?: unknown }).gpu;
    };
  } catch (err: unknown) {
    // F-1 revision (D-P2): on dawn.node binding failure, rethrow in structured form — same
    // approach as the silent-skip fix. AI users read reason / code in the vitest report to
    // identify the root cause; raw err must not propagate through (charter proposition 4
    // explicit failure).
    const rawMessage = err instanceof Error ? err.message : String(err);
    const platform = `${process.platform}-${process.arch}`;
    const hint =
      process.platform === 'darwin' || process.platform === 'win32'
        ? 'Dawn GPU tests are opt-in; prepare the native carrier with `pnpm --filter @forgeax/engine-dawn-node build:native`, then rerun `pnpm test:dawn`. Basic tests use `pnpm test`.'
        : `check whether the webgpu npm package has a ${platform} prebuild; basic tests use pnpm test`;
    // structured throw — single-line `throw new Error(...code: ...)` shape matches the
    // plan-tasks w10 acceptanceCheck grep gate `throw\s+(new\s+)?Error\(.*code\s*:`.
    // Embedding code: and hint: inside the error message literal (vitest reporter prints it
    // directly) lets AI users identify the root cause by reading the message (charter
    // proposition 4 explicit failure: same structured channel as the silent-skip fix).
    // `{ cause: err }` propagates the original dawn.node exception for stack-trace debugging.
    throw new Error(
      `[setup-webgpu] code: 'dawn-binding-failed'; hint: ${hint}; raw: ${rawMessage}`,
      {
        cause: err,
      },
    );
  }

afterAll(async () => {
  try {
    await teardownDawnInstance(
      trackedDevices,
      () => {
        trackedDevices.clear();
        if (gpuRefCleanup) gpuRefCleanup();
        else delete (globalThis.navigator as { gpu?: unknown }).gpu;
      },
      (step: string, error: unknown) => {
        console.error(`[setup-webgpu teardown] ${step} failed:`, error);
      },
    );
  } finally {
    byteEqualityWork.stop();
  }
  byteEqualityWork.assertNoGenericComparisons();
});
