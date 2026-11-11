import { beforeAll, describe, expect, it } from 'vitest';

type EngineShaderManifest = Awaited<
  ReturnType<typeof import('@forgeax/engine-vite-plugin-shader').buildEngineShaderManifest>
>;

let engineManifestPromise: Promise<EngineShaderManifest> | undefined;
function engineManifest(): Promise<EngineShaderManifest> {
  engineManifestPromise ??= import('@forgeax/engine-vite-plugin-shader').then(
    ({ buildEngineShaderManifest }) => buildEngineShaderManifest(),
  );
  return engineManifestPromise;
}

// The forward Standard row a WebGPU storage backend resolves for an opaque,
// clustered, atmosphere-lit scene with one shadowed sun (r2-searchlight). The
// PCSS receiver is compiled into every row on every backend, so this row is
// the one the main pass actually draws with (no LOD cross-fade, no view
// clipping); the manifest build composes it
// through naga_oil and validates it before publishing.
const FORWARD_STORAGE_ROW = {
  ALPHA_MASK: false,
  ATMOSPHERE_AVAILABLE: true,
  CLIPPING_PLANES: false,
  CLUSTER_FORWARD_AVAILABLE: true,
  COVERAGE_ONLY: false,
  EXTENDED_LIGHTING_AVAILABLE: true,
  GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
  LOD_DITHER: false,
  PROBE_BLEND_AVAILABLE: false,
  PROJECTOR_AVAILABLE: true,
  REFLECTION_FALLBACK_AVAILABLE: false,
  STORAGE_BUFFER_AVAILABLE: true,
  TRANSMISSION_AVAILABLE: false,
  VERTEX_COLOR_AVAILABLE: false,
  VISIBLE_SURFACE_AVAILABLE: false,
} as const;

function rowKey(defines: Record<string, boolean>): string {
  return Object.entries(defines)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([axis, value]) => `${axis}=${value}`)
    .join('+');
}

describe('directional PCSS receiver variant', () => {
  beforeAll(async () => {
    await engineManifest();
  }, 120_000);

  it.each([
    { simple: false, lean: false, probe: false },
    { simple: true, lean: true, probe: false },
    { simple: true, lean: false, probe: false },
    { simple: true, lean: false, probe: true },
  ])('publishes receiver $simple with lean $lean and ProbeBlend $probe', {
    timeout: 60_000,
  }, async ({ simple, lean, probe }) => {
    const manifest = await engineManifest();
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    const key = rowKey({
      ...FORWARD_STORAGE_ROW,
      DIRECTIONAL_SHADOW_SIMPLE: simple,
      LEAN_LIGHTING: lean,
      PROBE_BLEND_AVAILABLE: probe,
    });
    const row = standard?.variants.find((variant) => variant.definesKey === key);
    expect(row, key).toBeDefined();
    const code = row?.composedWgsl ?? '';
    expect(code).toMatch(/@fragment\s+fn fs_main\(/);
    // The general receiver keeps the PCSS body and cascade pick; the simple
    // receiver removes both before codegen.
    expect(/fn _samplePcssForCascade\w*\(/.test(code)).toBe(!simple);
    expect(/fn _pickCascadeLayer\w*\(/.test(code)).toBe(!simple);
    // Full lighting keeps the actual RectArea, IES and Cookie sample paths.
    for (const resource of ['cookieTexture', 'ltcGgxTexture']) {
      expect(new RegExp(`textureSampleLevel\\(${resource}\\w*,`).test(code)).toBe(!lean);
    }
    expect(/textureSampleLevel\(iesProfileTexture\w*,/.test(code)).toBe(true);
    expect(code.includes('probeBlendRecords')).toBe(probe);
  });

  // wgpu-webgl2 resolves PCSS on (`directionalPcssCapable`), so the storage-free
  // rows must keep the PCSS receiver; dropping it silently degrades WebGL2 to
  // the comparison-only PCF receiver.
  it('compiles the PCSS receiver into storage-free (WebGL2) rows', {
    timeout: 60_000,
  }, async () => {
    const manifest = await engineManifest();
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    const rows =
      standard?.variants.filter(
        (variant) =>
          variant.defines.STORAGE_BUFFER_AVAILABLE === false &&
          variant.defines.DIRECTIONAL_SHADOW_SIMPLE === false &&
          variant.defines.COVERAGE_ONLY === false,
      ) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(/fn _samplePcssForCascade\w*\(/.test(row.composedWgsl ?? ''), row.definesKey).toBe(
        true,
      );
    }
  });
});
