// Node child-process carrier for the lifecycle gate. Keep this on the built
// package surface so a fresh process does not spend its watchdog recompiling
// the TypeScript render graph or re-cooking shader sources.
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Camera } from '@forgeax/engine-render';
import { constructRendererHost } from '@forgeax/engine-render/internal/construct-renderer';

const WIDTH = 32;
const HEIGHT = 32;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GPU_TEXTURE_USAGE_COPY_SRC = 0x01;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

async function manifestUrl() {
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

function canvasForTarget(target, onConfiguredDevice) {
  let configuration = {
    device: undefined,
    format: 'rgba8unorm',
    viewFormats: [],
  };
  return {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind) {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor) {
          configuration = {
            device: descriptor.device,
            format: descriptor.format ?? 'rgba8unorm',
            viewFormats: descriptor.viewFormats ?? [],
          };
          if (descriptor.device !== undefined) onConfiguredDevice(descriptor.device);
        },
        unconfigure() {},
        getConfiguration() {
          return null;
        },
        getCurrentTexture() {
          return target(configuration);
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

async function createHost(canvas, timingEnabled) {
  const shaderManifestUrl = await manifestUrl();
  const created = await constructRendererHost(
    canvas,
    {
      rhi,
      ...(timingEnabled
        ? { gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 2, retentionFrames: 8 } }
        : {}),
    },
    { shaderManifestUrl },
  );
  if (!created.ok) throw new Error(`${created.error.code}: ${created.error.hint}`);
  return created.value.renderer;
}

export async function createDawnGpuPassTimingFixture(options = {}) {
  if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') {
    throw new Error('dawn-node navigator.gpu is unavailable');
  }

  const targets = [];
  const devices = new Set();
  const getTarget = ({ device, format, viewFormats }) => {
    if (device === undefined) throw new Error('Dawn GPUDevice was not configured');
    const texture = device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format,
      ...(viewFormats.length > 0 ? { viewFormats: [...viewFormats] } : {}),
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
    });
    targets.push({ device, texture });
    return texture;
  };

  const releaseTargets = async () => {
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
