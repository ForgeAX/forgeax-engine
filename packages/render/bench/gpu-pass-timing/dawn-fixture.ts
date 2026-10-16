import { World } from '@forgeax/engine-ecs';
import type { RhiInstance } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { readFile } from 'node:fs/promises';
import { createRenderer, exposeRenderer } from '../../src/assembly/factory.js';
import { Camera } from '../../src/components/camera.js';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
} from '../../src/gpu-texture-usage.js';
import type { Renderer, RenderWorldLease } from '../../src/render-contract.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDTH = 32;
const HEIGHT = 32;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface DawnGpuPassTimingFixture {
  readonly renderer: Renderer;
  readonly world: World;
  readonly lease: RenderWorldLease;
  readonly releaseTargets: () => Promise<void>;
}

export interface DawnGpuPassTimingFixtureOptions {
  readonly timingEnabled?: boolean;
}

async function manifestUrl(): Promise<string> {
  for (const relativePath of [
    'shared-app-inputs/shaders/manifest.json',
    'shared-build-inputs/shaders/manifest.json',
  ]) {
    try {
      const manifest = await readFile(resolve(REPO_ROOT, relativePath), 'utf8');
      return `data:application/json,${encodeURIComponent(manifest)}`;
    } catch {
      // The CI consumer hydrates shared-app-inputs; local engine builds use
      // shared-build-inputs. Continue to the next producer-owned path.
    }
  }
  throw new Error('Dawn GPU pass timing fixture requires a built shader manifest');
}

interface SurfaceConfiguration {
  readonly device: GPUDevice | undefined;
  readonly format: GPUTextureFormat;
  readonly viewFormats: readonly GPUTextureFormat[];
}

function canvasForTarget(
  target: (configuration: SurfaceConfiguration) => GPUTexture,
  onConfiguredDevice: (device: GPUDevice) => void,
): HTMLCanvasElement {
  let configuration: SurfaceConfiguration = {
    device: undefined,
    format: 'rgba8unorm',
    viewFormats: [],
  };
  return {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure: (descriptor: {
          readonly device?: GPUDevice;
          readonly format?: GPUTextureFormat;
          readonly viewFormats?: readonly GPUTextureFormat[];
        }) => {
          configuration = {
            device: descriptor.device,
            format: descriptor.format ?? 'rgba8unorm',
            viewFormats: descriptor.viewFormats ?? [],
          };
          if (descriptor.device !== undefined) onConfiguredDevice(descriptor.device);
        },
        unconfigure: () => undefined,
        getConfiguration: () => null,
        getCurrentTexture: () => target(configuration),
      };
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

async function createHost(canvas: HTMLCanvasElement, timingEnabled: boolean): Promise<Renderer> {
  const implementation = await createRenderer(
    canvas,
    {
      rhi: rhi as unknown as RhiInstance,
      ...(timingEnabled
        ? { gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 2, retentionFrames: 8 } }
        : {}),
    },
    { shaderManifestUrl: await manifestUrl() },
  );
  const ready = await implementation.initialization;
  if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.hint}`);
  return exposeRenderer(implementation);
}

export async function createDawnGpuPassTimingFixture(
  options: DawnGpuPassTimingFixtureOptions = {},
): Promise<DawnGpuPassTimingFixture> {
  if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') {
    throw new Error('dawn-node navigator.gpu is unavailable');
  }

  const targets: Array<{ readonly device: GPUDevice; readonly texture: GPUTexture }> = [];
  const devices = new Set<GPUDevice>();
  const getTarget = ({ device, format, viewFormats }: SurfaceConfiguration): GPUTexture => {
    if (device === undefined) throw new Error('Dawn GPUDevice was not configured');
    const target = device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format,
      ...(viewFormats.length > 0 ? { viewFormats: [...viewFormats] } : {}),
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
    });
    targets.push({ device, texture: target });
    return target;
  };

  const releaseTargets = async (): Promise<void> => {
    for (const device of devices) {
      try {
        await device.queue.onSubmittedWorkDone();
      } catch {
        // Cleanup remains best-effort when Dawn has already lost the device.
      }
    }
    for (const created of targets) created.texture.destroy();
    targets.length = 0;
    for (const device of devices) device.destroy();
    devices.clear();
  };

  const renderer = await createHost(
    canvasForTarget(getTarget, (device) => devices.add(device)),
    options.timingEnabled !== false,
  );

  const world = new World();
  const attached = renderer.attach(world);
  if (!attached.ok) {
    await renderer.dispose();
    await releaseTargets();
    throw new Error(attached.error.hint);
  }
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      {
        component: Camera,
        data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
      },
    )
    .unwrap();
  world.update(1 / 60).unwrap();
  return { renderer, world, lease: attached.value, releaseTargets };
}
