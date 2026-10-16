import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {} from 'vitest/browser';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  compileShader,
  cookRayMaterial,
  createMaterialPackCooker,
} from '../../../../shader-compiler/src/index';
import { Materials } from '../../materials';
import { prepareDiffuseReconstructionFixture } from './diffuse-reconstruction.commands';
import { prepareProbePlacementFixture } from './probe-placement.commands';
import { prepareRasterRayFixture } from './raster-source.commands';
import {
  emissionRayMaterial,
  prepareRayMaterialPublication,
} from './ray-material-publication.commands';

let preparedFixture: ReturnType<typeof buildRayPathFixture> | undefined;

/** Reuse immutable cooked inputs, never mutable World/device/test state. */
async function readPreparedRayPathFixture() {
  preparedFixture ??= buildRayPathFixture();
  const pending = preparedFixture;
  try {
    return await pending;
  } catch (error) {
    if (preparedFixture === pending) preparedFixture = undefined;
    throw error;
  }
}

/** Ordinary GPU probes receive selected ray programs, not unused publication artifacts. */
export async function prepareRayPathFixture() {
  const { materials, ...programs } = await readPreparedRayPathFixture();
  return structuredClone({
    ...programs,
    materials: materials.map(({ cookedPublication: _publication, ...material }) => material),
  });
}

export type RayPublicationMaterialName = keyof ReturnType<typeof rayMaterialAssets>;

/** Renderer publication fixtures request the complete records they actually load. */
export async function prepareRayPublicationSet(names: RayPublicationMaterialName[]) {
  const materials: RayPublicationFixture['material'][] = [];
  for (const name of names) materials.push((await prepareRayPublicationFixture(name)).material);
  return { materials };
}

const preparedPublications = new Map<
  RayPublicationMaterialName,
  ReturnType<typeof buildRayPublicationFixture>
>();

/** Publication probes cook and transport only their complete loader input. */
export async function prepareRayPublicationFixture(name: RayPublicationMaterialName) {
  let pending = preparedPublications.get(name);
  if (pending === undefined) {
    pending = buildRayPublicationFixture(name);
    preparedPublications.set(name, pending);
  }
  try {
    return structuredClone(await pending);
  } catch (error) {
    if (preparedPublications.get(name) === pending) preparedPublications.delete(name);
    throw error;
  }
}

async function buildRayPublicationFixture(name: RayPublicationMaterialName) {
  const { directory, kernel } = await buildRayKernelFixture();
  const asset = rayMaterialAssets()[name];
  const material = await prepareRayMaterialPublication(
    name,
    asset,
    createMaterialPackCooker([directory]),
  );
  return { kernel, material };
}

function cutoutRayMaterial() {
  return Materials.standard({
    renderState: { cullMode: 'none' },
    baseColor: [1, 1, 1, 1],
    roughness: 0.65,
    specular: 0,
    alphaCutoff: 0.5,
    baseColorTexture: { texture: 'coverage', sampler: 'nearest' },
  });
}

/** Node-only fixture producer; browser and runtime receive cooked WGSL. */
async function buildRayKernelFixture() {
  const directory = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const sources = buildMaterialSourceCatalog(
    await collectMaterialSources([directory], [directory]),
  ).unwrap();
  const imports = Object.fromEntries(
    [
      'forgeax_material::ray_abi',
      'forgeax_ray::traversal',
      'forgeax_pbr::ray_bsdf',
      'forgeax_pbr::brdf',
      'forgeax_pbr::ibl_shared',
      'forgeax_pbr::lighting_attenuation',
    ].map((id) => [id, sources.get(id).unwrap().source]),
  );
  const kernel = (
    await compileShader(sources.get('forgeax_ray::path_tracer').unwrap().source, {
      id: 'reference-path-tracer',
      imports,
    })
  ).unwrap().wgsl;
  return { directory, sources, imports, kernel };
}

function rayMaterialAssets() {
  return {
    cutout: cutoutRayMaterial(),
    matte: Materials.standard({ baseColor: [0.8, 0.4, 0.2, 1], roughness: 0.65, specular: 0 }),
    white: Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.65, specular: 0 }),
    emission: emissionRayMaterial(),
    textured: Materials.standard({
      baseColor: [0.8, 0.4, 0.2, 1],
      roughness: 0.65,
      specular: 0,
      baseColorTexture: { texture: 'checker', sampler: 'linear', coordinates: { set: 1 } },
    }),
    normalMapped: Materials.standard({
      baseColor: [0.8, 0.4, 0.2, 1],
      roughness: 0.65,
      specular: 0,
      normalScale: [1.2, 0.5],
      normalTexture: { texture: 'normal', sampler: 'linear', coordinates: { set: 1 } },
    }),
    metal: Materials.standard({ baseColor: [0.8, 0.7, 0.5, 1], metallic: 1, roughness: 0.5 }),
    // Lite reflections: near-mirror (raw dedicated lobe) and glossy (denoised GGX lobe).
    mirror: Materials.standard({ baseColor: [0.9, 0.9, 0.9, 1], metallic: 1, roughness: 0.05 }),
    glossy: Materials.standard({ baseColor: [0.9, 0.9, 0.9, 1], metallic: 1, roughness: 0.3 }),
  };
}

/** Shader-only preparation for structural recording; real GPU tests keep the complete publication route. */
export async function prepareRayRecordingFixture(directMultiscattering: 'fit' | 'lut' = 'fit') {
  const { sources, imports, kernel } = await buildRayKernelFixture();
  const table = rayMaterialAssets();
  if (directMultiscattering === 'lut')
    table.cutout = Materials.standard({
      baseColor: [1, 1, 1, 1],
      roughness: 0.65,
      directMultiscattering: 'lut',
    });
  const material = (await cookRayMaterial({ material: 'cutout', table, sources })).unwrap();
  const kernelLut =
    directMultiscattering === 'lut'
      ? (
          await compileShader(sources.get('forgeax_ray::path_tracer').unwrap().source, {
            id: 'reference-path-tracer-lut',
            imports,
            defines: { DIRECT_DFG_LUT_AVAILABLE: true },
          })
        ).unwrap().wgsl
      : undefined;
  return { kernel, material, ...(kernelLut === undefined ? {} : { kernelLut }) };
}

async function buildRayPathFixture() {
  const { directory, sources, imports, kernel } = await buildRayKernelFixture();
  const assets = rayMaterialAssets();
  const cooker = createMaterialPackCooker([directory]);
  const materials = await Promise.all(
    Object.entries(assets).map(([id, asset]) => prepareRayMaterialPublication(id, asset, cooker)),
  );
  const raster = (
    await cookRayMaterial({ material: 'textured', table: assets, sources, context: 'raster-probe' })
  ).unwrap();
  const bsdf = (
    await compileShader(await readFile(new URL('./bsdf-probe.wgsl', import.meta.url), 'utf8'), {
      id: 'bsdf-probe',
      imports,
    })
  ).unwrap().wgsl;
  const normalRaster = (
    await cookRayMaterial({
      material: 'normalMapped',
      table: assets,
      sources,
      context: 'raster-probe',
    })
  ).unwrap();
  return { kernel, materials, raster, normalRaster, bsdf };
}
export type RayPathFixture = Awaited<ReturnType<typeof prepareRayPathFixture>>;
export type RayPublicationFixture = Awaited<ReturnType<typeof prepareRayPublicationFixture>>;
export type RayPublicationSet = Awaited<ReturnType<typeof prepareRayPublicationSet>>;
declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareRayPathFixture(): Promise<RayPathFixture>;
    prepareRayPublicationSet(names: RayPublicationMaterialName[]): Promise<RayPublicationSet>;
    prepareRayPublicationFixture(name: RayPublicationMaterialName): Promise<RayPublicationFixture>;
  }
}
export const rayPathCommands = {
  prepareRayPathFixture,
  prepareRayPublicationSet: (_context: unknown, names: RayPublicationMaterialName[]) =>
    prepareRayPublicationSet(names),
  prepareRayPublicationFixture: (_context: unknown, name: RayPublicationMaterialName) =>
    prepareRayPublicationFixture(name),
  prepareRasterRayFixture,
  prepareProbePlacementFixture,
  prepareDiffuseReconstructionFixture,
};
