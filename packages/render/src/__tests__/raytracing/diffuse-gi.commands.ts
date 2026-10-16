import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildMeshDistanceField } from '../../../../geometry/src/distance-field';
import { buildMeshCardLayout } from '../../../../geometry/src/mesh-card-layout';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  cookRayMaterial,
  createShaderProgramCompiler,
} from '../../../../shader-compiler/src/index';
import { Materials } from '../../materials';
import { CARD_LOOKUP_WGSL } from '../../raytracing/card-lookup';
import { SDF_TRACE_WGSL } from '../../raytracing/sdf-query';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';
export async function prepareDiffuseGiFixture() {
  const compile = createShaderProgramCompiler();
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
  const source = (
    await readFile(new URL('../../raytracing/diffuse-gi.wgsl', import.meta.url), 'utf8')
  )
    .replace('#pragma sdf_traversal', SDF_TRACE_WGSL)
    .replace('#pragma card_lookup', CARD_LOOKUP_WGSL);
  const kernel = (await compile(source, { id: 'diffuse-gi', imports })).unwrap().wgsl;
  const assets = {
    white: Materials.standard({ baseColor: [0.8, 0.8, 0.8, 1], specular: 0, roughness: 0.65 }),
    red: Materials.standard({ baseColor: [0.8, 0.03, 0.02, 1], specular: 0, roughness: 0.65 }),
    black: Materials.standard({ baseColor: [0, 0, 0, 1], specular: 0, roughness: 0.65 }),
    emission: Materials.standard({
      baseColor: [0, 0, 0, 1],
      specular: 0,
      emissive: [3, 1, 0.2],
      emissiveIntensity: 1,
    }),
    metal: Materials.standard({ baseColor: [0.8, 0.7, 0.5, 1], metallic: 1, roughness: 0.5 }),
  };
  const materials = [];
  const rayMaterials = [];
  for (const [name, asset] of Object.entries(assets)) {
    const request = { material: name, table: { [name]: asset }, sources };
    materials.push({
      name,
      ...(await cookRayMaterial({ ...request, context: 'card-capture' }, compile)).unwrap(),
    });
    rayMaterials.push({ name, ...(await cookRayMaterial(request, compile)).unwrap() });
  }
  const pathKernel = (
    await compile(sources.get('forgeax_ray::path_tracer').unwrap().source, {
      id: 'gi-path-reference',
      imports,
    })
  ).unwrap().wgsl;
  const layout = (await buildMeshCardLayout(sdfCubePositions, sdfCubeIndices)).unwrap();
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 48 })
  ).unwrap();
  return {
    kernel,
    materials,
    rayMaterials,
    pathKernel,
    layout,
    field: { ...field, bricks: Array.from(field.bricks), values: Array.from(field.values) },
  };
}
export type DiffuseGiFixture = Awaited<ReturnType<typeof prepareDiffuseGiFixture>>;
export const diffuseGiCommands = { prepareDiffuseGiFixture };
