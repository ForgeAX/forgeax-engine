import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface NodeGpuUnavailable {
  readonly expected: string;
  readonly hint: string;
  readonly cause: string;
}

// One GPU instance serves every Node render or replay in this process; each user
// owns and destroys only its own device, so a long-lived host accumulates neither.
let instance: GPU | undefined;

const unavailable = (expected: string, hint: string, cause: string) =>
  ({ ok: false, error: { expected, hint, cause } }) as const;

/** The workspace package, or an installed one, nearest to `from`. */
function findNativeProvider(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    for (const candidate of [
      join(dir, 'packages/rhi-wgpu-native/dist/index.mjs'),
      join(dir, 'node_modules/@forgeax/engine-rhi-wgpu-native/dist/index.mjs'),
    ])
      if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The Node WebGPU `GPU` for DevKit's offscreen work (RHI replay, `model.render`):
 * Dawn by default, or the contributor-only native wgpu device when
 * `FORGEAX_WEBGPU_NODE=wgpu-native`. Dawn also installs its spec globals
 * (`GPUBufferUsage`, ...), which offscreen callers use.
 */
export async function nodeGpu(): Promise<
  | { readonly ok: true; readonly value: GPU }
  | { readonly ok: false; readonly error: NodeGpuUnavailable }
> {
  if (instance !== undefined) return { ok: true, value: instance };
  if (process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native') {
    const entry = findNativeProvider(process.cwd());
    if (entry === undefined)
      return unavailable(
        'the contributor-only @forgeax/engine-rhi-wgpu-native package with its built addon',
        'Run from an Engine contributor checkout after `pnpm --filter @forgeax/engine-rhi-wgpu-native build:native` and its `build`.',
        `no rhi-wgpu-native dist/index.mjs above ${process.cwd()}`,
      );
    try {
      const provider = (await import(pathToFileURL(entry).href)) as {
        installNavigatorGpu():
          | { readonly ok: true; readonly value: GPU }
          | { readonly ok: false; readonly error: { readonly hint: string } };
      };
      const installed = provider.installNavigatorGpu();
      if (!installed.ok)
        return unavailable(
          'the native wgpu addon to load',
          installed.error.hint,
          installed.error.hint,
        );
      instance = installed.value;
      return { ok: true, value: installed.value };
    } catch (cause) {
      return unavailable(
        'the native wgpu provider to load',
        'Rebuild @forgeax/engine-rhi-wgpu-native (`build:native`, then `build`).',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }
  try {
    const dawn = await import('@forgeax/engine-dawn-node');
    Object.assign(globalThis, dawn.globals as Record<string, unknown>);
    instance = (dawn.create as (options: readonly string[]) => GPU)([]);
    return { ok: true, value: instance };
  } catch (cause) {
    return dawnUnavailable(cause instanceof Error ? cause.message : String(cause));
  }
}

const WITHOUT_REPLAY =
  'For RHI tapes without replay: `forgeax rhi summary --artifact PATH --passes` (per-pass labels, targets, work and pipeline counts), `--label REGEX`, and `rhi inspect` with the default pipeline/bindings fields. Replay-only reads (`pixels`, `outputs`, `rhi read`, `rhi timing`) need live evidence instead: `dev capture`, `dev eval`, debug draw.';

/** True when the Dawn carrier loaded but its host native library was never prepared. */
function isMissingDawnBinary(cause: string): boolean {
  return /dawn\.node|dist\/native|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(cause);
}

/**
 * Failure for a Dawn carrier that cannot load. macOS and Windows ship no prebuilt
 * `dawn.node` by design (the npm package carries sources and the patch, never the
 * binary), so the absent file is the expected state of a game install, not a wrong
 * platform key. Say that, name the one build command, and list what still works.
 */
export function dawnUnavailable(
  cause: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { readonly ok: false; readonly error: NodeGpuUnavailable } {
  const source = platform === 'darwin' || platform === 'win32';
  const missing = isMissingDawnBinary(cause);
  const key = `${platform}-${arch}`;
  const reason =
    source && missing
      ? `No prebuilt dawn.node exists for ${key}: @forgeax/engine-dawn-node builds it from source on macOS and Windows and never ships the binary, so it is absent unless someone built it on this host.`
      : 'The Dawn provider failed to load.';
  const build = source
    ? 'To enable replay, build it once from an Engine source checkout (needs CMake, Ninja, Go, Python 3; heavy, tens of minutes): `pnpm --filter @forgeax/engine-dawn-node build:native`.'
    : 'On Linux the upstream prebuild needs a Vulkan driver (lavapipe works headless).';
  return unavailable(
    `the Dawn WebGPU provider to load (${key})`,
    `${reason} ${build} ${WITHOUT_REPLAY} Ray Query tapes use FORGEAX_WEBGPU_NODE=wgpu-native with its native addon built. Do not retry replay on this host.`,
    cause,
  );
}
