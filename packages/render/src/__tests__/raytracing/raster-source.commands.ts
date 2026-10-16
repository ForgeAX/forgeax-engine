import { fileURLToPath } from 'node:url';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  compileShader,
  createMaterialPackCooker,
} from '../../../../shader-compiler/src/index';

import {
  emissionRayMaterial,
  prepareRayMaterialPublication,
} from './ray-material-publication.commands';

/** Build-only composition; the GPU fixture receives the same shared decode and View ABI. */
export async function prepareRasterRayFixture() {
  const directory = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const sources = buildMaterialSourceCatalog(
    await collectMaterialSources([directory], [directory]),
  ).unwrap();
  const imports = Object.fromEntries(
    [
      'forgeax_view::common',
      'forgeax_pbr::gbuffer',
      'forgeax_pbr::ray_bsdf',
      'forgeax_material::ray_abi',
      'forgeax_pbr::brdf',
    ].map((id) => [id, sources.get(id).unwrap().source]),
  );
  const raster = (
    await compileShader(
      `
#import forgeax_pbr::gbuffer::{encodeStandardNormalRoughness, encodeStandardReflectance}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4<f32>(p[i],0.5,1);
}
struct Surface {
  @location(0) normal: u32,
  @location(1) albedo: u32,
  @location(2) identity: vec4u,
  @location(3) response: u32,
  @builtin(frag_depth) depth: f32,
}
@fragment fn fs(@builtin(position) p: vec4f) -> Surface {
  let x = u32(p.x);
  if (x == 1u) { discard; }
  let n = vec3f(0,0,select(1.0,-1.0,x==5u));
  let ng = encodeStandardNormalRoughness(vec3f(0,0,1),0.0);
  return Surface(encodeStandardNormalRoughness(n,0.5),
    encodeStandardReflectance(vec3f(1,0.25,0.0625),select(0.0,1.0,x==6u)),
    vec4u(select(1u,2u,x==2u),select(0u,99u,x==3u),ng,select(3u,0u,x==4u)),
    encodeStandardReflectance(vec3f(0.04),1.0),
    select(0.5,0.0,x==7u));
}`,
      { id: 'raster-ray-fixture', imports },
    )
  ).unwrap().wgsl;
  const { name, asset, program } = await prepareRayMaterialPublication(
    'emission',
    emissionRayMaterial(),
    createMaterialPackCooker([directory]),
  );
  return { raster, material: { name, asset, program } };
}
export type RasterRayFixture = Awaited<ReturnType<typeof prepareRasterRayFixture>>;
