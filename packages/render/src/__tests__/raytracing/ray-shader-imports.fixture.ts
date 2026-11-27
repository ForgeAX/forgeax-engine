import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngineShaderEntries } from '../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';

/** Use the production composition closure with source from the tested checkout. */
export async function rayShaderTestImports() {
  const require = createRequire(import.meta.url);
  const packaged = resolve(dirname(require.resolve('@forgeax/engine-shader/package.json')), 'src');
  const local = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const built = await loadEngineShaderEntries((file) => {
    const shader = relative(packaged, file);
    return readFile(
      shader.startsWith('..') || isAbsolute(shader) ? file : resolve(local, shader),
      'utf8',
    );
  });
  return built.imports;
}

export const FIELD_SEGMENT_TEST_WGSL = `
#import forgeax_ray::irradiance_field_sample::{sampleIrradianceField, sampleRadianceCacheAt}
@group(0) @binding(0) var<storage,read_write> results: array<vec4f>;
@compute @workgroup_size(1) fn verifySegment() {
 let p=vec3f(0,0,-3.3);let n=vec3f(0,0,1);
 results[0]=sampleIrradianceField(p,n,vec3f(0));
 results[1]=sampleRadianceCacheAt(p,n,vec3f(0),n,0.25);
}`;
