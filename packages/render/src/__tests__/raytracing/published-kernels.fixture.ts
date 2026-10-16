import { ShaderRegistry } from '@forgeax/engine-shader';
import { assert, expect } from 'vitest';

/** Exercise the production manifest transport and runtime registry, not test-side composition. */
export async function loadPublishedRayKernels(manifestUrl: string) {
  const registry = new ShaderRegistry({ manifestUrl });
  (await registry.loadManifest()).unwrap();
  const entries = [...registry.entries()];
  const select = (entryPoint: string) => {
    const matches = entries.filter((entry) => entry.wgsl.includes(`fn ${entryPoint}(`));
    expect(matches, `one published ${entryPoint} program`).toHaveLength(1);
    const entry = matches[0];
    assert(entry);
    return entry.wgsl;
  };
  return {
    query: select('queryTriangles'),
    transport: select('accumulate'),
    raster: select('generateRasterRays'),
    placement: select('placeRasterProbes'),
    composite: select('fs_ray_diffuse'),
    reconstruction: select('reconstructDiffuse'),
  };
}
