import { World } from '@forgeax/engine-ecs';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
  type V7Tape,
  type WorkEntry,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { type SaveEvidence, unwrap } from './specular-aa.fixture';

export type RenderPath = 'forward' | 'deferred';

/** White metal, mirror to fully rough: the furnace roster. */
export const FURNACE_ROUGHNESS = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;
export const FURNACE_SIZE = 192;
const FOV = Math.PI / 3;
const DEPTH = 6;
const RADIUS = 0.9;
const SPACING = 2.2;
const CENTERS = FURNACE_ROUGHNESS.map((_, i) => [
  ((i % 3) - 1) * SPACING,
  (i < 3 ? 1 : -1) * (SPACING / 2),
  -DEPTH,
]);

/** Authored and naga-normalized forms of the separated environment response. */
export const COMPENSATED =
  /return (EnvironmentScattering\w*)\((single\w*), ([A-Za-z_]\w*), (ems\w*)\);/g;
/** Preserve directional single scattering; remove only the irradiance term. */
const singleScatter = (wgsl: string) =>
  wgsl.replace(COMPENSATED, 'return $1($2, vec3<f32>(0.0), $4);');

/** The same engine manifest with every composed program reduced to single scattering. */
export function singleScatterManifest(
  manifest: Awaited<ReturnType<typeof buildEngineShaderManifest>>,
) {
  let patched = 0;
  const sources = new Map<string, string>();
  const replace = (source: string) => {
    let stripped = sources.get(source);
    if (stripped === undefined) {
      stripped = singleScatter(source);
      sources.set(source, stripped);
    }
    if (stripped !== source) patched++;
    return stripped;
  };
  const changed = {
    ...manifest,
    entries: manifest.entries.map((entry) => ({ ...entry, wgsl: replace(entry.wgsl) })),
    materialShaders: manifest.materialShaders.map((material) => ({
      ...material,
      composedWgsl: replace(material.composedWgsl),
      variants: material.variants.map((variant) => ({
        ...variant,
        composedWgsl: replace(variant.composedWgsl),
      })),
    })),
  };
  return { manifest: changed, patched };
}

/** A panorama of constant linear radiance one: the white furnace. */
function uniformEquirect(world: World) {
  const data = new Uint8Array(16 * 8 * 8);
  const view = new DataView(data.buffer);
  for (let i = 0; i < 16 * 8 * 4; i++) view.setUint16(i * 2, 0x3c00, true);
  return world.allocSharedRef('EquirectAsset', {
    kind: 'equirect',
    width: 16,
    height: 8,
    format: 'rgba16float',
    colorSpace: 'linear',
    data,
  });
}

function buildFurnaceScene(world: World) {
  const sphere = world.allocSharedRef('MeshAsset', createSphereGeometry(RADIUS, 96, 64).unwrap());
  FURNACE_ROUGHNESS.forEach((roughness, i) => {
    const metal = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 1, roughness }),
    );
    world
      .spawn(
        { component: Transform, data: { pos: CENTERS[i] as [number, number, number] } },
        { component: MeshFilter, data: { assetHandle: sphere } },
        { component: MeshRenderer, data: { materials: [metal] } },
      )
      .unwrap();
  });
  const equirect = uniformEquirect(world);
  world.spawn({ component: Skylight, data: { equirect, intensity: 1 } }).unwrap();
  world
    .spawn({ component: SkyboxBackground, data: { equirect, mode: SKYBOX_MODE_CUBEMAP } })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: FOV,
          aspect: 1,
          near: 0.1,
          far: 30,
          antialias: 0,
          bloom: 0,
          tonemap: TONEMAP_LINEAR,
        },
      },
    )
    .unwrap();
}

/**
 * Analytic pixel classes: `spheres[i]` keeps the inner 80% of sphere i's
 * silhouette radius (grazing texels whose LUT row is noisiest excluded) and
 * `background` sees only the skybox with a two-pixel margin.
 */
function furnaceRegions() {
  const tangent = Math.tan(FOV / 2);
  const margin = 2 * ((2 * DEPTH * tangent) / FURNACE_SIZE);
  const spheres = CENTERS.map(() => [] as number[]);
  const background: number[] = [];
  for (let y = 0; y < FURNACE_SIZE; y++)
    for (let x = 0; x < FURNACE_SIZE; x++) {
      const direction = [
        (((x + 0.5) / FURNACE_SIZE) * 2 - 1) * tangent,
        (1 - ((y + 0.5) / FURNACE_SIZE) * 2) * tangent,
        -1,
      ];
      const length = Math.hypot(...direction);
      const distances = CENTERS.map((center) => {
        const along = center.reduce(
          (sum, value, axis) => sum + (value * (direction[axis] ?? 0)) / length,
          0,
        );
        return Math.hypot(
          ...center.map((value, axis) => value - (along * (direction[axis] ?? 0)) / length),
        );
      });
      const index = y * FURNACE_SIZE + x;
      distances.forEach((distance, i) => {
        if (distance < RADIUS * 0.8) spheres[i]?.push(index);
      });
      if (Math.min(...distances) > RADIUS + margin) background.push(index);
    }
  return { spheres, background };
}

const REGIONS = furnaceRegions();

/** Linear luminance from a tightly or row-padded rgba16float image. */
export function linearLuminance(bytes: Uint8Array, bytesPerRow = FURNACE_SIZE * 8) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(FURNACE_SIZE * FURNACE_SIZE);
  for (let y = 0; y < FURNACE_SIZE; y++)
    for (let x = 0; x < FURNACE_SIZE; x++) {
      const at = (channel: number) =>
        halfFloat.f16ToF32(view.getUint16(y * bytesPerRow + x * 8 + channel * 2, true));
      out[y * FURNACE_SIZE + x] = 0.2126 * at(0) + 0.7152 * at(1) + 0.0722 * at(2);
    }
  return out;
}

const stats = (image: Float32Array, pixels: readonly number[]) => {
  const values = pixels.map((i) => image[i] ?? Number.NaN);
  return {
    pixels: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
};

/** Per-sphere albedo relative to the environment the skybox shows. */
export function furnaceMetrics(image: Float32Array) {
  const background = stats(image, REGIONS.background);
  return {
    background,
    spheres: REGIONS.spheres.map((pixels, i) => ({
      roughness: FURNACE_ROUGHNESS[i] ?? Number.NaN,
      ...stats(image, pixels),
      albedo: stats(image, pixels).mean / background.mean,
    })),
  };
}

type Lease = import('@forgeax/engine-render').RenderFrameInput['leases'][number];

async function drawUntilIblActive(
  renderer: Renderer,
  world: World,
  lease: Lease,
  observeHdr: boolean,
) {
  for (let attempt = 0; attempt < 300; attempt++) {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const active = renderer.inspect().iblBinding?.active === 'active';
    if (active && observeHdr) unwrap(renderer.requestObservation?.(['linear-hdr']));
    const receipt = unwrap(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    unwrap(await receipt.completed);
    if (active) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('IBL publication did not become active within 300 frames');
}

/** Renders the furnace once the Skylight IBL is resident; returns linear luminance. */
export async function renderFurnace(renderer: Renderer, renderPath: RenderPath) {
  const world = new World();
  buildFurnaceScene(world);
  const lease = unwrap(renderer.attach(world));
  const original = renderer.inspect().profile;
  try {
    unwrap(renderer.setProfile({ ...original, renderPath }));
    const receipt = await drawUntilIblActive(renderer, world, lease, true);
    const observed = unwrap(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((item) => item.domain === 'linear-hdr');
    if (observed === undefined) throw new Error('missing linear HDR observation');
    return linearLuminance(observed.bytes, observed.metadata.bytesPerRow);
  } finally {
    lease.dispose();
    unwrap(renderer.setProfile(original));
  }
}

/** Reduces only the recorded shading module to single scattering. */
function withSingleScatter(tape: V7Tape, handleId: string | undefined): V7Tape {
  let patched = 0;
  const bootstrap = tape.bootstrap.map((resource) => {
    const create = resource.create;
    if (create.kind !== 'createShaderModule' || create.handleId !== handleId) return resource;
    if (typeof create.wgslCode !== 'string') throw new Error('Recorded shader source is missing');
    const wgslCode = singleScatter(create.wgslCode);
    if (wgslCode === create.wgslCode) return resource;
    patched++;
    return { ...resource, create: { ...create, wgslCode } };
  });
  if (patched !== 1) throw new Error(`expected one recorded shading module, patched ${patched}`);
  return { ...tape, bootstrap } as V7Tape;
}

/**
 * Captures one forward furnace frame and replays it on fresh Dawn devices:
 * the scene-color target after the last compensated sphere draw, then the
 * same tape with only that recorded shader reduced to single scattering.
 */
export async function replayFurnace(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: SaveEvidence,
) {
  const world = new World();
  buildFurnaceScene(world);
  const lease = unwrap(renderer.attach(world));
  const original = renderer.inspect().profile;
  try {
    unwrap(renderer.setProfile({ ...original, renderPath: 'forward' }));
    await drawUntilIblActive(renderer, world, lease, false);
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await drawUntilIblActive(renderer, world, lease, false);
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await capture).unwrap();
    save('forward.rhitape', encoded.bytes);
    const tape = decodeTape(encoded.bytes).unwrap();
    const model = buildFrameModel(tape);
    const fragment = (work: WorkEntry) =>
      work.pipeline.shaders.find((shader) => shader.stage === 'fragment');
    const shading = model.works.filter((work) =>
      new RegExp(COMPENSATED.source).test(fragment(work)?.source ?? ''),
    );
    const target = shading.at(-1);
    const color = target?.attachments?.colorViewHandleIds[0];
    if (target === undefined || color === undefined)
      throw new Error('no captured draw evaluates environmentScattering');
    const read = async (source: V7Tape) => {
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(source, adapter.features, adapter.limits))
      ).unwrap();
      const replay = (
        await openReplay(source, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const texels = (await replay.readResourceAtWork(color, target.workIndex)).unwrap();
        if (texels.format !== 'rgba16float') throw new Error(`unexpected ${texels.format}`);
        return {
          width: texels.width,
          luminance: linearLuminance(texels.bytes, (texels.width ?? FURNACE_SIZE) * 8),
        };
      } finally {
        (await replay.dispose()).unwrap();
      }
    };
    const compensated = await read(tape);
    const falsifier = withSingleScatter(tape, fragment(target)?.moduleHandleId);
    save('single-scatter.falsifier.rhitape', encodeTape(falsifier).unwrap());
    const single = await read(falsifier);
    return {
      digest: encoded.digest,
      works: model.works.length,
      shadingWorks: shading.length,
      workIndex: target.workIndex,
      width: compensated.width,
      unseededResources: model.unseededResources.map((resource) => resource.resourceId),
      compensated: compensated.luminance,
      single: single.luminance,
    };
  } finally {
    lease.dispose();
    unwrap(renderer.setProfile(original));
  }
}
