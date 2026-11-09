import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRhiDebugError,
  replayDeviceRequest,
  tapeDigest,
  usesAccelerationStructures,
  type V7Tape,
} from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { err } from '@forgeax/engine-types';
import { nodeGpu } from '../node-gpu.js';
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
  type RhiTimingInput,
  type RhiTimingOutput,
  runRhiDebugOperation,
} from './operations.js';
import type {
  HostLoadPhase,
  HostLoadSample,
  ReplayAdapterInfo,
  TimestampQuantization,
} from './timing-environment.js';

type ProviderResult = CommandResult<GPU>;

/**
 * The replay `GPU` from the shared Node provider. Dawn has no acceleration
 * structures, so a tape that builds them names the native route instead of
 * failing later at device admission.
 */
async function replayGpu(tape: V7Tape): Promise<ProviderResult> {
  const native = process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native';
  const unavailable = (expected: string, hint: string, cause: string): ProviderResult => ({
    ok: false,
    error: {
      code: 'replay-backend-unavailable',
      expected,
      hint,
      detail: { stage: 'provider', cause },
    },
  });
  if (!native && usesAccelerationStructures(tape))
    return unavailable(
      'a replay provider with hardware Ray Query for a tape that builds acceleration structures',
      'Dawn has no acceleration structures; rerun with FORGEAX_WEBGPU_NODE=wgpu-native from an Engine contributor checkout with the native addon built.',
      'tape builds acceleration structures; the default Dawn provider cannot replay them',
    );
  const gpu = await nodeGpu();
  return gpu.ok ? gpu : unavailable(gpu.error.expected, gpu.error.hint, gpu.error.cause);
}

function run(command: string, args: readonly string[], timeout = 3000): Promise<string | null> {
  return new Promise((resolveRun) => {
    execFile(command, args, { timeout, encoding: 'utf8' }, (error, stdout) =>
      resolveRun(error === null ? stdout : null),
    );
  });
}

/** macOS IOAccelerator "Device Utilization %"; null where unreadable. */
async function gpuUtilizationPercent(): Promise<number | null> {
  if (process.platform !== 'darwin') return null;
  const out = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']);
  const values = [...(out ?? '').matchAll(/"Device Utilization %"=(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  return values.length === 0 ? null : Math.max(...values);
}

const LOAD_SAMPLES = 4;
const LOAD_SAMPLE_INTERVAL_MS = 500;

/**
 * `before`: the busiest of a few samples over about 1.5 s, so a single idle
 * tick between frames of another app does not pass. `after`: the quietest of
 * them, since utilization trails our own just-finished replays.
 */
export async function sampleHostLoad(phase: HostLoadPhase): Promise<HostLoadSample> {
  const samples: (number | null)[] = [];
  for (let i = 0; i < LOAD_SAMPLES; i += 1) {
    if (i > 0) await new Promise((wake) => setTimeout(wake, LOAD_SAMPLE_INTERVAL_MS));
    const value = await gpuUtilizationPercent();
    samples.push(value);
    if (value === null || (phase === 'after' && value === 0)) break;
  }
  const known = samples.filter((value): value is number => value !== null);
  const gpu =
    known.length === 0 ? null : phase === 'before' ? Math.max(...known) : Math.min(...known);
  const load1 = process.platform === 'win32' ? null : (loadavg()[0] ?? null);
  return { at: new Date().toISOString(), load1, gpuUtilizationPercent: gpu };
}

/** Git revision and dirty state of the checkout this devkit runs from, plus the runtime. */
export async function buildIdentity(): Promise<Record<string, string | number | boolean>> {
  const here = dirname(fileURLToPath(import.meta.url));
  const revision = (await run('git', ['-C', here, 'rev-parse', 'HEAD']))?.trim();
  const status = await run('git', ['-C', here, 'status', '--porcelain', '--untracked-files=no']);
  return {
    ...(revision === undefined || revision === '' ? {} : { revision }),
    ...(status === null ? {} : { dirty: status.trim() !== '' }),
    provider: process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native' ? 'wgpu-native' : 'dawn',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

function adapterInfoOf(info: GPUAdapterInfo | undefined): ReplayAdapterInfo | undefined {
  if (info === undefined) return undefined;
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
  };
}

export function createCliRhiDebugOperationContext(): RhiDebugOperationContext {
  return {
    sampleHostLoad,
    buildIdentity,
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
      const adapterInfo = adapterInfoOf((await provider.value.requestAdapter())?.info);
      // nodeGpu() creates Dawn without timestamp quantization; wgpu-native does not declare it.
      const timestampQuantization: TimestampQuantization =
        process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native' ? 'unknown' : 'disabled';
      return {
        ok: true as const,
        value: {
          device: replayDevice,
          createShaderModule,
          timestampQuantization,
          ...(adapterInfo === undefined ? {} : { adapterInfo }),
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
    Partial<Omit<RhiReadInput, 'artifact'>> &
    Partial<Omit<RhiTimingInput, 'artifact' | 'compare'>> & {
      readonly artifact: string;
      readonly digest?: string;
      readonly workIndex?: number;
      /** `rhi timing` baseline tape path. */
      readonly compare?: string;
    },
): Promise<CommandResult<CliOutputs[N]>> {
  const context = createCliRhiDebugOperationContext();
  const files = new Map<string, CommandResult<Uint8Array>>();
  const resolveRef = async (
    path: string,
    digest: string | undefined,
  ): Promise<CommandResult<ArtifactRef>> => {
    const source: ArtifactRef = { kind: 'rhi-tape', source: 'cli', path, digest: digest ?? '' };
    const bytes = await context.readArtifact(source);
    if (!bytes.ok) return bytes;
    files.set(path, bytes);
    return { ok: true, value: { ...source, digest: digest ?? tapeDigest(bytes.value) } };
  };
  const artifact = await resolveRef(input.artifact, input.digest);
  if (!artifact.ok) return artifact;
  const compare =
    input.compare === undefined ? undefined : await resolveRef(input.compare, undefined);
  if (compare !== undefined && !compare.ok) return compare;
  const resolved = {
    ...input,
    artifact: artifact.value,
    ...(compare === undefined ? {} : { compare: compare.value }),
  };
  return runRhiDebugOperation(name, resolved as RhiDebugOperationInput, {
    ...context,
    // Each path is read once; replay keeps decoding the bytes whose digest was taken.
    readArtifact: async (ref) =>
      (ref.path === undefined ? undefined : files.get(ref.path)) ?? context.readArtifact(ref),
  }) as Promise<CommandResult<CliOutputs[N]>>;
}
