import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { createRenderer, exposeRenderer } from '../assembly/factory.js';
import { Camera } from '../components/camera.js';
import type { GpuPassTimingFrame } from '../record/gpu-pass-timing/contract.js';
import type { FrameReceipt, Renderer, RenderWorldLease } from '../render-contract.js';

export interface BrowserGpuPassTimingBenchDraw {
  readonly token: number;
  readonly frameDurationMicroseconds: number;
}

export interface BrowserGpuPassTimingBenchObservation {
  readonly status: 'complete' | 'partial' | 'failed' | 'unavailable';
  readonly frame?: GpuPassTimingFrame | undefined;
}

export interface BrowserGpuPassTimingBenchController {
  readonly supported: boolean;
  readonly realGpu: boolean;
  readonly backend: string;
  readonly frameGeneration: string;
  readonly draw: (timingEnabled: boolean) => BrowserGpuPassTimingBenchDraw;
  readonly observe: (token: number) => Promise<BrowserGpuPassTimingBenchObservation>;
  readonly dispose: () => Promise<void>;
}

interface BrowserTimingFixture {
  readonly renderer: Renderer;
  readonly world: World;
  readonly lease: RenderWorldLease;
  readonly canvas: HTMLCanvasElement;
}

interface BrowserPendingFrame {
  readonly fixture: BrowserTimingFixture;
  readonly receipt: FrameReceipt;
  readonly timingEnabled: boolean;
}

function createTimingCamera(world: World): void {
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      {
        component: Camera,
        data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
      },
    )
    .unwrap();
  world.update(1 / 60).unwrap();
}

async function createBrowserTimingFixture(timingEnabled: boolean): Promise<BrowserTimingFixture> {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  canvas.style.width = '32px';
  canvas.style.height = '32px';
  document.body.append(canvas);
  let renderer: Renderer | undefined;
  try {
    const implementation = await createRenderer(
      canvas,
      timingEnabled
        ? {
            rhi,
            gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 2, retentionFrames: 8 },
          }
        : { rhi },
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    const ready = await implementation.initialization;
    if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.hint}`);
    renderer = exposeRenderer(implementation);
    const world = new World();
    const attached = renderer.attach(world);
    if (!attached.ok) throw new Error(attached.error.hint);
    createTimingCamera(world);
    return { renderer, world, lease: attached.value, canvas };
  } catch (error) {
    if (renderer !== undefined) await renderer.dispose();
    canvas.remove();
    throw error;
  }
}

function drawTimingFrame(fixture: BrowserTimingFixture): {
  readonly receipt: FrameReceipt;
  readonly frameDurationMicroseconds: number;
} {
  const startedAt = performance.now();
  fixture.world.update(1 / 60).unwrap();
  const drawn = fixture.renderer.draw({
    leases: [fixture.lease],
    camera: { lease: fixture.lease },
    environment: { lease: fixture.lease },
  });
  if (!drawn.ok) throw new Error(drawn.error.hint);
  return {
    receipt: drawn.value,
    frameDurationMicroseconds: Math.max((performance.now() - startedAt) * 1000, 0.001),
  };
}

export async function observeBrowserGpuPassTimingDisabled() {
  const fixture = await createBrowserTimingFixture(false);
  try {
    const { receipt } = drawTimingFrame(fixture);
    const requested = await fixture.renderer.observe(receipt, { include: ['timings'] });
    const omitted = await fixture.renderer.observe(receipt, { include: ['draws'] });
    if (!requested.ok) throw requested.error;
    if (!omitted.ok) throw omitted.error;
    return { requested: requested.value, omitted: omitted.value };
  } finally {
    await fixture.renderer.dispose();
    fixture.canvas.remove();
  }
}

function adapterString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function createBrowserGpuPassTimingBenchController(): Promise<BrowserGpuPassTimingBenchController> {
  const offFixture = await createBrowserTimingFixture(false);
  let onFixture: BrowserTimingFixture | undefined;
  try {
    const timingFixture = await createBrowserTimingFixture(true);
    onFixture = timingFixture;
    const adapter = await navigator.gpu?.requestAdapter();
    const adapterInfo = adapter?.info as Record<string, unknown> | undefined;
    const adapterParts = [
      adapterInfo?.vendor,
      adapterInfo?.architecture,
      adapterInfo?.device,
      adapterInfo?.description,
    ]
      .map(adapterString)
      .filter((part): part is string => part !== undefined);
    const backend = adapterParts.join('/') || 'browser-adapter-unknown';
    const realGpu =
      adapter !== null &&
      adapter !== undefined &&
      !/swiftshader|llvmpipe|software|basic renderer/i.test(backend);
    const inspection = timingFixture.renderer.inspect();
    const pending = new Map<number, BrowserPendingFrame>();
    let nextToken = 1;
    let disposed = false;

    return {
      supported: inspection.capabilities.timestampQuery,
      realGpu,
      backend,
      frameGeneration: `device-${inspection.frame.deviceGeneration}:graph-standard`,
      draw: (timingEnabled) => {
        if (disposed) throw new Error('browser GPU pass timing controller is disposed');
        const fixture = timingEnabled ? timingFixture : offFixture;
        const drawn = drawTimingFrame(fixture);
        const token = nextToken;
        nextToken += 1;
        pending.set(token, {
          fixture,
          receipt: drawn.receipt,
          timingEnabled,
        });
        return { token, frameDurationMicroseconds: drawn.frameDurationMicroseconds };
      },
      observe: async (token) => {
        const frame = pending.get(token);
        if (frame === undefined) throw new Error(`unknown browser timing frame token: ${token}`);
        pending.delete(token);
        const observed = await frame.fixture.renderer.observe(frame.receipt, {
          include: frame.timingEnabled ? ['timings'] : [],
        });
        if (!observed.ok) return { status: 'failed' };
        if (!frame.timingEnabled) return { status: 'complete' };
        switch (observed.value.timings?.status) {
          case 'complete':
            return { status: 'complete', frame: observed.value.timings.frame };
          case 'partial':
            return { status: 'partial', frame: observed.value.timings.frame };
          case 'unavailable':
            return { status: 'unavailable' };
          case 'failed':
          case undefined:
            return { status: 'failed' };
        }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        pending.clear();
        let firstError: unknown;
        for (const fixture of [offFixture, timingFixture]) {
          const disposedRenderer = await fixture.renderer.dispose();
          fixture.canvas.remove();
          if (!disposedRenderer.ok && firstError === undefined) firstError = disposedRenderer.error;
        }
        if (firstError !== undefined)
          throw new Error(`browser benchmark dispose failed: ${String(firstError)}`);
      },
    };
  } catch (error) {
    await offFixture.renderer.dispose();
    offFixture.canvas.remove();
    if (onFixture !== undefined) {
      await onFixture.renderer.dispose();
      onFixture.canvas.remove();
    }
    throw error;
  }
}

export async function runBrowserGpuPassTiming(
  options: { readonly suppressRaster?: boolean } = {},
): Promise<{
  readonly supported: boolean;
  readonly frames: number;
  readonly unavailable: boolean;
  readonly measuredPasses: number;
  readonly visible: boolean;
  readonly rasterSuppressed: boolean;
}> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  document.body.append(canvas);
  if (options.suppressRaster === true) canvas.style.visibility = 'hidden';
  const implementation = await createRenderer(
    canvas,
    { rhi, gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 2, retentionFrames: 8 } },
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  const ready = await implementation.initialization;
  if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.hint}`);
  const renderer = exposeRenderer(implementation);
  const world = new World();
  const attached = renderer.attach(world);
  if (!attached.ok) throw new Error(attached.error.hint);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      {
        component: Camera,
        data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
      },
    )
    .unwrap();
  world.update(1 / 60).unwrap();
  const supported = renderer.inspect().capabilities.timestampQuery;
  let frames = 0;
  let unavailable = false;
  let measuredPasses = 0;
  try {
    for (let index = 0; index < 3; index += 1) {
      world.update(1 / 60).unwrap();
      const drawn = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      if (!drawn.ok) continue;
      const observed = await renderer.observe(drawn.value, { include: ['timings'] });
      if (!observed.ok) continue;
      frames += 1;
      if (observed.value.timings?.status === 'unavailable') {
        unavailable = true;
        if ('tick' in observed.value.timings || 'durationNanoseconds' in observed.value.timings) {
          throw new Error('unavailable timing observation exposed numeric GPU facts');
        }
        continue;
      }
      if (
        observed.value.timings?.status === 'complete' ||
        observed.value.timings?.status === 'partial'
      ) {
        measuredPasses += observed.value.timings.frame.passes.filter(
          (pass) => pass.status === 'measured',
        ).length;
      }
    }
  } finally {
    await renderer.dispose();
    canvas.remove();
  }
  return {
    supported,
    frames,
    unavailable,
    measuredPasses,
    visible: !document.body.contains(canvas),
    rasterSuppressed: options.suppressRaster === true,
  };
}
