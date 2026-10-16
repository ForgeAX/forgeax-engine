import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  compileShader,
} from '../../../../shader-compiler/src/index';

export async function prepareDiffuseReconstructionFixture() {
  const directory = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const sources = buildMaterialSourceCatalog(
    await collectMaterialSources([directory], [directory]),
  ).unwrap();
  const imports = Object.fromEntries(
    ['forgeax_view::common', 'forgeax_pbr::gbuffer', 'forgeax_scene_temporal'].map((id) => [
      id,
      sources.get(id).unwrap().source,
    ]),
  );
  const kernel = (
    await compileShader(
      await readFile(
        new URL('../../../../shader/src/ray-diffuse-reconstruct.wgsl', import.meta.url),
        'utf8',
      ),
      { id: 'diffuse-reconstruction', imports },
    )
  ).unwrap().wgsl;
  const raster = (
    await compileShader(
      `
#import forgeax_pbr::gbuffer::{encodeStandardNormalRoughness}
struct Fixture { motion: vec4f, modes: vec4u }
@group(0) @binding(0) var<uniform> fixture: Fixture;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[i],0.5,1);
}
struct Surface {
  @location(0) normal: u32,
  @location(1) identity: vec4u,
  @location(2) motion: vec4f,
  @builtin(frag_depth) depth: f32,
}
@fragment fn fs(@builtin(position) p: vec4f) -> Surface {
  let right = p.x >= 8.0;
  let n = encodeStandardNormalRoughness(vec3f(0,0,select(1.0,-1.0,right && fixture.modes.y==1u)),0.5);
  return Surface(n,vec4u(select(1u,2u,right && fixture.modes.z==0u),0u,n,3u),
    fixture.motion,select(0.5,0.52,right && fixture.modes.x==1u));
}`,
      { id: 'diffuse-reconstruction-raster', imports },
    )
  ).unwrap().wgsl;
  return { kernel, raster };
}
export type DiffuseReconstructionFixture = Awaited<
  ReturnType<typeof prepareDiffuseReconstructionFixture>
>;
