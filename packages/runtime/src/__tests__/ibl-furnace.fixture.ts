import { World } from '@forgeax/engine-ecs';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  LightProbe,
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
import type { ShaderTemplateManifest } from '@forgeax/engine-shader';
import { compactTape } from './compact-tape.fixture';
import { testAssets } from './helpers/runtime-assets';
import { rewriteShaderTemplateSources } from './shader-manifest-url.fixture';
import { type SaveEvidence, unwrap } from './specular-aa.fixture';

export type RenderPath = 'forward' | 'deferred';
type FurnaceLayout = 'metal' | 'dielectric' | 'sweep';
type FurnaceSurface = FurnaceLayout | 'dielectric-gray' | 'sweep-gray';

interface FurnaceSphere {
  readonly center: readonly [number, number, number];
  readonly roughness: number;
  readonly metallic: 0 | 1;
}

const FURNACE_ROUGHNESS = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;
export const FURNACE_SIZE = 192;
export const SWEEP_WIDTH = 768;
const FOV = Math.PI / 3;
const DEPTH = 6;
const SWEEP_DEPTH = 32;
const RADIUS = 0.9;
const SPACING = 2.2;
const LAYOUTS: Record<
  FurnaceLayout,
  {
    readonly width: number;
    readonly depth: number;
    readonly interior: number;
    readonly spheres: readonly FurnaceSphere[];
  }
> = {
  metal: {
    width: FURNACE_SIZE,
    depth: DEPTH,
    interior: 0.8,
    spheres: FURNACE_ROUGHNESS.map((roughness, i) => ({
      center: [((i % 3) - 1) * SPACING, (i < 3 ? 1 : -1) * (SPACING / 2), -DEPTH],
      roughness,
      metallic: 1,
    })),
  },
  dielectric: {
    width: FURNACE_SIZE,
    depth: DEPTH,
    interior: 0.98,
    spheres: [{ center: [0, 0, -DEPTH], roughness: 1, metallic: 0 }],
  },
  sweep: {
    width: SWEEP_WIDTH,
    depth: SWEEP_DEPTH,
    interior: 0.98,
    spheres: ([1, 0] as const).flatMap((metallic) =>
      Array.from({ length: 11 }, (_, i) => ({
        center: [(i - 5) * SPACING, (metallic === 1 ? 1 : -1) * (SPACING / 2), -SWEEP_DEPTH],
        roughness: i / 10,
        metallic,
      })),
    ),
  },
};

/** Both authored and Naga-emitted shaders call the same multiple-scattering helper. */
const COMPENSATED =
  /(\bfn environmentMultiScattering\w*\([^{}]*\)\s*->\s*vec3<f32>\s*\{)(?!\s*return vec3<f32>\(0\.0\);)[^{}]*(\})/g;
/** Keep the directional term and remove only the multiple-scattering contribution. */
const singleScatter = (wgsl: string) =>
  wgsl.replace(COMPENSATED, '$1\n  return vec3<f32>(0.0);\n$2');

/** Publish the same programs with only their shared IBL source changed. */
export function singleScatterPublication(manifest: ShaderTemplateManifest) {
  const { manifest: publication, patched } = rewriteShaderTemplateSources(manifest, (source) => {
    const stripped = singleScatter(source);
    if (stripped.search(COMPENSATED) >= 0)
      throw new Error('Furnace control retains irradiance compensation');
    return stripped;
  });
  return { publication, patched };
}

/** A panorama of constant linear radiance one: the white furnace. */
function uniformEquirect(world: World) {
  const data = new Uint8Array(16 * 8 * 8);
  const view = new DataView(data.buffer);
  for (let i = 0; i < 16 * 8 * 4; i++) view.setUint16(i * 2, 0x3c00, true);
  return testAssets(world)
    .create({
      kind: 'equirect',
      width: 16,
      height: 8,
      format: 'rgba16float',
      colorSpace: 'linear',
      data,
    })
    .unwrap();
}

function buildFurnaceScene(world: World, layout: FurnaceLayout = 'metal', base = 1) {
  const geometry = testAssets(world)
    .create(createSphereGeometry(RADIUS, 96, 64).unwrap())
    .unwrap();
  const { spheres, width, depth } = LAYOUTS[layout];
  for (const { center, roughness, metallic } of spheres) {
    const material = testAssets(world)
      .create(Materials.standard({ baseColor: [base, base, base, 1], metallic, roughness }))
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [...center] } },
        { component: MeshFilter, data: { assetHandle: geometry } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
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
          fov: 2 * Math.atan((Math.tan(FOV / 2) * DEPTH) / depth),
          aspect: width / FURNACE_SIZE,
          near: 0.1,
          far: depth + 24,
          antialias: 0,
          bloom: 0,
          tonemap: TONEMAP_LINEAR,
        },
      },
    )
    .unwrap();
}

/**
 * Analytic pixel classes: retain the requested interior fraction of each
 * projected sphere and sample the skybox outside a two-pixel margin.
 */
function furnaceRegions({
  width,
  depth,
  interior,
  spheres: subjects,
}: (typeof LAYOUTS)[FurnaceLayout]) {
  const tangent = (Math.tan(FOV / 2) * DEPTH) / depth;
  const margin = 2 * ((2 * depth * tangent) / FURNACE_SIZE);
  const spheres = subjects.map(() => [] as number[]);
  const background: number[] = [];
  for (let y = 0; y < FURNACE_SIZE; y++)
    for (let x = 0; x < width; x++) {
      const direction = [
        (((x + 0.5) / width) * 2 - 1) * tangent * (width / FURNACE_SIZE),
        (1 - ((y + 0.5) / FURNACE_SIZE) * 2) * tangent,
        -1,
      ];
      const length = Math.hypot(...direction);
      const distances = subjects.map(({ center }) => {
        const along = center.reduce(
          (sum, value, axis) => sum + (value * (direction[axis] ?? 0)) / length,
          0,
        );
        return Math.hypot(
          ...center.map((value, axis) => value - (along * (direction[axis] ?? 0)) / length),
        );
      });
      const index = y * width + x;
      distances.forEach((distance, i) => {
        if (distance < RADIUS * interior) spheres[i]?.push(index);
      });
      if (Math.min(...distances) > RADIUS + margin) background.push(index);
    }
  return { spheres, background };
}

const REGIONS = {
  metal: furnaceRegions(LAYOUTS.metal),
  dielectric: furnaceRegions(LAYOUTS.dielectric),
  sweep: furnaceRegions(LAYOUTS.sweep),
};

/** Linear luminance from a tightly or row-padded rgba16float image. */
function linearLuminance(bytes: Uint8Array, bytesPerRow = FURNACE_SIZE * 8, width = FURNACE_SIZE) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(width * FURNACE_SIZE);
  for (let y = 0; y < FURNACE_SIZE; y++)
    for (let x = 0; x < width; x++) {
      const at = (channel: number) =>
        halfFloat.f16ToF32(view.getUint16(y * bytesPerRow + x * 8 + channel * 2, true));
      out[y * width + x] = 0.2126 * at(0) + 0.7152 * at(1) + 0.0722 * at(2);
    }
  return out;
}

function stats(image: Float32Array, pixels: readonly number[]) {
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const i of pixels) {
    const value = image[i] ?? Number.NaN;
    sum += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { pixels: pixels.length, mean: sum / pixels.length, min, max };
}

/** Per-sphere response relative to the environment the skybox shows. */
export function furnaceMetrics(image: Float32Array, layout: FurnaceLayout = 'metal') {
  const regions = REGIONS[layout];
  const background = stats(image, regions.background);
  return {
    background,
    spheres: LAYOUTS[layout].spheres.map(({ roughness, metallic }, i) => {
      const sample = stats(image, regions.spheres[i] ?? []);
      return { roughness, metallic, ...sample, albedo: sample.mean / background.mean };
    }),
  };
}

type Lease = import('@forgeax/engine-render').RenderReadLease;

async function drawUntilIblActive(
  renderer: Renderer,
  world: World,
  lease: Lease,
  observeHdr: boolean,
) {
  for (let attempt = 0; attempt < 300; attempt++) {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    if (observeHdr) unwrap(renderer.requestObservation?.(['linear-hdr']));
    const receipt = unwrap(renderer.draw({ source: lease }));
    unwrap(await receipt.completed);
    const binding = renderer.inspect().iblBinding;
    const active =
      binding?.active === 'active' && binding.deviceGeneration === receipt.deviceGeneration;
    const domains = receipt.observationDomains;
    if (
      active &&
      receipt.presentation === 'ready' &&
      (!observeHdr || domains?.includes('linear-hdr') === true)
    )
      return receipt;
    if (observeHdr && domains !== undefined && domains.length > 0)
      unwrap(await renderer.observe(receipt, { include: domains }));
    if (receipt.preparationCompleted !== undefined) unwrap(await receipt.preparationCompleted);
  }
  throw new Error('IBL publication did not become active within 300 frames');
}

/** Renders the furnace once the Skylight IBL is resident; returns linear luminance. */
export async function renderFurnace(
  renderer: Renderer,
  renderPath: RenderPath,
  surface: FurnaceSurface = 'metal',
  options: { readonly blackProbe?: true; readonly gbufferFormat?: 'default' } = {},
) {
  const world = new World();
  const layout =
    surface === 'sweep-gray' ? 'sweep' : surface === 'dielectric-gray' ? 'dielectric' : surface;
  const width = LAYOUTS[layout].width;
  const base = surface === 'sweep-gray' || surface === 'dielectric-gray' ? 0.5 : 1;
  buildFurnaceScene(world, layout, base);
  if (options.blackProbe === true)
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -DEPTH] } },
        { component: LightProbe, data: { irradiance: new Float32Array(27), radius: 20 } },
      )
      .unwrap();
  const lease = unwrap(renderer.attach(world));
  const original = renderer.inspect().profile;
  try {
    unwrap(
      renderer.setProfile({
        ...original,
        renderPath,
        ...(options.gbufferFormat === undefined ? {} : { gbufferFormat: options.gbufferFormat }),
        ibl: true,
        ambientOcclusion: { enabled: false },
      }),
    );
    const receipt = await drawUntilIblActive(renderer, world, lease, true);
    const observed = unwrap(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((item) => item.domain === 'linear-hdr');
    if (observed === undefined) throw new Error('missing linear HDR observation');
    if (observed.metadata.width !== width || observed.metadata.height !== FURNACE_SIZE)
      throw new Error(
        `Unexpected furnace HDR dimensions: ${observed.metadata.width} × ${observed.metadata.height}`,
      );
    return linearLuminance(observed.bytes, observed.metadata.bytesPerRow, width);
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
    unwrap(
      renderer.setProfile({
        ...original,
        renderPath: 'forward',
        ambientOcclusion: { enabled: false },
      }),
    );
    await drawUntilIblActive(renderer, world, lease, false);
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await drawUntilIblActive(renderer, world, lease, false);
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await capture).unwrap();
    save('forward.rhitape', compactTape(encoded).bytes);
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
      throw new Error('no captured draw evaluates environmentMultiScattering');
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
    save(
      'single-scatter.falsifier.rhitape',
      encodeTape(falsifier, { compression: 'gzip' }).unwrap(),
    );
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
