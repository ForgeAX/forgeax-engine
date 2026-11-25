import { ok, type ShaderModule } from '@forgeax/engine-rhi';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import {
  findVariantByKey,
  isSupportedVariantDefines,
  ShaderRegistry,
  type ShaderRegistryDevice,
} from '../index.js';
import { loadEngineTemplateRegistry } from './standard-template-registry.fixture.js';

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

let engineRegistry: ShaderRegistry;

function materialShaders() {
  return [...engineRegistry.materialShaderManifestEntries()];
}

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
  'FORWARD_INLINE_SSR',
  'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
  'LEAN_LIGHTING',
  'LOD_DITHER',
  'PROBE_BLEND_AVAILABLE',
  'PROJECTOR_AVAILABLE',
  'REFLECTION_FALLBACK_AVAILABLE',
  'STANDARD_LEAN_INPUTS',
  'STORAGE_BUFFER_AVAILABLE',
  'TRANSMISSION_AVAILABLE',
  'VERTEX_COLOR_AVAILABLE',
  'VISIBLE_SURFACE_AVAILABLE',
  'WATER_INFO_RGBA16',
  'WATER_WAVES_AVAILABLE',
] as const;

// Cluster membership also travels through an integer texture. The remaining
// storage-dependent capabilities retain their constraints.
function violatesCapabilityTopology(defines: Record<string, boolean>): boolean {
  const storageOnly =
    defines.ATMOSPHERE_AVAILABLE ||
    defines.PROBE_BLEND_AVAILABLE ||
    defines.EXTENDED_LIGHTING_AVAILABLE ||
    defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE;
  return Boolean(
    (!defines.STORAGE_BUFFER_AVAILABLE && storageOnly) ||
      (defines.ATMOSPHERE_AVAILABLE && !defines.EXTENDED_LIGHTING_AVAILABLE) ||
      (defines.EXTENDED_LIGHTING_AVAILABLE && !defines.PROJECTOR_AVAILABLE),
  );
}

function expectedStandardCombinations(): Map<string, Record<string, boolean>> {
  const expected = new Map<string, Record<string, boolean>>();
  const baselineAxes = STANDARD_AXES.filter((axis) => axis !== 'FORWARD_INLINE_SSR');
  for (let bits = 0; bits < 2 ** baselineAxes.length; bits++) {
    const defines = Object.fromEntries(
      baselineAxes.map((axis, index) => [axis, (bits & (1 << index)) !== 0]),
    );
    // Combinations the runtime never requests (discard sources, receiver and
    // backend implications) are filtered by the published rule table.
    if (violatesCapabilityTopology(defines) || !isSupportedVariantDefines(defines)) continue;
    const baseline: Record<string, boolean> = { ...defines, FORWARD_INLINE_SSR: false };
    expected.set(STANDARD_AXES.map((axis) => `${axis}=${baseline[axis]}`).join('+'), baseline);
    if (
      defines.EXTENDED_LIGHTING_AVAILABLE &&
      !defines.VISIBLE_SURFACE_AVAILABLE &&
      !defines.REFLECTION_FALLBACK_AVAILABLE
    ) {
      const inlineSsr: Record<string, boolean> = { ...defines, FORWARD_INLINE_SSR: true };
      expected.set(STANDARD_AXES.map((axis) => `${axis}=${inlineSsr[axis]}`).join('+'), inlineSsr);
    }
  }
  return expected;
}

function expectedCoverageKeys(): Set<string> {
  const lanes = [
    { storage: false, scene: false, water: false },
    { storage: true, scene: false, water: false },
    { storage: true, scene: true, water: false },
    { storage: true, scene: false, water: true },
    { storage: true, scene: true, water: true },
  ];
  const keys = new Set<string>();
  for (const lane of lanes) {
    for (const clipping of [false, true]) {
      for (const lod of [false, true]) {
        for (const vertexColor of [false, true]) {
          const enabled = new Set<string>(['COVERAGE_ONLY']);
          if (lane.storage) enabled.add('STORAGE_BUFFER_AVAILABLE');
          if (lane.scene) enabled.add('GPU_DRIVEN_SCENE_INDEX_AVAILABLE');
          if (lane.water) enabled.add('WATER_WAVES_AVAILABLE');
          if (clipping) enabled.add('CLIPPING_PLANES');
          if (lod) enabled.add('LOD_DITHER');
          if (vertexColor) enabled.add('VERTEX_COLOR_AVAILABLE');
          keys.add(STANDARD_AXES.map((axis) => `${axis}=${enabled.has(axis)}`).join('+'));
        }
      }
    }
  }
  return keys;
}

describe('default Standard PBR transmission manifest contract', () => {
  beforeAll(async () => {
    ({ registry: engineRegistry } = await loadEngineTemplateRegistry());
  }, 120_000);

  it('publishes every supported capability combination including transmission', {
    timeout: 60_000,
  }, async () => {
    const standard = materialShaders().find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );

    expect(standard).toBeDefined();
    if (standard === undefined) return;
    const transmissionVariants = standard.variants.filter(
      (variant) => 'TRANSMISSION_AVAILABLE' in variant.defines,
    );
    const expected = expectedStandardCombinations();
    const expectedCoverage = expectedCoverageKeys();
    expect(expectedCoverage).toHaveLength(40);
    // Coverage has its own geometry matrix, independent of color capabilities.
    // The Cartesian/key comparison below still checks the entire publication.
    const ordinary = new Map(
      [...expected].filter(
        ([, defines]) =>
          !defines.COVERAGE_ONLY &&
          !defines.FORWARD_INLINE_SSR &&
          !defines.WATER_WAVES_AVAILABLE &&
          !defines.WATER_INFO_RGBA16,
      ),
    );
    // Modifier-free lighting now supports the full directional receiver too.
    // Retain the complete older oracle independently of these additional rows.
    const addedFullShadowLean = [...ordinary].filter(
      ([, defines]) => defines.LEAN_LIGHTING && !defines.DIRECTIONAL_SHADOW_SIMPLE,
    );
    const legacyOrdinary = new Map(
      [...ordinary].filter(
        ([, defines]) => !defines.LEAN_LIGHTING || defines.DIRECTIONAL_SHADOW_SIMPLE,
      ),
    );
    expect(addedFullShadowLean).toHaveLength(96);
    expect(addedFullShadowLean.filter(([, defines]) => !defines.STANDARD_LEAN_INPUTS)).toHaveLength(
      64,
    );
    expect(addedFullShadowLean.filter(([, defines]) => defines.STANDARD_LEAN_INPUTS)).toHaveLength(
      32,
    );
    expect(ordinary.size).toBe(legacyOrdinary.size + 96);
    for (const [, defines] of addedFullShadowLean) {
      const previousKey = STANDARD_AXES.map(
        (axis) => `${axis}=${axis === 'DIRECTIONAL_SHADOW_SIMPLE' ? true : defines[axis]}`,
      ).join('+');
      expect(legacyOrdinary.get(previousKey)).toEqual({
        ...defines,
        DIRECTIONAL_SHADOW_SIMPLE: true,
      });
    }
    const actual = new Map(transmissionVariants.map((variant) => [variant.definesKey, variant]));
    expect(transmissionVariants).toHaveLength(expected.size);
    expect(actual.size).toBe(expected.size);
    expect(new Set(actual.keys())).toEqual(new Set(expected.keys()));
    expect(
      new Set(
        transmissionVariants
          .filter((variant) => variant.defines.COVERAGE_ONLY)
          .map((variant) => variant.definesKey),
      ),
    ).toEqual(expectedCoverage);
    for (const [key, defines] of expected) {
      const variant = actual.get(key);
      expect(variant?.defines).toEqual(defines);
    }
    const directVisibleRows = [...ordinary.values()].filter(
      (defines) => defines.VISIBLE_SURFACE_AVAILABLE && !defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE,
    );
    expect(directVisibleRows).toHaveLength(4 * 2 * 2 * 2);
    // Count the contract independently of the producer and permutation helper:
    // no-storage, storage/direct, direct G-buffer, and storage/scene-index rows.
    // The direct G-buffer slice has four (projector, extended, atmosphere)
    // topologies, two probe choices, two alpha-mask choices and two independent
    // clipping choices. Direct color rows have alpha(2)*clipping(2)=4
    // states. Scene-index color rows also have visible(2)*LOD(2), so 16 states.
    const generalRows = 32 * 4 + 128 * 4 + 4 * 2 * 2 * 2 + 128 * 16;
    // Lean fixes the receiver/discard axes. Four lighting topologies combine
    // with GPU scene-index, cluster, vertex colour and reflection choices.
    const leanRows = 4 * 2 ** 4;
    // Storage-lane lean lighting still samples the cloud map selected by
    // PROJECTOR_AVAILABLE, even when the material projector read is absent.
    // Full-lighting receivers also keep both ProbeBlend choices.
    const fullSimpleRows = 4 * 2 ** 5;
    // STANDARD_LEAN_INPUTS adds a row for each storage scene-index row without
    // transmission, coverage-only or LOD dither. Its rules never read
    // LEAN_LIGHTING or DIRECTIONAL_SHADOW_SIMPLE, so the scene-index half of
    // the lean (32) and full-lighting simple (64) rows qualify too. The general
    // slice is four topologies times probe, cluster, color, reflection,
    // visible, alpha and clipping (all independent binary choices).
    // Sixteen of the lean-lighting rows lack extended lighting and alias in
    // projector pairs; full-lighting rows keep distinct code.
    const fullSimpleLeanInputRows = fullSimpleRows / 2;
    const leanInputRows = 4 * 2 ** 7 + leanRows / 2 + fullSimpleLeanInputRows;
    const leanInputProjectorPairs = 8;
    expect(legacyOrdinary.size).toBe(generalRows + leanRows + fullSimpleRows + leanInputRows);
    // No-storage/non-Cluster/non-transmission color has four receiver/discard
    // states, two vertex-colour and two reflection choices. Each projector pair
    // shares code because neither the projector nor cloud map is consumed.
    const noStorageProjectorPairs = 4 * 2 * 2;
    const noStorageInactiveChoices = [...legacyOrdinary.values()].filter(
      (defines) =>
        !defines.STORAGE_BUFFER_AVAILABLE &&
        !defines.CLUSTER_FORWARD_AVAILABLE &&
        !defines.TRANSMISSION_AVAILABLE,
    );
    expect(noStorageInactiveChoices).toHaveLength(2 * noStorageProjectorPairs);
    const leanChoices = [...legacyOrdinary.values()].filter(
      (defines) => defines.LEAN_LIGHTING && !defines.EXTENDED_LIGHTING_AVAILABLE,
    );
    expect(leanChoices).toHaveLength(32 + 2 * leanInputProjectorPairs);
    const fullSimple = [...ordinary.values()].filter(
      (defines) => defines.DIRECTIONAL_SHADOW_SIMPLE && !defines.LEAN_LIGHTING,
    );
    expect(fullSimple).toHaveLength(128 + fullSimpleLeanInputRows);
    // The new full-lighting receiver rows preserve all previously published choices.
    expect(legacyOrdinary.size - fullSimple.length - leanChoices.length).toBe(
      generalRows +
        leanRows / 2 +
        leanInputRows -
        fullSimpleLeanInputRows -
        2 * leanInputProjectorPairs,
    );
    expect(standard.variants.every((variant) => 'TRANSMISSION_AVAILABLE' in variant.defines)).toBe(
      true,
    );
    // Non-lean no-Water rows omit the unused format. Storage ordinary rows
    // add both Water formats; lean inputs retain all four waves/format lanes.
    const storageOrdinary = [...ordinary.values()].filter(
      (row) => row.STORAGE_BUFFER_AVAILABLE && !row.STANDARD_LEAN_INPUTS,
    );
    const leanOrdinary = [...ordinary.values()].filter((row) => row.STANDARD_LEAN_INPUTS);
    const inlineSsrRows = [...expected.values()].filter((row) => row.FORWARD_INLINE_SSR);
    expect(inlineSsrRows).toHaveLength(1728);
    expect(expected.size).toBe(
      ordinary.size +
        2 * storageOrdinary.length +
        3 * leanOrdinary.length +
        expectedCoverage.size +
        inlineSsrRows.length,
    );
    for (const waves of [true, false]) {
      for (const rgba16 of [true, false]) {
        const leanLane = [...expected.values()].filter(
          (row) =>
            row.STANDARD_LEAN_INPUTS &&
            !row.FORWARD_INLINE_SSR &&
            row.WATER_WAVES_AVAILABLE === waves &&
            row.WATER_INFO_RGBA16 === rgba16,
        );
        const addedLeanLane = leanLane.filter(
          (row) => row.LEAN_LIGHTING && !row.DIRECTIONAL_SHADOW_SIMPLE,
        );
        expect(addedLeanLane).toHaveLength(32);
        expect(leanLane.filter((row) => !addedLeanLane.includes(row))).toHaveLength(leanInputRows);
        expect(leanLane).toHaveLength(leanInputRows + 32);
      }
    }
  });

  it('generates reflection response work only for an admitted reflection output', {
    timeout: 60_000,
  }, async () => {
    const standard = materialShaders().find(
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
    const standard = materialShaders().find(
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
    const standard = materialShaders().find(
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
      /out(?:_\d+)?\.materialAddress\s*=\s*materialAddress(?:_\d+)?(?:\.[xyz]+)?;/,
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
    const skin = materialShaders().find((entry) => entry.identifier === 'forgeax::pbr-skin');
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
    const standard = materialShaders().find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;

    const { registry } = await loadEngineTemplateRegistry();
    const rows = [...registry.materialShaderManifestEntries()].filter(
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
