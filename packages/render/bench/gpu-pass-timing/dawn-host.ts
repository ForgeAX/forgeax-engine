import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  createDawnGpuPassTimingFixture,
  type DawnGpuPassTimingFixture,
} from './dawn-fixture.js';
import type { Renderer } from '../../src/render-contract.js';
import type {
  GpuPassTimingBenchFrame,
  GpuPassTimingBenchHost,
  GpuPassTimingBenchObservation,
} from './runner.js';

interface DawnAdapterInfo {
  readonly vendor?: unknown;
  readonly architecture?: unknown;
  readonly device?: unknown;
  readonly description?: unknown;
}

interface DawnAdapter {
  readonly info?: DawnAdapterInfo;
}

interface DawnGpu {
  requestAdapter(options?: unknown): Promise<DawnAdapter | null>;
}

type DawnFixture = DawnGpuPassTimingFixture;

interface DawnGlobalsModule {
  readonly create: (flags: readonly string[]) => DawnGpu;
  readonly globals: Record<string, unknown>;
}

interface InstalledDawn {
  readonly gpu: DawnGpu;
  readonly restore: () => void;
}

function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

function sourceHead(): string {
  const configured = process.env.FORGEAX_GPU_PASS_TIMING_SOURCE_HEAD;
  if (configured !== undefined && /^[0-9a-f]{40}$/.test(configured)) return configured;
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function installDawn(): Promise<InstalledDawn> {
  const globalScope = globalThis as Record<string, unknown>;
  const hadNavigator = Object.hasOwn(globalScope, 'navigator');
  const previousNavigator = globalScope.navigator;
  const navigatorScope =
    typeof previousNavigator === 'object' && previousNavigator !== null
      ? (previousNavigator as Record<string, unknown>)
      : {};
  const hadGpu = Object.hasOwn(navigatorScope, 'gpu');
  const previousGpu = navigatorScope.gpu;
  const { create, globals } = (await import('@forgeax/engine-dawn-node')) as unknown as DawnGlobalsModule;
  Object.assign(globalScope, globals);
  if (!hadNavigator) {
    Object.defineProperty(globalScope, 'navigator', {
      value: navigatorScope,
      configurable: true,
      writable: true,
    });
  }
  const gpu = create([]);
  Object.defineProperty(navigatorScope, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  return {
    gpu,
    restore: () => {
      if (hadGpu) {
        Object.defineProperty(navigatorScope, 'gpu', {
          value: previousGpu,
          configurable: true,
          writable: true,
        });
      } else {
        delete navigatorScope.gpu;
      }
      if (!hadNavigator) delete globalScope.navigator;
    },
  };
}

function adapterIdentity(adapter: DawnAdapter): string {
  const info = adapter.info;
  return [info?.vendor, info?.architecture, info?.device, info?.description]
    .map(text)
    .filter((value) => value !== 'unknown')
    .join('/') || 'unknown';
}

function drawFrame(
  fixture: DawnFixture,
  timingEnabled: boolean,
  identity: GpuPassTimingBenchHost['source'],
  runner: string,
  backend: string,
  workload: string,
): GpuPassTimingBenchFrame {
  const inspection = fixture.renderer.inspect();
  const startedAt = performance.now();
  const updated = fixture.world.update(1 / 60);
  if (!updated.ok) throw new Error(updated.error?.hint ?? 'benchmark world update failed');
  const drawn = fixture.renderer.draw({
    leases: [fixture.lease],
    camera: { lease: fixture.lease },
    environment: { lease: fixture.lease },
  });
  if (!drawn.ok || drawn.value === undefined) {
    throw new Error(drawn.ok ? 'benchmark draw returned no receipt' : drawn.error.hint);
  }
  const frameDurationMicroseconds = Math.max((performance.now() - startedAt) * 1000, 0.001);
  return {
    receipt: drawn.value,
    frameDurationMicroseconds,
    identity: {
      sourceHead: identity.sourceHead,
      runner,
      backend,
      workload,
      frameGeneration: `device-${inspection.frame.deviceGeneration}:graph-standard`,
    },
    // The off-path proof is host-level evidence supplied below. It must stay
    // true on both paired windows; the on window is not itself an off-path
    // sample.
    offPathExactZero: true,
    observe: async (receipt: unknown): Promise<GpuPassTimingBenchObservation> => {
      const observed = await fixture.renderer.observe(
        receipt as Parameters<Renderer['observe']>[0],
        { include: timingEnabled ? ['timings'] : [] },
      );
      if (!observed.ok) return { status: 'failed' };
      if (!timingEnabled) return { status: 'complete' };
      switch (observed.value.timings?.status) {
        case 'complete':
          return { status: 'complete', frame: observed.value.timings.frame };
        case 'partial':
          return { status: 'partial', frame: observed.value.timings.frame };
        case 'unavailable':
        case 'failed':
        case undefined:
          return { status: 'failed' };
      }
    },
  };
}

export async function createGpuPassTimingBenchHost(): Promise<GpuPassTimingBenchHost & {
  readonly dispose: () => Promise<void>;
}> {
  const installed = await installDawn();
  let offFixture: DawnFixture | undefined;
  let onFixture: DawnFixture | undefined;
  try {
    const adapter = await installed.gpu.requestAdapter();
    if (adapter === null) throw new Error('Dawn requestAdapter returned null');
    const backend = adapterIdentity(adapter);
    offFixture = await createDawnGpuPassTimingFixture({ timingEnabled: false });
    onFixture = await createDawnGpuPassTimingFixture({ timingEnabled: true });
    const source = { sourceHead: sourceHead(), package: '@forgeax/engine-render' } as const;
    const runner = `dawn-node/${process.version}`;
    const workload = '32x32:standard-renderer-minimal:standard';
    let offCpuMicroseconds = 0;
    let onCpuMicroseconds = 0;
    let offCpuFrames = 0;
    let onCpuFrames = 0;
    const host: GpuPassTimingBenchHost & { readonly dispose: () => Promise<void> } = {
      source,
      runner: { name: 'dawn-node-gpu-pass-timing', version: '1', os: `${process.platform}-${process.arch}`, browser: null },
      backend: { kind: 'webgpu', adapter: backend, driver: backend, browser: 'dawn-node', realGpu: true },
      workload: { resolution: { width: 32, height: 32 }, scene: 'standard-renderer-minimal', pipeline: 'standard' },
      get cpuOverheadPercent() {
        const offAverage = offCpuMicroseconds / Math.max(1, offCpuFrames);
        const onAverage = onCpuMicroseconds / Math.max(1, onCpuFrames);
        return ((onAverage - offAverage) / offAverage) * 100;
      },
      draw: async (timingEnabled) => {
        const fixture = timingEnabled ? onFixture : offFixture;
        if (fixture === undefined) throw new Error('benchmark fixture is not initialized');
        const frame = drawFrame(fixture, timingEnabled, source, 'dawn-node-gpu-pass-timing', backend, workload);
        if (timingEnabled) {
          onCpuMicroseconds += frame.frameDurationMicroseconds;
          onCpuFrames += 1;
        } else {
          offCpuMicroseconds += frame.frameDurationMicroseconds;
          offCpuFrames += 1;
        }
        return frame;
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
        const fixtures = [offFixture, onFixture];
        offFixture = undefined;
        onFixture = undefined;
        let firstError: unknown;
        for (const fixture of fixtures) {
          if (fixture === undefined) continue;
          const disposed = await fixture.renderer.dispose();
          await fixture.releaseTargets();
          if (!disposed.ok && firstError === undefined) firstError = disposed.error;
        }
        installed.restore();
        if (firstError !== undefined) {
          throw new Error(`Dawn benchmark dispose failed: ${String(firstError)}`);
        }
      },
    };
    return host;
  } catch (error) {
    for (const fixture of [offFixture, onFixture]) {
      if (fixture !== undefined) {
        await fixture.renderer.dispose();
        await fixture.releaseTargets();
      }
    }
    installed.restore();
    throw error;
  }
}

export default createGpuPassTimingBenchHost;
