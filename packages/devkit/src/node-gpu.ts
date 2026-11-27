import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
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

function resolveProjectDawn(projectRoot: string): string | undefined {
  try {
    return createRequire(resolve(projectRoot, 'package.json')).resolve('upstream-webgpu');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    return undefined;
  }
}

/**
 * The Node WebGPU `GPU` for DevKit's offscreen work (RHI replay, `model.render`):
 * Dawn by default, or the contributor-only native wgpu device when
 * `FORGEAX_WEBGPU_NODE=wgpu-native`. Dawn also installs its spec globals
 * (`GPUBufferUsage`, ...), which offscreen callers use.
 */
export async function nodeGpu(
  projectRoot = process.cwd(),
): Promise<
  | { readonly ok: true; readonly value: GPU }
  | { readonly ok: false; readonly error: NodeGpuUnavailable }
> {
  if (instance !== undefined) return { ok: true, value: instance };
  if (process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native') {
    const entry = findNativeProvider(projectRoot);
    if (entry === undefined)
      return unavailable(
        'the contributor-only @forgeax/engine-rhi-wgpu-native package with its built addon',
        'Run from an Engine contributor checkout after `pnpm --filter @forgeax/engine-rhi-wgpu-native build:native` and its `build`.',
        `no rhi-wgpu-native dist/index.mjs above ${projectRoot}`,
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
    const projectEntry = resolveProjectDawn(projectRoot);
    const dawn: typeof import('@forgeax/engine-dawn-node') =
      projectEntry === undefined
        ? await import('@forgeax/engine-dawn-node')
        : await import(pathToFileURL(projectEntry).href);
    Object.assign(globalThis, dawn.globals as Record<string, unknown>);
    // Dawn rounds timestamp queries to 2^16 ticks (65.5 us on Metal) by default;
    // replay timing needs the raw ticks.
    instance = (dawn.create as (options: readonly string[]) => GPU)([
      'disable-dawn-features=timestamp_quantization',
    ]);
    return { ok: true, value: instance };
  } catch (cause) {
    return dawnUnavailable(cause instanceof Error ? cause.message : String(cause));
  }
}

export function dawnUnavailable(cause: string) {
  return unavailable(
    'the optional upstream Dawn Node WebGPU provider to load',
    'For Node GPU tools, run `pnpm add -D --save-exact upstream-webgpu@npm:webgpu@0.6.2` in the game before rerunning this command. For structural tape reads, use `forgeax rhi summary` or `rhi inspect` with pipeline and bindings fields.',
    cause,
  );
}
