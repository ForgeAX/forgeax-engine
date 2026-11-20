import { ShaderRegistry } from '@forgeax/engine-shader';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEngineShaderTemplateManifest } from '../index.js';

describe('Standard transmission manifest producer', () => {
  let registry: ShaderRegistry;

  beforeAll(async () => {
    const manifest = await buildEngineShaderTemplateManifest();
    registry = new ShaderRegistry({
      manifestUrl: 'memory://engine/shaders/manifest.json',
      readText: async () => JSON.stringify(manifest),
      prepareProgramCompiler: prepareShaderProgramCompiler,
    });
    (await registry.loadManifest()).unwrap();
  }, 180_000);

  it('emits one Standard row with both transmission states', async () => {
    const rows = [...registry.materialShaderManifestEntries()].filter(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(rows).toHaveLength(1);

    const standard = rows[0];
    if (standard === undefined) return;
    const states = new Set(
      standard.variants
        .filter((entry) => 'TRANSMISSION_AVAILABLE' in entry.defines)
        .map((entry) => entry.defines.TRANSMISSION_AVAILABLE),
    );
    expect(states).toEqual(new Set([false, true]));
  }, 180_000);

  it('keeps the canonical entry on the ordinary non-transmission variant', async () => {
    const standard = [...registry.materialShaderManifestEntries()].find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;

    const ordinary = standard.variants.find(
      (entry) =>
        entry.defines.COVERAGE_ONLY === false &&
        entry.defines.ALPHA_MASK === false &&
        entry.defines.DIRECTIONAL_SHADOW_SIMPLE === false &&
        entry.defines.LEAN_LIGHTING === false &&
        entry.defines.LOD_DITHER === false &&
        entry.defines.CLIPPING_PLANES === false &&
        entry.defines.VISIBLE_SURFACE_AVAILABLE === false &&
        entry.defines.CLUSTER_FORWARD_AVAILABLE === false &&
        entry.defines.EXTENDED_LIGHTING_AVAILABLE === true &&
        entry.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true &&
        entry.defines.PROBE_BLEND_AVAILABLE === false &&
        entry.defines.PROJECTOR_AVAILABLE === true &&
        entry.defines.REFLECTION_FALLBACK_AVAILABLE === true &&
        entry.defines.STANDARD_LEAN_INPUTS === false &&
        entry.defines.STORAGE_BUFFER_AVAILABLE === true &&
        entry.defines.TRANSMISSION_AVAILABLE === false &&
        entry.defines.WATER_WAVES_AVAILABLE === false &&
        entry.defines.WATER_INFO_RGBA16 === false &&
        entry.defines.VERTEX_COLOR_AVAILABLE === true,
    );
    expect(ordinary).toBeDefined();
    const direct = [...registry.entries()].find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(direct).toBeDefined();
    expect(direct?.defines).toEqual(ordinary?.defines);
    expect(direct?.sourceDigest).toBe(ordinary?.sourceDigest);
    expect(direct?.wgsl).toBe(ordinary?.composedWgsl);
  }, 180_000);
});
