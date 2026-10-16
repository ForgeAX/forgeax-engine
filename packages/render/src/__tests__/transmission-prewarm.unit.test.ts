import { describe, expect, it } from 'vitest';
import {
  type MaterialShaderManifestEntry,
  selectGpuDrivenSceneIndexVariant,
  selectHdrpPbrPrewarmVariants,
  selectProbePrewarmVariants,
  selectSkinPrewarmVariants,
  selectStandardPbrTransmissionPrewarmVariants,
} from '../assembly/factory.js';

const falseKey =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false';
const trueKey =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';
const probeFalseKey =
  'CLUSTER_FORWARD_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false';
const probeTrueKey =
  'CLUSTER_FORWARD_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';

describe('material prewarm draw ABI', () => {
  it('prepares clustered, probe and skin programs for both direct and scene-index draws', () => {
    const variants: MaterialShaderManifestEntry['variants'][number][] = [];
    for (const sceneIndex of [false, true]) {
      for (const probe of [false, true]) {
        for (const cluster of [false, true]) {
          for (const color of [false, true]) {
            for (const reflection of [false, true]) {
              const defines = {
                STORAGE_BUFFER_AVAILABLE: true,
                GPU_DRIVEN_SCENE_INDEX_AVAILABLE: sceneIndex,
                PROBE_BLEND_AVAILABLE: probe,
                CLUSTER_FORWARD_AVAILABLE: cluster,
                VERTEX_COLOR_AVAILABLE: color,
                REFLECTION_FALLBACK_AVAILABLE: reflection,
                TRANSMISSION_AVAILABLE: false,
              };
              variants.push({
                defines,
                definesKey: JSON.stringify(defines),
                composedWgsl: JSON.stringify(defines),
              });
            }
          }
        }
      }
    }
    const entry = standardEntry(variants);
    for (const selected of [
      selectHdrpPbrPrewarmVariants(entry, true),
      selectProbePrewarmVariants(entry, true),
      selectSkinPrewarmVariants(entry, true),
    ]) {
      expect(
        new Set(selected.map(({ defines }) => defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE)),
      ).toEqual(new Set([false, true]));
      expect(new Set(selected.map(({ defines }) => defines.VERTEX_COLOR_AVAILABLE)).size).toBe(2);
      expect(
        new Set(selected.map(({ defines }) => defines.REFLECTION_FALLBACK_AVAILABLE)).size,
      ).toBe(2);
    }
    const gpu = selectGpuDrivenSceneIndexVariant(entry, true, true, true);
    expect(gpu?.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE).toBe(true);
    expect(gpu?.defines.PROBE_BLEND_AVAILABLE).toBe(false);
  });
});

function standardEntry(
  variants: readonly MaterialShaderManifestEntry['variants'][number][],
): MaterialShaderManifestEntry {
  return {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'default-standard-pbr.wgsl',
    composedWgsl: 'standard-default',
    paramSchema: '[]',
    variants,
  };
}

function variant(cluster: boolean, storage: boolean, projector?: boolean) {
  const defines = {
    CLUSTER_FORWARD_AVAILABLE: cluster,
    STORAGE_BUFFER_AVAILABLE: storage,
    VERTEX_COLOR_AVAILABLE: false,
    ...(projector === undefined ? {} : { PROJECTOR_AVAILABLE: projector }),
  };
  return {
    definesKey: Object.entries(defines)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('+'),
    defines,
    composedWgsl: JSON.stringify(defines),
  };
}

function transmissionVariant(definesKey: string, transmission: boolean) {
  return {
    definesKey,
    defines: {
      CLUSTER_FORWARD_AVAILABLE: false,
      STORAGE_BUFFER_AVAILABLE: true,
      TRANSMISSION_AVAILABLE: transmission,
      VERTEX_COLOR_AVAILABLE: false,
    },
    composedWgsl: `standard-${transmission}`,
  };
}

function coverageTransmissionVariant(definesKey: string, transmission: boolean) {
  const base = transmissionVariant(definesKey, transmission);
  return {
    ...base,
    definesKey: `COVERAGE_ONLY=true+${definesKey}`,
    defines: { ...base.defines, COVERAGE_ONLY: true },
    composedWgsl: `coverage-${transmission}`,
  };
}

function probeTransmissionVariant(definesKey: string, transmission: boolean) {
  const base = transmissionVariant(definesKey, transmission);
  return {
    ...base,
    defines: { ...base.defines, PROBE_BLEND_AVAILABLE: true },
  };
}

describe('Standard transmission exact-key prewarm selection', () => {
  it('returns both declared transmission variants', () => {
    const entry = standardEntry([
      transmissionVariant(falseKey, false),
      transmissionVariant(trueKey, true),
    ]);
    expect(
      selectStandardPbrTransmissionPrewarmVariants(entry, true).map((item) => item.definesKey),
    ).toEqual([falseKey, trueKey]);
  });

  it('prewarms nothing without a Standard manifest row', () => {
    expect(selectStandardPbrTransmissionPrewarmVariants(undefined, true)).toEqual([]);
  });

  it('rejects a missing exact transmission variant', () => {
    const entry = standardEntry([transmissionVariant(falseKey, false)]);
    expect(() => selectStandardPbrTransmissionPrewarmVariants(entry, true)).toThrow(
      'TRANSMISSION_AVAILABLE=true',
    );
  });

  it('keeps coverage-only variants out of the ordinary prewarm set', () => {
    const entry = standardEntry([
      coverageTransmissionVariant(falseKey, false),
      transmissionVariant(falseKey, false),
      coverageTransmissionVariant(trueKey, true),
      transmissionVariant(trueKey, true),
    ]);
    expect(
      selectStandardPbrTransmissionPrewarmVariants(entry, true).map((item) => item.definesKey),
    ).toEqual([falseKey, trueKey]);
  });
});

describe('HDRP PBR capability prewarm selection', () => {
  it('selects only the matching static capability/geometry state', () => {
    const entry = standardEntry([
      variant(true, true),
      variant(true, false),
      variant(false, true),
      variant(false, false),
    ]);
    expect(selectHdrpPbrPrewarmVariants(entry, true).map((item) => item.definesKey)).toEqual([
      variant(true, true).definesKey,
    ]);
    // Cluster-forward requires the storage-backed group(2) ABI. A device
    // without storage support must stay on the URP route and prewarm nothing.
    expect(selectHdrpPbrPrewarmVariants(entry, false)).toEqual([]);
  });

  it('respects an explicitly declared projector capability', () => {
    const entry = standardEntry([
      variant(true, true, true),
      variant(true, true, false),
      variant(true, true),
    ]);
    expect(
      selectHdrpPbrPrewarmVariants(entry, true, undefined, true).map((item) => item.definesKey),
    ).toEqual([variant(true, true, true).definesKey, variant(true, true).definesKey]);
  });
});

describe('probe material module prewarm capability selection', () => {
  it('keeps probe variants out of the fallback tier and matches device-owned axes', () => {
    const entry = standardEntry([
      probeTransmissionVariant(probeFalseKey, false),
      probeTransmissionVariant(probeTrueKey, true),
    ]);
    expect(selectProbePrewarmVariants(entry, false)).toEqual([]);
    expect(selectProbePrewarmVariants(entry, true).map((variant) => variant.definesKey)).toEqual([
      probeFalseKey,
      probeTrueKey,
    ]);
  });

  it('filters backend and sampled-texture axes but retains geometry/topology choices', () => {
    const goodKey =
      'CLUSTER_FORWARD_AVAILABLE=true+EXTENDED_LIGHTING_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true+PROJECTOR_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=true';
    const wrongExtendedKey = goodKey.replace(
      'EXTENDED_LIGHTING_AVAILABLE=false',
      'EXTENDED_LIGHTING_AVAILABLE=true',
    );
    const wrongProjectorKey = goodKey.replace(
      'PROJECTOR_AVAILABLE=false',
      'PROJECTOR_AVAILABLE=true',
    );
    const wrongTransmissionKey = goodKey.replace(
      'TRANSMISSION_AVAILABLE=false',
      'TRANSMISSION_AVAILABLE=true',
    );
    const variant = (definesKey: string, defines: Record<string, boolean>) => ({
      definesKey,
      defines,
      composedWgsl: definesKey,
    });
    const baseDefines = {
      CLUSTER_FORWARD_AVAILABLE: true,
      EXTENDED_LIGHTING_AVAILABLE: false,
      PROBE_BLEND_AVAILABLE: true,
      PROJECTOR_AVAILABLE: false,
      STORAGE_BUFFER_AVAILABLE: true,
      TRANSMISSION_AVAILABLE: false,
      VERTEX_COLOR_AVAILABLE: true,
    };
    const selected = selectProbePrewarmVariants(
      standardEntry([
        variant(goodKey, baseDefines),
        variant(wrongExtendedKey, { ...baseDefines, EXTENDED_LIGHTING_AVAILABLE: true }),
        variant(wrongProjectorKey, { ...baseDefines, PROJECTOR_AVAILABLE: true }),
        variant(wrongTransmissionKey, { ...baseDefines, TRANSMISSION_AVAILABLE: true }),
      ]),
      true,
      false,
      false,
      true,
      false,
    );
    expect(selected.map((candidate) => candidate.definesKey)).toEqual([goodKey]);
  });
});

describe('GPU-driven scene-index prewarm capability selection', () => {
  it('uses the non-reflection-fallback variant for the dedicated scene-index ABI', () => {
    const makeVariant = (reflectionFallback: boolean) => {
      const defines = {
        CLUSTER_FORWARD_AVAILABLE: false,
        DIRECTIONAL_PCSS_AVAILABLE: true,
        EXTENDED_LIGHTING_AVAILABLE: true,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
        PROBE_BLEND_AVAILABLE: false,
        PROJECTOR_AVAILABLE: true,
        REFLECTION_FALLBACK_AVAILABLE: reflectionFallback,
        STORAGE_BUFFER_AVAILABLE: true,
        TRANSMISSION_AVAILABLE: false,
        VERTEX_COLOR_AVAILABLE: false,
      };
      return {
        defines,
        definesKey: Object.entries(defines)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, value]) => `${name}=${value}`)
          .join('+'),
        composedWgsl: JSON.stringify(defines),
      };
    };
    const selected = selectGpuDrivenSceneIndexVariant(
      standardEntry([makeVariant(true), makeVariant(false)]),
      true,
      true,
      true,
    );
    expect(selected?.defines.REFLECTION_FALLBACK_AVAILABLE).toBe(false);
  });
});

it.each([false, true])('prewarms only the receiving atmosphere capability %s', (available) => {
  const entry = standardEntry(
    [false, true].flatMap((atmosphere) =>
      [false, true].map((probe) => ({
        definesKey: `atmosphere=${atmosphere},probe=${probe}`,
        composedWgsl: '',
        defines: {
          STORAGE_BUFFER_AVAILABLE: true,
          ATMOSPHERE_AVAILABLE: atmosphere,
          CLUSTER_FORWARD_AVAILABLE: true,
          PROBE_BLEND_AVAILABLE: probe,
        },
      })),
    ),
  );
  for (const selected of [
    selectHdrpPbrPrewarmVariants(entry, true, true, true, true, true, available),
    selectProbePrewarmVariants(entry, true, true, true, true, true, false, available),
    selectSkinPrewarmVariants(entry, true, true, true, true, true, available),
  ]) {
    expect(selected).toHaveLength(1);
    expect(selected[0]?.defines.ATMOSPHERE_AVAILABLE).toBe(available);
  }
});
