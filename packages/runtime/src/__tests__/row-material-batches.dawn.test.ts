import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
// Real Dawn regression for row-material GPU batches: unique Standard materials
// of one batch class share a single GPU-driven batch, and each member still
// shades with the values of its own GPU Scene material row. A value edit of
// one material changes only its own cube.

import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { Camera, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';

const WIDTH = 64;
const HEIGHT = 64;
const BYTES_PER_ROW = 256;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const ENGINE_MANIFEST_URL = shaderManifestUrl(
  await (await import('@forgeax/engine-vite-plugin-shader')).buildEngineShaderManifest(),
);

const COLORS = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
] as const;
// Quadrant centers in pixels: top-left, top-right, bottom-left, bottom-right.
const PROBES = [
  [16, 16],
  [48, 16],
  [16, 48],
  [48, 48],
] as const;

function emissive(color: readonly number[]) {
  return Materials.standard({
    baseColor: [0, 0, 0, 1],
    roughness: 1,
    emissive: [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0],
    emissiveIntensity: 1,
  });
}

type Cube = Parameters<World['set']>[0];

/** One retained-scene edit: `cubes` are in quadrant order, `assign` gives a cube a new material. */
type QuadrantEdit = (scene: {
  readonly world: World;
  readonly cubes: readonly Cube[];
  readonly assign: (cube: number, color: readonly number[]) => void;
  readonly editColor: (cube: number, color: readonly number[]) => void;
}) => void;

// A value-only edit of the third material: magenta replaces blue.
const VALUE_EDIT: QuadrantEdit = ({ editColor }) => editColor(2, [1, 0, 1]);

async function renderQuadrants(edits: readonly QuadrantEdit[] = [VALUE_EDIT]): Promise<{
  before: number[][];
  after: number[][];
  steps: number[][][];
  batchCount: number | undefined;
  errors: unknown[];
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

  const readQuadrants = async (): Promise<number[][]> => {
    if (device === undefined || target === undefined) throw new Error('Dawn target missing');
    const buffer = device.createBuffer({
      size: BYTES_PER_ROW * HEIGHT,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_MODE_READ);
    const pixels = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    const bgra = target.format === 'bgra8unorm';
    return PROBES.map(([x, y]) => {
      const at = y * BYTES_PER_ROW + x * 4;
      const rgb = [pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0];
      return bgra ? [rgb[2] ?? 0, rgb[1] ?? 0, rgb[0] ?? 0] : rgb;
    });
  };

  let renderer: Renderer | undefined;
  const errors: unknown[] = [];
  try {
    const host = await constructRuntimeRendererHost(
      canvas,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const world = new World();
    const assets = testAssets(world);
    const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    const materials = COLORS.map((color) => assets.create(emissive(color)).unwrap());
    const cubes: Cube[] = [];
    for (const [index, material] of materials.entries()) {
      const x = index % 2 === 0 ? -1.1 : 1.1;
      const y = index < 2 ? 1.1 : -1.1;
      const cube = world.spawn(
        {
          component: Transform,
          data: { pos: [x, y, 0], quat: [0, 0, 0, 1], scale: [1.6, 1.6, 1] },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      );
      cubes.push(cube.unwrap());
    }
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      {
        component: Camera,
        data: {
          fov: (45 * Math.PI) / 180,
          aspect: 1,
          near: 0.1,
          far: 100,
          clearColor: [0, 0, 0, 1],
        },
      },
    );
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const draw = async (frames: number) => {
      for (let frame = 0; frame < frames; frame += 1) {
        world.update(1 / 60).unwrap();
        await drawReadyFrame(renderer as Renderer, {
          leases: [attached.value],
          camera: { lease: attached.value },
          environment: { lease: attached.value },
        });
      }
    };
    await draw(3);
    const before = await readQuadrants();
    const inspection = renderer.inspect() as unknown as {
      renderScene?: { gpuDriven?: { batchCount?: number } };
    };
    const batchCount = inspection.renderScene?.gpuDriven?.batchCount;
    const assigned = [...materials];
    const scene = {
      world,
      cubes,
      assign: (cube: number, color: readonly number[]) => {
        const material = assets.create(emissive(color)).unwrap();
        assigned[cube] = material;
        world.set(cubes[cube] as Cube, MeshRenderer, { materials: [material] }).unwrap();
      },
      editColor: (cube: number, color: readonly number[]) => {
        const material = assigned[cube];
        if (material === undefined) throw new Error('quadrant has no material');
        assets.update(material, {
          values: { emissive: [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0] },
        });
      },
    };
    const steps: number[][][] = [];
    for (const edit of edits) {
      edit(scene);
      await draw(3);
      steps.push(await readQuadrants());
    }
    attached.value.dispose();
    return { before, after: steps[steps.length - 1] ?? before, steps, batchCount, errors };
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    renderer?.dispose();
    target?.destroy();
    device?.destroy();
  }
}

const dominant = (rgb: readonly number[]) =>
  rgb.map((channel) => (channel > 128 ? 1 : channel < 64 ? 0 : -1));

describe('row-material GPU batches (Dawn)', () => {
  it('shades each member of one unique-material batch with its own material row', async () => {
    const { before, after, batchCount, errors } = await renderQuadrants();
    expect(errors).toEqual([]);
    expect(batchCount).toBe(1);
    expect(before.map(dominant)).toEqual(COLORS.map((color) => [...color]));
    expect(after.map(dominant)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [1, 0, 1],
      [1, 1, 0],
    ]);
  }, 180000);

  it('shades swapped members with their own rows while released material slots are reused', async () => {
    // Each assignment only rewrites the edited cube's row: its retained
    // neighbours keep their cached material slots while the released slot
    // of a replaced material is reallocated to the next new material.
    const { steps, errors } = await renderQuadrants([
      ({ assign }) => assign(2, [0, 1, 1]),
      ({ assign }) => assign(0, [1, 1, 1]),
      ({ assign }) => assign(3, [1, 0, 1]),
      ({ editColor }) => editColor(1, [0, 0, 1]),
    ]);
    expect(errors).toEqual([]);
    expect(steps.map((step) => step.map(dominant))).toEqual([
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 1, 1],
        [1, 1, 0],
      ],
      [
        [1, 1, 1],
        [0, 1, 0],
        [0, 1, 1],
        [1, 1, 0],
      ],
      [
        [1, 1, 1],
        [0, 1, 0],
        [0, 1, 1],
        [1, 0, 1],
      ],
      [
        [1, 1, 1],
        [0, 0, 1],
        [0, 1, 1],
        [1, 0, 1],
      ],
    ]);
  }, 180000);
});
