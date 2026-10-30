import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import type { AssetHandle } from '@forgeax/engine-types';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
// Real Dawn regression for the static/skinned shadow pipeline transition.
//
// The static shadow path uses the canonical all-true variant key (`''`) while
// the skinned path uses an explicit negative skinning axis.  Keep both entries
// in one production render so the pipeline layout and group-2 bind group must
// change at the same command-recording boundary.

import { World } from '@forgeax/engine-ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import type { Renderer } from '@forgeax/engine-render';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { describe, expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';

const WIDTH = 384;
const HEIGHT = 256;
const BYTES_PER_ROW = Math.ceil((WIDTH * 4) / 256) * 256;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

type MixedCapture = {
  readonly pixels: Uint8Array;
  readonly errors: readonly unknown[];
  /** Idle, unchanged idle, moved joint, restored joint; opaque control only. */
  readonly checkpoints: readonly Uint8Array[];
};

function staticMaterial(world: World): AssetHandle<'material'> {
  return testAssets(world)
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
        {
          name: 'ShadowCaster',
          program: { module: 'forgeax::default-shadow-caster' },
          renderState: {
            tags: { LightMode: 'ShadowCaster' },
            passKind: 'shadow-caster',
          },
        },
      ],
      values: {
        baseColor: [0.8, 0.35, 0.15, 1],
        metallic: 0.1,
        roughness: 0.55,
        emissive: [0, 0, 0],
        emissiveIntensity: 0,
        occlusionStrength: 1,
      },
    })
    .unwrap();
}

function skinnedMaterial(world: World, masked: boolean): AssetHandle<'material'> {
  return testAssets(world)
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::pbr-skin' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
        {
          name: 'ShadowCaster',
          program: { module: 'forgeax::default-shadow-caster' },
          renderState: {
            tags: { LightMode: 'ShadowCaster' },
            passKind: 'shadow-caster',
          },
        },
      ],
      values: {
        baseColor: [0.15, 0.45, 0.9, masked ? 0 : 1],
        alphaCutoff: masked ? 0.5 : 0,
        metallic: 0.1,
        roughness: 0.55,
        emissive: [0, 0, 0],
        emissiveIntensity: 0,
        occlusionStrength: 1,
      },
    })
    .unwrap();
}

function floorMaterial(world: World): AssetHandle<'material'> {
  return testAssets(world)
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: {
        baseColor: [0.75, 0.75, 0.75, 1],
        metallic: 0,
        roughness: 0.9,
        emissive: [0, 0, 0],
        emissiveIntensity: 0,
        occlusionStrength: 1,
      },
    })
    .unwrap();
}

function skinnedMesh(world: World): AssetHandle<'mesh'> {
  // Canonical interleaved order: position, normal, uv, tangent, skinIndex,
  // skinWeight (72 bytes / vertex). All vertices use joint zero.
  const attributes = {
    position: new Float32Array([-0.75, 0, 0, 0.75, 0, 0, 0, 1.2, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    skinIndex: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  };
  const packed = packInterleavedVertexAttributes(attributes, 3);
  if (!packed.ok) throw packed.error;
  const vertices = packed.value.vertices;
  return testAssets(world)
    .create({
      kind: 'mesh',
      vertices,
      indices: new Uint16Array([0, 1, 2]),
      attributes,
      aabb: new Float32Array([-0.75, 0, 0, 0.75, 1.2, 0]),
      materialSlots: [{ slotName: 'Default' }],
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          materialSlot: 0,
          topology: 'triangle-list',
        },
      ],
    })
    .unwrap();
}

function skeleton(world: World, missingBounds: boolean): AssetHandle<'skeleton'> {
  const inverseBindMatrices = new Float32Array(16);
  inverseBindMatrices[0] = 1;
  inverseBindMatrices[5] = 1;
  inverseBindMatrices[10] = 1;
  inverseBindMatrices[15] = 1;
  return testAssets(world)
    .create({
      kind: 'skeleton',
      inverseBindMatrices,
      jointCount: 1,
      ...(missingBounds ? {} : { bounds: new Float32Array([-1, -1, -1, 1, 1, 1]) }),
    })
    .unwrap();
}

function identityTransform(pos: readonly [number, number, number] = [0, 0, 0]) {
  return { pos, quat: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const };
}

function spawnMixedScene(
  world: World,
  castShadow: boolean,
  maskedSkin: boolean,
  omitSkin: boolean,
) {
  const staticMat = staticMaterial(world);
  const skinMat = skinnedMaterial(world, maskedSkin);
  const floorMat = floorMaterial(world);
  const skinMesh = skinnedMesh(world);
  const skinSkeleton = skeleton(world, maskedSkin);

  world.spawn(
    { component: Transform, data: { ...identityTransform([0, 5, 5]), scale: [10, 0.1, 10] } },
    {
      component: MeshFilter,
      data: {
        assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
      },
    },
    { component: MeshRenderer, data: { materials: [floorMat] } },
  );
  world.spawn(
    { component: Transform, data: identityTransform([0, 8, 18]) },
    {
      component: Camera,
      data: {
        fov: (45 * Math.PI) / 180,
        aspect: WIDTH / HEIGHT,
        near: 0.1,
        far: 100,
        clearColor: [0.02, 0.02, 0.03, 1],
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [0.25, -1, -0.45],
      color: [1, 1, 1],
      intensity: 1,
      castShadow,
      mapSize: 1024,
      cascadeCount: 3,
      depthBias: 0.005,
      normalBias: 0.05,
      shadowDistance: 50,
      shadowFilter: 2,
      shadowAngularRadius: 0.00465,
      maxPenumbraTexels: 32,
    },
  });

  const spawnStaticCaster = (x: number): void => {
    world.spawn(
      { component: Transform, data: { ...identityTransform([x, 7, 5]), scale: [0.8, 0.8, 0.8] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
        },
      },
      { component: MeshRenderer, data: { materials: [staticMat] } },
    );
  };
  // Entity order is intentional: static A -> skinned B -> static C.
  spawnStaticCaster(-3);
  const joint = world.spawn({ component: Transform, data: identityTransform([0, 7, 5]) }).unwrap();
  if (!omitSkin)
    world.spawn(
      { component: Transform, data: identityTransform() },
      { component: MeshFilter, data: { assetHandle: skinMesh } },
      { component: MeshRenderer, data: { materials: [skinMat] } },
      {
        component: Skin,
        data: {
          skeleton: skinSkeleton,
          joints: new Uint32Array([joint as unknown as number]),
        },
      },
    );
  spawnStaticCaster(3);
  return joint;
}

async function readPixels(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const buffer = device.createBuffer({
    size: BYTES_PER_ROW * HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_MODE_READ);
  const pixels = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return pixels;
}

function assertSkinShadowRefresh(renderer: Renderer, frame: number): void {
  if (frame !== 19 && frame !== 20) return;
  const views = renderer
    .inspect()
    .renderScene.gpuDriven.shadowViews.filter(
      (view) => view.identity.layer !== 'static' && view.candidateCount > 0,
    );
  expect(views.length).toBeGreaterThan(0);
  expect(
    views.every(
      (view) => view.cache === 'invalidated' && view.invalidationReason === 'skin-task-demand',
    ),
    JSON.stringify(views),
  ).toBe(true);
}

/**
 * Render both comparison worlds through one host/device.  The previous
 * fixture constructed and tore down a complete renderer twice; that paid the
 * native shader prewarm cost twice while adding no GPU coverage.  Keeping the
 * renderer alive across the two worlds preserves the shadow/no-shadow pixel
 * comparison and makes the Dawn test's startup cost proportional to one
 * renderer initialization.
 */
async function renderMixedPair(maskedSkin = false): Promise<{
  readonly shadow: MixedCapture;
  readonly baseline: MixedCapture;
}> {
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const originalRequestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const created = await originalRequestDevice(descriptor);
      device ??= created;
      return created;
    };
    return adapter;
  };
  const canvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor: { device: GPUDevice; format?: GPUTextureFormat }) {
          target ??= descriptor.device.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: descriptor.format ?? 'rgba8unorm',
            usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
            viewFormats: ['rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (target === undefined) throw new Error('render target requested before configure');
          return target;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let renderer: Renderer | undefined;
  let unsubscribe: (() => void) | undefined;
  const errors: unknown[] = [];
  try {
    const host = await constructRuntimeRendererHost(
      canvas,
      {},
      {
        shaderManifestUrl: ENGINE_MANIFEST_URL,
      },
    );
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    const activeRenderer = host.value.renderer;
    unsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'error') {
        errors.push(event.error);
      }
    });
    const renderWorld = async (castShadow: boolean, omitSkin = false): Promise<MixedCapture> => {
      const world = new World();
      const joint = spawnMixedScene(world, castShadow, maskedSkin, omitSkin);
      const attached = activeRenderer.attach(world);
      if (!attached.ok) throw attached.error;
      const checkpoints: Uint8Array[] = [];
      // The opaque pair also qualifies retained depth and pose invalidation
      // through 60 completed frames. The clipping control keeps its own scope.
      for (let frame = 0; frame < (maskedSkin ? 2 : 60); frame += 1) {
        if (frame === 20 || frame === 40)
          world.set(joint, Transform, identityTransform([frame === 20 ? 1.5 : 0, 7, 5])).unwrap();
        world.update(1 / 60).unwrap();
        const receipt = await drawReadyFrame(activeRenderer, {
          leases: [attached.value],
          camera: { lease: attached.value },
          environment: { lease: attached.value },
        });
        expect(receipt.presentation).toBe('ready');
        const completed = await receipt.completed;
        expect(completed.ok, 'Queue::submit completion').toBe(true);
        if (!completed.ok) throw completed.error;
        if (castShadow && !maskedSkin) assertSkinShadowRefresh(activeRenderer, frame);
        if (!maskedSkin && (frame === 9 || frame === 19 || frame === 39 || frame === 59)) {
          if (device === undefined || target === undefined) throw new Error('Missing Dawn target');
          checkpoints.push(await readPixels(device, target));
        }
      }
      if (device === undefined || target === undefined)
        throw new Error('Dawn target not initialized');
      await device.queue.onSubmittedWorkDone();
      const pixels = await readPixels(device, target);
      attached.value.dispose();
      return { pixels, errors: [...errors], checkpoints };
    };
    const shadow = await renderWorld(true);
    // Remove only the clipped skin for the mask control; retain neighboring
    // rigid shadows so their PCF contributions cancel exactly.
    const baseline = maskedSkin ? await renderWorld(true, true) : await renderWorld(false);
    return { shadow, baseline };
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    unsubscribe?.();
    renderer?.dispose();
    target?.destroy();
    device?.destroy();
  }
}

function regionDiff(a: Uint8Array, b: Uint8Array, x0: number, x1: number): number {
  let changed = 0;
  for (let y = Math.floor(HEIGHT * 0.32); y < HEIGHT; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = y * BYTES_PER_ROW + x * 4;
      if (
        Math.abs((a[index] ?? 0) - (b[index] ?? 0)) > 2 ||
        Math.abs((a[index + 1] ?? 0) - (b[index + 1] ?? 0)) > 2 ||
        Math.abs((a[index + 2] ?? 0) - (b[index + 2] ?? 0)) > 2
      ) {
        changed += 1;
      }
    }
  }
  return changed;
}

describe('mixed static/skinned shadow pipeline (Dawn)', () => {
  it('keeps alpha clipping on CPU skin residuals without conservative bounds', async () => {
    const { shadow, baseline } = await renderMixedPair(true);
    expect(shadow.errors).toEqual([]);
    expect(baseline.errors).toEqual([]);
    // A fully clipped skin must match an absent skin in both color and depth.
    // The opaque test below independently proves all three caster regions.
    const changed = shadow.pixels.reduce(
      (count, value, index) => count + Number(value !== baseline.pixels[index]),
      0,
    );
    expect(changed).toBe(0);
  }, 120000);

  it('submits static → skinned → static casters with zero validation errors', async () => {
    if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') {
      throw new Error('dawn-node navigator.gpu not injected');
    }
    const { shadow, baseline } = await renderMixedPair();
    expect(shadow.errors).toEqual([]);
    expect(baseline.errors).toEqual([]);
    expect(shadow.pixels.length).toBeGreaterThan(0);
    expect(baseline.pixels.length).toBe(shadow.pixels.length);

    // Each caster owns a separate x-region. Comparing against the identical
    // no-shadow scene proves the depth pass contributed in all three regions,
    // rather than merely proving that a color frame was non-black.
    const regions = [
      [0, Math.floor(WIDTH / 3)],
      [Math.floor(WIDTH / 3), Math.floor((2 * WIDTH) / 3)],
      [Math.floor((2 * WIDTH) / 3), WIDTH],
    ] as const;
    for (const [x0, x1] of regions) {
      expect(regionDiff(shadow.pixels, baseline.pixels, x0, x1)).toBeGreaterThan(0);
    }
    expect(shadow.checkpoints).toHaveLength(4);
    expect(baseline.checkpoints).toHaveLength(4);
    for (const capture of [shadow, baseline]) {
      expect(capture.checkpoints[1]).toEqual(capture.checkpoints[0]);
      expect(capture.checkpoints[3]).toEqual(capture.checkpoints[0]);
    }
    // Below the casters, subtract the matching unshadowed pose: changing color
    // geometry alone cannot satisfy this actual receiver-shadow falsifier.
    let movedShadowPixels = 0;
    for (let y = Math.ceil(HEIGHT * 0.67); y < HEIGHT; y++)
      for (let x = Math.floor(WIDTH / 3); x < Math.floor((2 * WIDTH) / 3); x++) {
        const at = y * BYTES_PER_ROW + x * 4;
        for (let channel = 0; channel < 3; channel++) {
          const initial =
            (shadow.checkpoints[0]?.[at + channel] ?? 0) -
            (baseline.checkpoints[0]?.[at + channel] ?? 0);
          const moved =
            (shadow.checkpoints[2]?.[at + channel] ?? 0) -
            (baseline.checkpoints[2]?.[at + channel] ?? 0);
          if (Math.abs(initial - moved) > 2) {
            movedShadowPixels++;
            break;
          }
        }
      }
    expect(movedShadowPixels).toBeGreaterThan(0);
  }, 120000);
});
