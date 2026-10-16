import { ok, type ShaderModule } from '@forgeax/engine-rhi';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { findVariantByKey, ShaderRegistry, type ShaderRegistryDevice } from '../index.js';

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
    // An independent complete Cartesian oracle prevents a new axis from
    // silently shrinking either ordinary or optional output permutations.
    const axes = [
      'ATMOSPHERE_AVAILABLE',
      'CLUSTER_FORWARD_AVAILABLE',
      'COVERAGE_ONLY',
      'DIRECTIONAL_PCSS_AVAILABLE',
      'EXTENDED_LIGHTING_AVAILABLE',
      'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
      'PROBE_BLEND_AVAILABLE',
      'PROJECTOR_AVAILABLE',
      'REFLECTION_FALLBACK_AVAILABLE',
      'STORAGE_BUFFER_AVAILABLE',
      'TRANSMISSION_AVAILABLE',
      'VERTEX_COLOR_AVAILABLE',
      'VISIBLE_SURFACE_AVAILABLE',
    ] as const;
    const expected = new Map<string, Record<string, boolean>>();
    for (let bits = 0; bits < 2 ** axes.length; bits++) {
      const defines = Object.fromEntries(
        axes.map((axis, index) => [axis, (bits & (1 << index)) !== 0]),
      );
      // Cluster membership also travels through an integer texture. The
      // remaining storage-dependent capabilities retain their constraints.
      if (
        (!defines.STORAGE_BUFFER_AVAILABLE &&
          (defines.ATMOSPHERE_AVAILABLE ||
            defines.PROBE_BLEND_AVAILABLE ||
            defines.EXTENDED_LIGHTING_AVAILABLE ||
            defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE)) ||
        (defines.ATMOSPHERE_AVAILABLE && !defines.EXTENDED_LIGHTING_AVAILABLE) ||
        (defines.EXTENDED_LIGHTING_AVAILABLE && !defines.PROJECTOR_AVAILABLE)
      )
        continue;
      const key = axes.every((axis) => defines[axis])
        ? ''
        : axes.map((axis) => `${axis}=${defines[axis]}`).join('+');
      expected.set(key, defines);
    }
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
    // Extended-light evaluation needs cluster membership or atmosphere. Preserve
    // every public choice above, but share code when that feature has no consumer.
    const programsByEffectiveChoice = new Map<string, string>();
    const choicesByProgram = new Map<string, string>();
    for (const [key, defines] of expected) {
      const effective: Record<string, boolean | undefined> = {
        ...defines,
        EXTENDED_LIGHTING_AVAILABLE:
          defines.EXTENDED_LIGHTING_AVAILABLE &&
          (defines.CLUSTER_FORWARD_AVAILABLE || defines.ATMOSPHERE_AVAILABLE),
      };
      const choice = axes.map((axis) => `${axis}=${effective[axis]}`).join('+');
      const code = actual.get(key)?.composedWgsl;
      if (code === undefined) throw new Error(`missing supported program ${key}`);
      for (const resource of ['iesProfileTexture', 'cookieTexture', 'ltcGgxTexture']) {
        expect(
          new RegExp(`textureSampleLevel\\(${resource}\\w*,`).test(code),
          `${key}: ${resource}`,
        ).toBe(defines.CLUSTER_FORWARD_AVAILABLE && defines.EXTENDED_LIGHTING_AVAILABLE);
      }
      const previousCode = programsByEffectiveChoice.get(choice);
      if (previousCode !== undefined) expect(code).toBe(previousCode);
      const previousChoice = choicesByProgram.get(code);
      if (previousChoice !== undefined) expect(choice).toBe(previousChoice);
      programsByEffectiveChoice.set(choice, code);
      choicesByProgram.set(code, choice);
    }
    expect(programsByEffectiveChoice.size).toBe(2048);
    expect(choicesByProgram.size).toBe(programsByEffectiveChoice.size);
    expect(standard.variants.every((variant) => 'TRANSMISSION_AVAILABLE' in variant.defines)).toBe(
      true,
    );
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

    const registry = new ShaderRegistry({
      device: device(),
      manifestUrl: dataUrl({ entries: [], materialShaders: [standard] }),
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
