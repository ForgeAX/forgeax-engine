import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createRhiDebugError,
  replayDeviceRequest,
  tapeDigest,
  usesAccelerationStructures,
  type V7Tape,
} from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { err } from '@forgeax/engine-types';
import type { CommandResult } from '../types.js';
import {
  type ArtifactRef,
  type RhiDebugOperationContext,
  type RhiDebugOperationInput,
  type RhiInspectInput,
  type RhiInspectOutput,
  type RhiReadInput,
  type RhiReadOutput,
  type RhiSummaryOutput,
  type RhiTimingOutput,
  runRhiDebugOperation,
} from './operations.js';

// One GPU instance serves every replay in this process; each replay owns and
// destroys only its fresh device, so a long-lived host accumulates neither.
let replayInstance: GPU | undefined;

type ProviderResult = CommandResult<GPU>;

function providerUnavailable(expected: string, hint: string, cause: string): ProviderResult {
  return {
    ok: false,
    error: {
      code: 'replay-backend-unavailable',
      expected,
      hint,
      detail: { stage: 'provider', cause },
    },
  };
}

/**
 * The replay `GPU`: Dawn by default, or the contributor-only native wgpu device
 * (hardware Ray Query) when `FORGEAX_WEBGPU_NODE=wgpu-native`. Dawn has no
 * acceleration structures, so a tape that builds them names the native route
 * instead of failing later at device admission.
 */
async function replayGpu(tape: V7Tape): Promise<ProviderResult> {
  const native = process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native';
  if (!native && usesAccelerationStructures(tape))
    return providerUnavailable(
      'a replay provider with hardware Ray Query for a tape that builds acceleration structures',
      'Dawn has no acceleration structures; rerun with FORGEAX_WEBGPU_NODE=wgpu-native from an Engine contributor checkout with the native addon built.',
      'tape builds acceleration structures; the default Dawn provider cannot replay them',
    );
  if (replayInstance !== undefined) return { ok: true, value: replayInstance };
  if (native) {
    const entry = findNativeProvider(process.cwd());
    if (entry === undefined)
      return providerUnavailable(
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
        return providerUnavailable(
          'the native wgpu addon to load',
          installed.error.hint,
          installed.error.hint,
        );
      replayInstance = installed.value;
      return { ok: true, value: installed.value };
    } catch (cause) {
      return providerUnavailable(
        'the native wgpu provider to load',
        'Rebuild @forgeax/engine-rhi-wgpu-native (`build:native`, then `build`).',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }
  try {
    const dawn = await import('@forgeax/engine-dawn-node');
    Object.assign(globalThis, dawn.globals as Record<string, unknown>);
    replayInstance = (dawn.create as (options: readonly string[]) => GPU)([]);
    return { ok: true, value: replayInstance };
  } catch (cause) {
    return providerUnavailable(
      'the Dawn WebGPU provider to load',
      'Dawn replay is opt-in: on Linux add the optional provider to the project (`pnpm add -D upstream-webgpu@npm:webgpu@0.4.0`); on macOS/Windows run `pnpm --filter @forgeax/engine-dawn-node build:native` from an Engine source checkout. Then retry rhi.inspect. Ray Query tapes use FORGEAX_WEBGPU_NODE=wgpu-native with its native addon built.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

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

export function createCliRhiDebugOperationContext(): RhiDebugOperationContext {
  return {
    captureFrame: async () =>
      err(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause:
            'the standalone CLI has no live App capture provider; start a recorder-enabled live host and invoke its rhiCapture root',
        }),
      ),
    async readArtifact(artifact: ArtifactRef) {
      if (artifact.path === undefined) {
        return {
          ok: false as const,
          error: {
            code: 'artifact-path-missing',
            expected: 'ArtifactRef.path to identify a readable .rhitape file',
            hint: 'Pass the path returned by the capture host together with its digest.',
            detail: { digest: artifact.digest },
          },
        };
      }
      try {
        return { ok: true as const, value: new Uint8Array(await readFile(artifact.path)) };
      } catch (cause) {
        return {
          ok: false as const,
          error: {
            code: 'artifact-read-failed',
            expected: 'the ArtifactRef path to be readable',
            hint: 'Check the tape path and recapture if the artifact was removed.',
            detail: {
              path: artifact.path,
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          },
        };
      }
    },
    async writeFile(path: string, bytes: Uint8Array) {
      const target = resolve(path);
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        return { ok: true as const, value: target };
      } catch (cause) {
        return {
          ok: false as const,
          error: {
            code: 'artifact-write-failed',
            expected: 'the PNG output path to be writable',
            hint: 'Choose a writable image.png path.',
            detail: {
              path: target,
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          },
        };
      }
    },
    async createReplayBackend(tape: V7Tape) {
      const provider = await replayGpu(tape);
      if (!provider.ok) return provider;
      if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
        Object.defineProperty(globalThis, 'navigator', {
          value: {},
          configurable: true,
          writable: true,
        });
      }
      Object.defineProperty(globalThis.navigator, 'gpu', {
        value: provider.value,
        configurable: true,
        writable: true,
      });
      const adapter = await rhi.requestAdapter();
      if (!adapter.ok) {
        return {
          ok: false as const,
          error: {
            code: 'replay-backend-unavailable',
            expected: 'a fresh replay WebGPU adapter',
            hint: adapter.error.hint,
            detail: { stage: 'adapter', cause: adapter.error.hint },
          },
        };
      }
      const device = await adapter.value.requestDevice(
        replayDeviceRequest(tape, adapter.value.features, adapter.value.limits),
      );
      if (!device.ok) {
        return {
          ok: false as const,
          error: {
            code: 'replay-backend-unavailable',
            expected: 'a fresh replay WebGPU device satisfying the recorded tape',
            hint: device.error.hint,
            detail: { stage: 'device', cause: device.error.hint },
          },
        };
      }
      const replayDevice = device.value;
      return {
        ok: true as const,
        value: {
          device: replayDevice,
          createShaderModule,
          release: () => {
            const native = replayDevice.nativeDevice();
            if (native.ok) native.value.destroy();
          },
        },
      };
    },
  };
}

interface CliOutputs {
  readonly 'rhi.summary': RhiSummaryOutput;
  readonly 'rhi.inspect': RhiInspectOutput;
  readonly 'rhi.read': RhiReadOutput;
  readonly 'rhi.timing': RhiTimingOutput;
}

/** Resolve a file once, then retain its identity throughout decoding and replay. */
export async function runCliRhiDebugOperation<N extends keyof CliOutputs>(
  name: N,
  input: Omit<RhiInspectInput, 'artifact' | 'workIndex'> &
    Partial<Omit<RhiReadInput, 'artifact'>> & {
      readonly artifact: string;
      readonly digest?: string;
      readonly workIndex?: number;
    },
): Promise<CommandResult<CliOutputs[N]>> {
  const context = createCliRhiDebugOperationContext();
  const source: ArtifactRef = {
    kind: 'rhi-tape',
    source: 'cli',
    path: input.artifact,
    digest: input.digest ?? '',
  };
  const bytes = await context.readArtifact(source);
  if (!bytes.ok) return bytes;
  const artifact = { ...source, digest: input.digest ?? tapeDigest(bytes.value) };
  return runRhiDebugOperation(name, { ...input, artifact } as RhiDebugOperationInput, {
    ...context,
    readArtifact: async () => bytes,
  }) as Promise<CommandResult<CliOutputs[N]>>;
}
