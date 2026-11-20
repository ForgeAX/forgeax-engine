import { ShaderRegistry } from '@forgeax/engine-shader';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';
import { assert, expect } from 'vitest';

/** Exercise the production manifest transport and runtime registry, not test-side composition. */
export async function loadPublishedRayKernels(manifestUrl: string) {
  const registry = new ShaderRegistry({
    manifestUrl,
    prepareProgramCompiler: prepareShaderProgramCompiler,
  });
  (await registry.loadManifest()).unwrap();
  const entries = [...registry.entries()];
  const select = (identifier: string, entryPoint: string) => {
    const matches = entries.filter((entry) => entry.identifier === identifier);
    expect(matches, `one published ${entryPoint} program`).toHaveLength(1);
    const entry = matches[0];
    assert(entry);
    expect(entry.wgsl, identifier).toContain(`fn ${entryPoint}(`);
    return entry.wgsl;
  };
  return {
    query: select('forgeax_ray::query', 'queryTriangles'),
    transport: select('forgeax::engine-ray-path-tracer', 'accumulate'),
    raster: select('forgeax_ray::raster_source', 'generateRasterRays'),
    placement: select('forgeax_ray::probe_placement', 'placeRasterProbes'),
    composite: select('forgeax_ray::diffuse_composite', 'fs_ray_diffuse'),
    reconstruction: select('forgeax_ray::diffuse_reconstruct', 'reconstructDiffuse'),
  };
}
