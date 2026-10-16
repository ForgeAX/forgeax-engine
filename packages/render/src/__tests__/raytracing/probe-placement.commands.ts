import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  compileShader,
} from '../../../../shader-compiler/src/index';

/** Build-only composition uses the native View, normal and signed-depth owners. */
export async function prepareProbePlacementFixture() {
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
        new URL('../../../../shader/src/ray-probe-placement.wgsl', import.meta.url),
        'utf8',
      ),
      { id: 'probe-placement', imports },
    )
  ).unwrap().wgsl;
  const raster = (
    await compileShader(
      `
#import forgeax_pbr::gbuffer::encodeStandardNormalRoughness
@group(0) @binding(0) var<uniform> fixture: vec4u;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[i],0.5,1);
}
struct Surface {
  @location(0) normal: u32,
  @location(1) identity: vec4u,
  @builtin(frag_depth) depth: f32,
}
@fragment fn fs() -> Surface {
  let mode = fixture.x;
  if (mode == 1u) { discard; }
  let shading = select(vec3f(0,0,select(1.0,-1.0,mode == 7u)),vec3f(1,0,0),mode == 8u);
  let geometric = encodeStandardNormalRoughness(vec3f(0,0,-1),0.0);
  // Camera near=0.1, far=100, plane at view distance 4: reverse-Z.
  let z = (0.1 * 100.0 / 4.0 - 0.1) / (100.0 - 0.1);
  return Surface(encodeStandardNormalRoughness(shading,0.5),
    vec4u(select(1u,2u,mode == 2u),select(0u,1u,mode == 3u),geometric,
      select(select(3u,1u,mode == 6u),0u,mode == 4u)),
    select(z,0.0,mode == 5u));
}`,
      { id: 'probe-placement-raster-fixture', imports },
    )
  ).unwrap().wgsl;
  return { kernel, raster };
}
export type ProbePlacementFixture = Awaited<ReturnType<typeof prepareProbePlacementFixture>>;
