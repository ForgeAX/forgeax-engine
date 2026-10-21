import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createSphereGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type RenderResult,
  Skylight,
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
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { testAssets } from './helpers/runtime-assets';

export type SaveEvidence = (name: string, bytes: Uint8Array) => void;

export function unwrap<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('required Renderer operation is unavailable');
  if (!result.ok) throw result.error;
  return result.value;
}

/** One column of spheres per roughness, from mirror-like to glossy. */
export const SPHERE_ROUGHNESS = [0.04, 0.08, 0.16] as const;
export const BACKDROP_ROUGHNESS = 0.3;
const FOV = Math.PI / 3;
const DEPTH = 6;
const RADIUS = 0.8;
const SPACING = 2;
export const LOW = 96;
export const SUPERSAMPLE = 8;
/** Eight sub-pixel camera offsets (low-resolution pixel units) on a rotated grid. */
const OFFSETS = Array.from({ length: 8 }, (_, i) => [(i + 0.5) / 8, (((i * 5) % 8) + 0.5) / 8]);

const SPHERES = [-1, 0, 1].flatMap((y) =>
  [-1, 0, 1].map((x) => ({
    center: [x * SPACING, y * SPACING, -DEPTH],
    roughness: SPHERE_ROUGHNESS[x + 1] ?? 0,
  })),
);
/** About 3 px across at LOW: the highlight and the whole curvature are sub-pixel. */
export const TINY_RADIUS = 0.1;
export const TINY_SPHERES = [-1.5, -0.5, 0.5, 1.5].flatMap((y) =>
  [-1.5, -0.5, 0.5, 1.5].map((x) => [x * SPACING, y * SPACING, -DEPTH]),
);

/**
 * Smooth mirror-like spheres under a hard sun: at LOW each spans about 20 px
 * while its GGX highlight stays sub-pixel, so the highlight aliases without
 * specular AA. A flat dielectric backdrop is the zero-curvature control.
 */
export function buildSpecularAaScene(world: World) {
  const sphere = testAssets(world)
    .create(createSphereGeometry(RADIUS, 128, 96).unwrap())
    .unwrap();
  const tiny = testAssets(world)
    .create(createSphereGeometry(TINY_RADIUS, 32, 24).unwrap())
    .unwrap();
  const tinyMetal = testAssets(world)
    .create(
      Materials.standard({
        baseColor: [0.95, 0.93, 0.88, 1],
        metallic: 1,
        roughness: SPHERE_ROUGHNESS[1],
      }),
    )
    .unwrap();
  for (const center of TINY_SPHERES)
    world
      .spawn(
        { component: Transform, data: { pos: center } },
        { component: MeshFilter, data: { assetHandle: tiny } },
        { component: MeshRenderer, data: { materials: [tinyMetal] } },
      )
      .unwrap();
  for (const { center, roughness } of SPHERES) {
    const metal = testAssets(world)
      .create(Materials.standard({ baseColor: [0.95, 0.93, 0.88, 1], metallic: 1, roughness }))
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: center } },
        { component: MeshFilter, data: { assetHandle: sphere } },
        { component: MeshRenderer, data: { materials: [metal] } },
      )
      .unwrap();
  }
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -DEPTH - 2] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world)
            .create(createBoxGeometry(14, 14, 0.1).unwrap())
            .unwrap(),
        },
      },
      {
        component: MeshRenderer,
        data: {
          materials: [
            testAssets(world)
              .create(
                Materials.standard({
                  baseColor: [0.35, 0.35, 0.35, 1],
                  metallic: 0,
                  roughness: BACKDROP_ROUGHNESS,
                }),
              )
              .unwrap(),
          ],
        },
      },
    )
    .unwrap();
  const direction = [0.3, -0.4, -1];
  const length = Math.hypot(...direction);
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: direction.map((value) => value / length) as [number, number, number],
        intensity: 3,
        castShadow: false,
      },
    })
    .unwrap();
  world.spawn({ component: Skylight, data: { intensity: 0.05, color: [0.4, 0.45, 0.5] } }).unwrap();
  return world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: { fov: FOV, aspect: 1, near: 0.1, far: 30, antialias: 0, bloom: 0, tonemap: 1 },
      },
    )
    .unwrap();
}

/** Linear luminance integrated over each LOW pixel footprint (box filter). */
function resolveLinear(bytes: Uint8Array, bytesPerRow: number, size: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const factor = size / LOW;
  const radiance = new Float64Array(LOW * LOW);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = (channel: number) =>
        halfFloat.f16ToF32(view.getUint16(y * bytesPerRow + x * 8 + channel * 2, true));
      const index = Math.floor(y / factor) * LOW + Math.floor(x / factor);
      radiance[index] = (radiance[index] ?? 0) + 0.2126 * at(0) + 0.7152 * at(1) + 0.0722 * at(2);
    }
  return Float32Array.from(radiance, (sum) => {
    const l = sum / (factor * factor);
    if (!Number.isFinite(l)) throw new Error('linear HDR overflowed; lower the light intensity');
    return l;
  });
}

/** Renders the scene once per sub-pixel offset and returns linear luminance at LOW. */
export async function renderJitteredFrames(renderer: Renderer, size: number) {
  const world = new World();
  const camera = buildSpecularAaScene(world);
  const lease = unwrap(renderer.attach(world));
  const pixelWorld = (2 * DEPTH * Math.tan(FOV / 2)) / LOW;
  const frames: Float32Array[] = [];
  try {
    if (renderer.requestObservation === undefined) throw new Error('observation unavailable');
    for (const [ox = 0, oy = 0] of OFFSETS) {
      world.set(camera, Transform, { pos: [ox * pixelWorld, oy * pixelWorld, 0] }).unwrap();
      for (let frame = 0; frame < 3; frame++) {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        const receipt = await drawReadyFrame(
          renderer,
          { leases: [lease], camera: { lease }, environment: { lease } },
          frame === 2 ? ['linear-hdr'] : undefined,
        );
        if (frame < 2) continue;
        const observed = unwrap(
          await renderer.observe(receipt, { include: ['linear-hdr'] }),
        ).observations?.find((item) => item.domain === 'linear-hdr');
        if (observed === undefined) throw new Error('missing linear HDR observation');
        frames.push(resolveLinear(observed.bytes, observed.metadata.bytesPerRow, size));
      }
    }
  } finally {
    lease.dispose();
  }
  return frames;
}

/**
 * Analytic LOW-pixel regions with a two-pixel margin that covers every camera
 * offset: `curved` lies inside a large sphere (resolved curvature, silhouettes
 * excluded), `subPixel` surrounds a tiny sphere, and `flat` sees only the
 * backdrop, where specular AA must change nothing.
 */
export function specularAaRegions() {
  const regions = {
    curved: new Uint8Array(LOW * LOW),
    subPixel: new Uint8Array(LOW * LOW),
    flat: new Uint8Array(LOW * LOW),
  };
  const tangent = Math.tan(FOV / 2);
  const margin = 2 * ((2 * DEPTH * tangent) / LOW);
  for (let y = 0; y < LOW; y++)
    for (let x = 0; x < LOW; x++) {
      const direction = [
        (((x + 0.5) / LOW) * 2 - 1) * tangent,
        (1 - ((y + 0.5) / LOW) * 2) * tangent,
        -1,
      ];
      const length = Math.hypot(...direction);
      const distance = (center: readonly number[]) => {
        const along = center.reduce(
          (sum, value, axis) => sum + (value * (direction[axis] ?? 0)) / length,
          0,
        );
        return Math.hypot(
          ...center.map((value, axis) => value - (along * (direction[axis] ?? 0)) / length),
        );
      };
      const index = y * LOW + x;
      const large = Math.min(...SPHERES.map(({ center }) => distance(center)));
      const tiny = Math.min(...TINY_SPHERES.map(distance));
      regions.curved[index] = large < RADIUS - margin ? 1 : 0;
      regions.subPixel[index] = tiny < TINY_RADIUS + margin ? 1 : 0;
      regions.flat[index] = large > RADIUS + margin && tiny > TINY_RADIUS + margin ? 1 : 0;
    }
  return regions;
}

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const displayed = (linear: number) => linear / (1 + linear);

/**
 * One LOW render set against the supersampled ground truth over a region.
 * Errors are measured on Reinhard-displayed luminance; `peakFlicker` is the
 * 99th percentile of each pixel's error deviation across sub-pixel offsets,
 * the highlight popping a moving camera sees, and `meanFlicker` its average;
 * `energy` compares linear radiance, which point sampling a sub-pixel lobe
 * loses.
 */
export function compareToReference(
  low: readonly Float32Array[],
  reference: readonly Float32Array[],
  region: Uint8Array,
) {
  const flickerMap = new Float32Array(LOW * LOW);
  const flicker: number[] = [];
  let squared = 0;
  let lowEnergy = 0;
  let referenceEnergy = 0;
  for (let i = 0; i < LOW * LOW; i++) {
    const errors = low.map(
      (frame, f) => displayed(frame[i] ?? 0) - displayed(reference[f]?.[i] ?? 0),
    );
    const m = mean(errors);
    flickerMap[i] = Math.sqrt(mean(errors.map((error) => (error - m) ** 2)));
    if (region[i] === 0) continue;
    flicker.push(flickerMap[i] ?? 0);
    squared += mean(errors.map((error) => error * error));
    lowEnergy += mean(low.map((frame) => frame[i] ?? 0));
    referenceEnergy += mean(reference.map((frame) => frame[i] ?? 0));
  }
  flicker.sort((left, right) => left - right);
  return {
    pixels: flicker.length,
    rmse: Math.sqrt(squared / flicker.length),
    peakFlicker: flicker[Math.floor(flicker.length * 0.99)] ?? 0,
    meanFlicker: mean(flicker),
    energy: lowEnergy / referenceEnergy,
    flickerMap,
  };
}

/** Largest displayed difference between two render sets inside a region. */
export function maxDifference(
  left: readonly Float32Array[],
  right: readonly Float32Array[],
  region: Uint8Array,
) {
  let max = 0;
  for (let f = 0; f < left.length; f++)
    for (let i = 0; i < LOW * LOW; i++)
      if (region[i] === 1)
        max = Math.max(max, Math.abs(displayed(left[f]?.[i] ?? 0) - displayed(right[f]?.[i] ?? 0)));
  return max;
}

export const displayedFrame = (frame: Float32Array) => Float32Array.from(frame, displayed);

const ROUGHNESS_CALL = /fn (specularAntiAliasedRoughness\w*)\(\s*(\w+)\s*:\s*f32[^{]*\{/;

/** Turns the composed specular AA definition into an identity; nothing else changes. */
const stripSpecularAa = (wgsl: string) =>
  wgsl.replace(ROUGHNESS_CALL, (head, _name, roughness) => `${head} return ${roughness};`);

/** The same engine manifest with specular AA removed from every composed program. */
export function withoutSpecularAaManifest(
  manifest: Awaited<ReturnType<typeof buildEngineShaderManifest>>,
) {
  let patched = 0;
  const sources = new Map<string, string>();
  const replace = (source: string) => {
    let stripped = sources.get(source);
    if (stripped === undefined) {
      stripped = stripSpecularAa(source);
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

/** Removes only specular AA from the recorded G-buffer shader module, leaving every other resource intact. */
function withoutSpecularAa(tape: V7Tape, geometry: WorkEntry): V7Tape {
  const handleId = geometry.pipeline.shaders.find(
    (shader) => shader.stage === 'fragment',
  )?.moduleHandleId;
  let patched = 0;
  const bootstrap = tape.bootstrap.map((resource) => {
    const create = resource.create;
    if (create.kind !== 'createShaderModule' || create.handleId !== handleId) return resource;
    if (typeof create.wgslCode !== 'string') throw new Error('recorded shader has no WGSL source');
    const wgslCode = stripSpecularAa(create.wgslCode);
    if (wgslCode === create.wgslCode) return resource;
    patched++;
    return { ...resource, create: { ...create, wgslCode } };
  });
  if (patched !== 1)
    throw new Error(`expected one recorded G-buffer module with specular AA, patched ${patched}`);
  return { ...tape, bootstrap } as V7Tape;
}

/**
 * Deferred G-buffer replay: decode the packed 8-bit roughness from the real
 * normal_roughness target on a fresh device, once from the captured tape and
 * once from a tape whose shader has specular AA removed.
 */
export async function verifySpecularAaGBuffer(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: SaveEvidence,
) {
  const world = new World();
  buildSpecularAaScene(world);
  const lease = unwrap(renderer.attach(world));
  const original = renderer.inspect().profile;
  try {
    unwrap(renderer.setProfile({ ...original, renderPath: 'deferred' }));
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      await drawReadyFrame(renderer, {
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
    };
    for (let frame = 0; frame < 4; frame++) await draw();
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await draw();
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await capture).unwrap();
    save('deferred.rhitape', encoded.bytes);
    const tape = decodeTape(encoded.bytes).unwrap();
    const model = buildFrameModel(tape);
    const geometry = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_gbuffer'),
    );
    const target = geometry.at(-1);
    if (target?.attachments === null || target === undefined)
      throw new Error('missing fs_gbuffer work');
    const normalRoughness = target.attachments.colorViewHandleIds[1];
    const reflectance = target.attachments.colorViewHandleIds[2];
    if (normalRoughness === undefined || reflectance === undefined)
      throw new Error('missing packed G-buffer');
    const sources = geometry.map(
      (work) => work.pipeline.shaders.find((shader) => shader.stage === 'fragment')?.source ?? '',
    );
    const read = async (source: V7Tape, label: string) => {
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(source, adapter.features, adapter.limits))
      ).unwrap();
      const replay = (
        await openReplay(source, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const words = async (resourceId: string, format: 'r32uint' | 'rg32uint') => {
          const texels = (await replay.readResourceAtWork(resourceId, target.workIndex)).unwrap();
          if (texels.format !== format) throw new Error(`expected ${format}, got ${texels.format}`);
          save(`${label}-${resourceId.replace(':', '-')}.${format}`, texels.bytes);
          const packed = new Uint32Array(
            texels.bytes.buffer.slice(
              texels.bytes.byteOffset,
              texels.bytes.byteOffset + texels.bytes.byteLength,
            ),
          );
          // Reflectance stores mixed and dielectric response in separate words;
          // this classifier consumes mixed F0 in the red channel.
          return format === 'rg32uint' ? packed.filter((_, index) => index % 2 === 0) : packed;
        };
        return {
          roughness: await words(normalRoughness, 'r32uint'),
          f0: await words(reflectance, 'rg32uint'),
        };
      } finally {
        (await replay.dispose()).unwrap();
      }
    };
    const live = await read(tape, 'captured');
    const falsifier = withoutSpecularAa(tape, target);
    save('without-specular-aa.falsifier.rhitape', encodeTape(falsifier).unwrap());
    const off = await read(falsifier, 'falsifier');
    // Metal writes a bright F0 byte; the dielectric backdrop keeps F0 near 0.04.
    const sphere: number[] = [];
    const backdrop: number[] = [];
    const sphereOff: number[] = [];
    const backdropOff: number[] = [];
    for (let i = 0; i < live.roughness.length; i++) {
      const covered = (live.roughness[i] ?? 0) !== 0 || (live.f0[i] ?? 0) !== 0;
      if (!covered) continue;
      const metal = ((live.f0[i] ?? 0) & 255) > 128;
      (metal ? sphere : backdrop).push((live.roughness[i] ?? 0) >>> 24);
      (metal ? sphereOff : backdropOff).push((off.roughness[i] ?? 0) >>> 24);
    }
    return {
      digest: encoded.digest,
      geometryWorks: geometry.length,
      sourcesContainSpecularAa: sources.map((source) => ROUGHNESS_CALL.test(source)),
      sphere,
      backdrop,
      sphereOff,
      backdropOff,
      unseededResources: model.unseededResources.length,
    };
  } finally {
    lease.dispose();
    unwrap(renderer.setProfile(original));
  }
}
