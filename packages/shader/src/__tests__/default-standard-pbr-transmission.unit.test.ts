import { ok, type ShaderModule } from '@forgeax/engine-rhi';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import {
  findVariantByKey,
  isSupportedVariantDefines,
  ShaderRegistry,
  type ShaderRegistryDevice,
} from '../index.js';

type EngineShaderManifest = Awaited<
  ReturnType<typeof import('@forgeax/engine-vite-plugin-shader').buildEngineShaderManifest>
>;

function dataUrl(payload: unknown): string {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  );
  onTestFinished(() => URL.revokeObjectURL(url));
  return url;
}

function device(): ShaderRegistryDevice {
  return {
    createShaderModule(): ReturnType<ShaderRegistryDevice['createShaderModule']> {
      return ok({} as ShaderModule);
    },
  };
}

async function engineManifest(): Promise<EngineShaderManifest> {
  engineManifestPromise ??= import('@forgeax/engine-vite-plugin-shader').then(
    ({ buildEngineShaderManifest }) => buildEngineShaderManifest(),
  );
  return engineManifestPromise;
}

let engineManifestPromise: Promise<EngineShaderManifest> | undefined;

// An independent complete Cartesian oracle prevents a new axis from
// silently shrinking either ordinary or optional output permutations.
const STANDARD_AXES = [
  'ALPHA_MASK',
  'ATMOSPHERE_AVAILABLE',
  'CLIPPING_PLANES',
  'CLUSTER_FORWARD_AVAILABLE',
  'COVERAGE_ONLY',
  'DIRECTIONAL_SHADOW_SIMPLE',
  'EXTENDED_LIGHTING_AVAILABLE',
  'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
  'LEAN_LIGHTING',
  'LOD_DITHER',
  'PROBE_BLEND_AVAILABLE',
  'PROJECTOR_AVAILABLE',
  'REFLECTION_FALLBACK_AVAILABLE',
  'STORAGE_BUFFER_AVAILABLE',
  'TRANSMISSION_AVAILABLE',
  'VERTEX_COLOR_AVAILABLE',
  'VISIBLE_SURFACE_AVAILABLE',
] as const;

// Cluster membership also travels through an integer texture. The remaining
// storage-dependent capabilities retain their constraints.
function violatesCapabilityTopology(defines: Record<string, boolean>): boolean {
  const storageOnly =
    defines.ATMOSPHERE_AVAILABLE ||
    defines.PROBE_BLEND_AVAILABLE ||
    defines.EXTENDED_LIGHTING_AVAILABLE ||
    defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE;
  return (
    (!defines.STORAGE_BUFFER_AVAILABLE && storageOnly) ||
    (defines.ATMOSPHERE_AVAILABLE && !defines.EXTENDED_LIGHTING_AVAILABLE) ||
    (defines.EXTENDED_LIGHTING_AVAILABLE && !defines.PROJECTOR_AVAILABLE)
  );
}

function expectedStandardCombinations(): Map<string, Record<string, boolean>> {
  const expected = new Map<string, Record<string, boolean>>();
  for (let bits = 0; bits < 2 ** STANDARD_AXES.length; bits++) {
    const defines = Object.fromEntries(
      STANDARD_AXES.map((axis, index) => [axis, (bits & (1 << index)) !== 0]),
    );
    // Combinations the runtime never requests (discard sources, receiver and
    // backend implications) are filtered by the published rule table.
    if (violatesCapabilityTopology(defines) || !isSupportedVariantDefines(defines)) continue;
    const key = STANDARD_AXES.every((axis) => defines[axis])
      ? ''
      : STANDARD_AXES.map((axis) => `${axis}=${defines[axis]}`).join('+');
    expected.set(key, defines);
  }
  return expected;
}

function expectLightModifierResources(
  key: string,
  defines: Record<string, boolean>,
  code: string,
): void {
  const extended = defines.CLUSTER_FORWARD_AVAILABLE && defines.EXTENDED_LIGHTING_AVAILABLE;
  for (const resource of ['iesProfileTexture', 'cookieTexture', 'ltcGgxTexture']) {
    // LEAN_LIGHTING removes the Cookie and rect-area (LTC) call sites; the
    // imported IES helper body stays in the module.
    const sampled = extended && (resource === 'iesProfileTexture' || !defines.LEAN_LIGHTING);
    expect(
      new RegExp(`textureSampleLevel\\(${resource}\\w*,`).test(code),
      `${key}: ${resource}`,
    ).toBe(sampled);
  }
}

describe('default Standard PBR transmission manifest contract', () => {
  // The first manifest build is producer setup, not part of the assertion budget.
  beforeAll(async () => {
    await engineManifest();
  }, 120_000);

  it('publishes every supported capability combination including transmission', {
    timeout: 60_000,
  }, async () => {
    const manifest = await engineManifest();
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );

    expect(standard).toBeDefined();
    if (standard === undefined) return;
    const transmissionVariants = standard.variants.filter(
      (variant) => 'TRANSMISSION_AVAILABLE' in variant.defines,
    );
    const expected = expectedStandardCombinations();
    const actual = new Map(transmissionVariants.map((variant) => [variant.definesKey, variant]));
    expect(transmissionVariants).toHaveLength(expected.size);
    expect(actual.size).toBe(expected.size);
    expect(new Set(actual.keys())).toEqual(new Set(expected.keys()));
    for (const [key, defines] of expected) {
      const variant = actual.get(key);
      expect(variant?.defines).toEqual(defines);
      if (defines.CLUSTER_FORWARD_AVAILABLE && !defines.STORAGE_BUFFER_AVAILABLE) {
        expect(variant?.composedWgsl).toMatch(
          /var\s+cluster_data_texture\w*\s*:\s*texture_2d<u32>/,
        );
        expect(variant?.composedWgsl).toMatch(/textureLoad\(cluster_data_texture\w*,/);
        expect(variant?.composedWgsl).not.toMatch(/var\s*<\s*storage\b/);
      }
    }
    // VSM reception uses the extended resource topology even without clustered
    // lights or atmosphere. Preserve every public choice and its distinct code.
    const programsByEffectiveChoice = new Map<string, string>();
    const choicesByProgram = new Map<string, string>();
    for (const [key, defines] of expected) {
      const choice = STANDARD_AXES.map((axis) => `${axis}=${defines[axis]}`).join('+');
      const code = actual.get(key)?.composedWgsl;
      if (code === undefined) throw new Error(`missing supported program ${key}`);
      expectLightModifierResources(key, defines, code);
      const previousCode = programsByEffectiveChoice.get(choice);
      if (previousCode !== undefined) expect(code).toBe(previousCode);
      programsByEffectiveChoice.set(choice, code);
      // LEAN_LIGHTING drops projector sampling, so its rows may share code
      // across PROJECTOR_AVAILABLE; every other choice keeps distinct code.
      const programKey = defines.LEAN_LIGHTING
        ? choice.replace(/PROJECTOR_AVAILABLE=(true|false)/, 'PROJECTOR_AVAILABLE=*')
        : choice;
      const previousChoice = choicesByProgram.get(code);
      if (previousChoice !== undefined) expect(programKey).toBe(previousChoice);
      choicesByProgram.set(code, programKey);
    }
    // The CPU-direct deferred lane adds 16 clip-only visible-surface rows.
    // It shares the producer's published 2032-row contract, not the older 2016.
    const directVisibleRows = [...expected.values()].filter(
      (defines) =>
        defines.VISIBLE_SURFACE_AVAILABLE &&
        !defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE &&
        !defines.COVERAGE_ONLY,
    );
    expect(directVisibleRows).toHaveLength(16);
    const leanChoices = [...expected.values()].filter(
      (defines) => defines.LEAN_LIGHTING && !defines.EXTENDED_LIGHTING_AVAILABLE,
    );
    expect(leanChoices).toHaveLength(32);
    expect(expected.size - leanChoices.length).toBe(2000);
    expect(programsByEffectiveChoice.size).toBe(2032);
    // The 32 lean choices without extended lighting share code pairwise across
    // PROJECTOR_AVAILABLE; all other 2000 choices keep distinct code.

    expect(choicesByProgram.size).toBe(2016);
    expect(standard.variants.every((variant) => 'TRANSMISSION_AVAILABLE' in variant.defines)).toBe(
      true,
    );
  });

  it('generates reflection response work only for an admitted reflection output', {
    timeout: 60_000,
  }, async () => {
    const manifest = await engineManifest();
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;
    const selected = new Map<boolean, string>();
    for (const variant of standard.variants) {
      const enabled = variant.defines.REFLECTION_FALLBACK_AVAILABLE;
      if (typeof enabled !== 'boolean' || selected.has(enabled)) continue;
      selected.set(enabled, variant.composedWgsl);
    }
    expect(selected.size).toBe(2);
    expect(selected.get(false)).not.toMatch(/\b(?:reflectionResponse|coatResponse)\w*\b/);
    expect(selected.get(true)).toMatch(/\breflectionResponse\w*\b/);
  });

  it('omits transmission and physical resources from the non-transmission fallback variant', {
    timeout: 60_000,
  }, async () => {
    const manifest = await engineManifest();
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;

    const fallback = standard.variants.find(
      (variant) =>
        variant.defines.CLUSTER_FORWARD_AVAILABLE === false &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === true &&
        variant.defines.EXTENDED_LIGHTING_AVAILABLE === false &&
        variant.defines.PROBE_BLEND_AVAILABLE === false &&
        variant.defines.TRANSMISSION_AVAILABLE === false &&
        variant.defines.VERTEX_COLOR_AVAILABLE === false,
    );
    expect(fallback).toBeDefined();
    if (fallback === undefined) return;
    expect(fallback.composedWgsl).not.toMatch(
      /var(?:<[^>]+>)?\s+(?:transmissionSampler|transmissionTexture|thicknessSampler|thicknessTexture|clearcoatTexture|clearcoatRoughnessTexture|clearcoatNormalTexture|anisotropyTexture|sheenColorTexture|sheenRoughnessTexture|iridescenceTexture|iridescenceThicknessTexture|specularTexture)\b/u,
    );
  });

  it('keeps material-index varying GPU-only while preserving the scene-index variant', {
    timeout: 60_000,
  }, async () => {
    const manifest = await engineManifest();
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;

    const sceneIndex = standard.variants.find(
      (variant) =>
        variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === true &&
        variant.defines.TRANSMISSION_AVAILABLE === false &&
        variant.defines.CLUSTER_FORWARD_AVAILABLE === false &&
        variant.defines.VERTEX_COLOR_AVAILABLE === false,
    );
    expect(sceneIndex).toBeDefined();
    expect(sceneIndex?.composedWgsl).toMatch(
      /out(?:_\d+)?\.materialAddress\s*=\s*materialAddress(?:_\d+)?;/,
    );
    // ShadowParticipation.receive rides bit 31 of the scene material row.
    expect(sceneIndex?.composedWgsl).toMatch(
      /select\(STANDARD_NO_RECEIVE_BIT\w*,\s*0u,\s*\w+\.receivesShadows\)/,
    );

    const directFallback = standard.variants.find(
      (variant) =>
        variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === false &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === false &&
        variant.defines.TRANSMISSION_AVAILABLE === false &&
        variant.defines.CLUSTER_FORWARD_AVAILABLE === false &&
        variant.defines.VERTEX_COLOR_AVAILABLE === false,
    );
    expect(directFallback).toBeDefined();
    expect(directFallback?.composedWgsl).not.toMatch(
      /@location\(15\)\s+@interpolate\(flat\)\s+materialAddress/,
    );
    expect(directFallback?.composedWgsl).not.toMatch(/out(?:_\d+)?\.materialAddress\s*=/);
  });

  it('publishes the same explicit transmission axis for the skin Standard template', {
    timeout: 60_000,
  }, async () => {
    const manifest = await engineManifest();
    const skin = manifest.materialShaders.find((entry) => entry.identifier === 'forgeax::pbr-skin');
    expect(skin).toBeDefined();
    if (skin === undefined) return;
    expect(skin.variants.length).toBeGreaterThan(0);
    expect(skin.variants.every((variant) => 'TRANSMISSION_AVAILABLE' in variant.defines)).toBe(
      true,
    );
    expect(skin.variants.some((variant) => variant.defines.TRANSMISSION_AVAILABLE === false)).toBe(
      true,
    );
    expect(skin.variants.some((variant) => variant.defines.TRANSMISSION_AVAILABLE === true)).toBe(
      true,
    );
  });

  it('registers one Standard row and resolves a declared capability variant by exact key', {
    timeout: 20_000,
  }, async () => {
    const manifest = await engineManifest();
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;

    const { publishShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
    const registry = new ShaderRegistry({
      device: device(),
      manifestUrl: dataUrl(publishShaderManifest([], [standard])),
    });
    const loaded = await registry.loadManifest();
    expect(loaded.ok).toBe(true);
    const rows = Array.from(registry.materialShaderManifestEntries()).filter(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(rows).toHaveLength(1);
    const registered = rows[0];
    expect(registered).toBeDefined();
    if (registered === undefined) return;

    const variant = registered.variants.find(
      (candidate) => candidate.defines.CLUSTER_FORWARD_AVAILABLE === false,
    );
    expect(variant).toBeDefined();
    if (variant === undefined) return;
    expect(findVariantByKey(registered, variant.definesKey)).toBe(variant);
    expect(findVariantByKey(registered, `${variant.definesKey}+UNDECLARED=true`)).toBeUndefined();
  });

  it('rejects duplicate variant keys instead of allowing ambiguous prewarm', async () => {
    const duplicateVariant = {
      identifier: 'forgeax::default-standard-pbr',
      sourcePath: 'default-standard-pbr.wgsl',
      composedWgsl: 'standard-default',
      paramSchema: '[]',
      variants: [
        {
          definesKey: 'CLUSTER_FORWARD_AVAILABLE=false',
          defines: { CLUSTER_FORWARD_AVAILABLE: false },
          composedWgsl: 'standard-a',
        },
        {
          definesKey: 'CLUSTER_FORWARD_AVAILABLE=false',
          defines: { CLUSTER_FORWARD_AVAILABLE: false },
          composedWgsl: 'standard-b',
        },
      ],
    };
    const registry = new ShaderRegistry({
      device: device(),
      manifestUrl: dataUrl({ entries: [], materialShaders: [duplicateVariant] }),
    });

    const loaded = await registry.loadManifest();
    expect(loaded.ok).toBe(false);
  });
});
