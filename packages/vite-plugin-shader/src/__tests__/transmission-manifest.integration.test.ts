import { beforeAll, describe, expect, it } from 'vitest';

type EngineShaderManifest = Awaited<
  ReturnType<typeof import('../index.js').buildEngineShaderManifest>
>;

async function engineManifest(): Promise<EngineShaderManifest> {
  const { buildEngineShaderManifest } = await import('../index.js');
  return buildEngineShaderManifest();
}

let engineManifestPromise: Promise<EngineShaderManifest> | undefined;

function sharedEngineManifest(): Promise<EngineShaderManifest> {
  engineManifestPromise ??= engineManifest();
  return engineManifestPromise;
}

describe('Standard transmission manifest producer', () => {
  let manifest: EngineShaderManifest;

  beforeAll(async () => {
    manifest = await sharedEngineManifest();
  }, 180_000);

  it('emits one Standard row with both transmission states', async () => {
    const rows = manifest.materialShaders.filter(
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
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;

    const ordinary = standard.variants.find(
      (entry) =>
        entry.defines.COVERAGE_ONLY === false &&
        entry.defines.VISIBLE_SURFACE_AVAILABLE === false &&
        entry.defines.CLUSTER_FORWARD_AVAILABLE === false &&
        entry.defines.DIRECTIONAL_PCSS_AVAILABLE === true &&
        entry.defines.EXTENDED_LIGHTING_AVAILABLE === true &&
        entry.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true &&
        entry.defines.PROBE_BLEND_AVAILABLE === false &&
        entry.defines.PROJECTOR_AVAILABLE === true &&
        entry.defines.REFLECTION_FALLBACK_AVAILABLE === true &&
        entry.defines.STORAGE_BUFFER_AVAILABLE === true &&
        entry.defines.TRANSMISSION_AVAILABLE === false &&
        entry.defines.VERTEX_COLOR_AVAILABLE === true,
    );
    expect(ordinary).toBeDefined();
    expect(standard.composedWgsl).toBe(ordinary?.composedWgsl);
  }, 180_000);
});
