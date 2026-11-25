import {
  createStandardPbrArtifactReceipt,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { compileShader, reachableShaderImportIds } from '@forgeax/engine-shader-compiler';
import type { ShaderProgramContract, ShaderReflection } from '@forgeax/engine-types';
import { loadEngineShaderEntries } from '../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { waterInfoRasterEngineEntries } from '../../../vite-plugin-shader/src/engine-inputs/water-info-raster-roster';
import { STANDARD_CLUSTER_TEST_REFLECTION } from './cluster-test-abi';

type FixtureEntry = {
  readonly hash: string;
  readonly wgsl: string;
  readonly glsl: string;
  readonly bindings: string;
  readonly reflection?: ShaderReflection;
  readonly programContract?: ShaderProgramContract;
};

// RhiNull fixtures retain the temporal entry names required by pipeline admission.
const temporalEntries = '\nfn vs_temporal() {}\nfn fs_temporal() {}\n';
const pbrWgsl = `// fixture marker: f_schlick\n${temporalEntries}`;
const unlitWgsl = `// fixture marker: default-unlit\n${temporalEntries}`;
const shadowCasterWgsl = '// fixture marker: shadow-caster\n';
const fixtureCompilerProfile = {
  id: 'forgeax-material-wgsl-v1',
  language: 'wgsl',
  profileVersion: '1',
  adapterVersion: '1',
  compilerVersion: '1',
  nagaVersion: '30.0.1',
} as const;

const baseEntries: readonly FixtureEntry[] = [
  {
    hash: 'fixture-pbr',
    wgsl: pbrWgsl,
    glsl: '',
    bindings: '[]',
    reflection: STANDARD_CLUSTER_TEST_REFLECTION,
  },
  { hash: 'fixture-unlit', wgsl: unlitWgsl, glsl: '', bindings: '[]' },
  { hash: 'fixture-shadow-caster', wgsl: shadowCasterWgsl, glsl: '', bindings: '[]' },
  {
    hash: 'fixture-tonemap',
    wgsl: '// fixture marker: TonemapParams\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-taa',
    wgsl: '// fixture marker: fs_taa_resolve\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-motion-blur',
    wgsl: '// fixture marker: MotionBlurParams\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-fxaa',
    wgsl: '// fixture marker: rgb2luma\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-bloom-horizontal',
    wgsl: '// fixture marker: BloomHorizontalParams\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-bloom-vertical',
    wgsl: '// fixture marker: BloomVerticalParams\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-bloom-composite',
    wgsl: '// fixture marker: BloomCompositeParams\n',
    glsl: '',
    bindings: '[]',
  },
];

/**
 * Standard PBR manifest rows for rhi-null renderer fixtures. Every device
 * prewarms both transmission axes: a low sampled-texture limit selects the
 * shared-slot variant instead of dropping transmission.
 */
export function standardPbrFixtureVariants(composedWgsl: string, includeWaterWaves = false) {
  const variants = [];
  for (const cluster of [false, true]) {
    for (const storage of [false, true]) {
      for (const vertexColor of [false, true]) {
        for (const transmission of [false, true]) {
          for (const waterWaves of includeWaterWaves ? [false, true] : [undefined]) {
            for (const waterInfoRgba16 of includeWaterWaves ? [false, true] : [undefined]) {
              const defines = {
                CLUSTER_FORWARD_AVAILABLE: cluster,
                STORAGE_BUFFER_AVAILABLE: storage,
                TRANSMISSION_AVAILABLE: transmission,
                VERTEX_COLOR_AVAILABLE: vertexColor,
                ...(waterWaves === undefined ? {} : { WATER_WAVES_AVAILABLE: waterWaves }),
                ...(waterInfoRgba16 === undefined ? {} : { WATER_INFO_RGBA16: waterInfoRgba16 }),
              };
              const sortedDefines = Object.entries(defines).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              );
              const definesKey = sortedDefines.every(([, value]) => value)
                ? ''
                : sortedDefines.map(([key, value]) => `${key}=${value}`).join('+');
              variants.push({
                definesKey,
                defines,
                composedWgsl,
                hash: 'cafe1234',
                sourceDigest: 'a'.repeat(64),
                compilerProfile: fixtureCompilerProfile,
                receipt: createStandardPbrArtifactReceipt(false, vertexColor),
                reflection: STANDARD_CLUSTER_TEST_REFLECTION,
              });
            }
          }
        }
      }
    }
  }
  return variants;
}

/** Minimal Standard PBR manifest row for fixtures that build their own manifest. */
export function standardPbrManifestRow(composedWgsl: string) {
  return {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'fixture://forgeax/default-standard-pbr.wgsl',
    composedWgsl,
    paramSchema: JSON.stringify(DEFAULT_STANDARD_PBR_PARAM_SCHEMA),
    receipt: createStandardPbrArtifactReceipt(),
    variants: standardPbrFixtureVariants(composedWgsl),
  };
}

const standardPbrVariants = standardPbrFixtureVariants(pbrWgsl);

const shadowCasterVariants = (() => {
  const variants = [];
  for (const storage of [false, true]) {
    for (const skinningDisabled of [false, true]) {
      for (const gpuDriven of [false, true]) {
        for (const explicit of [false, true]) {
          for (const alphaMask of [false, true]) {
            if (!storage && gpuDriven) continue;
            const defines: Record<string, boolean> = {
              ALPHA_MASK: alphaMask,
              GPU_DRIVEN_SCENE_INDEX_AVAILABLE: gpuDriven,
              GPU_DRIVEN_SCENE_INDEX_EXPLICIT: explicit,
              SKINNING_DISABLED: skinningDisabled,
              STORAGE_BUFFER_AVAILABLE: storage,
            };
            const sortedDefines = Object.entries(defines).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            );
            const definesKey = sortedDefines.every(([, value]) => value)
              ? ''
              : sortedDefines.map(([key, value]) => `${key}=${value}`).join('+');
            variants.push({
              definesKey,
              defines,
              composedWgsl: shadowCasterWgsl,
              receipt: createStandardPbrArtifactReceipt(!skinningDisabled, false),
            });
          }
        }
      }
    }
  }
  return variants;
})();

const baseMaterialShaders = [
  {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'fixture://forgeax/default-standard-pbr.wgsl',
    composedWgsl: pbrWgsl,
    paramSchema: JSON.stringify(DEFAULT_STANDARD_PBR_PARAM_SCHEMA),
    receipt: createStandardPbrArtifactReceipt(),
    variants: standardPbrVariants,
    uvSetCount: 8,
  },
  {
    identifier: 'forgeax::default-unlit',
    sourcePath: 'fixture://forgeax/default-unlit.wgsl',
    composedWgsl: unlitWgsl,
    paramSchema: JSON.stringify(DEFAULT_UNLIT_PARAM_SCHEMA),
    variants: [],
    uvSetCount: 1,
  },
  {
    identifier: 'forgeax::default-shadow-caster',
    sourcePath: 'fixture://forgeax/default-shadow-caster.wgsl',
    composedWgsl: shadowCasterWgsl,
    receipt: createStandardPbrArtifactReceipt(),
    paramSchema: JSON.stringify([]),
    variants: shadowCasterVariants,
  },
] as const;

// Renderer fixtures publish the real selected Engine utility programs.
type EngineFixtureInputs = Awaited<ReturnType<typeof loadEngineShaderEntries>>;
async function nativeUtilityFixture(
  shaders: readonly EngineFixtureInputs['standardOutputV2'][],
  imports: EngineFixtureInputs['imports'],
) {
  const entries: FixtureEntry[] = [];
  const materialShaders = [];
  for (const shader of shaders) {
    const reachable = reachableShaderImportIds(shader.source, imports, shader.defines ?? {});
    const compiled = await compileShader(shader.source, {
      id: shader.id,
      imports: Object.fromEntries(Object.entries(imports).filter(([id]) => reachable.has(id))),
      ...(shader.defines === undefined ? {} : { defines: shader.defines }),
    });
    if (!compiled.ok)
      throw new Error(
        `Unable to compile Engine shader fixture '${shader.id}': ${JSON.stringify(compiled.error)}`,
      );
    if (shader.reservedIdentifier === undefined)
      throw new Error(`Engine shader fixture '${shader.id}' has no reserved identifier`);
    const { manifestEntry } = compiled.value;
    entries.push({
      hash: manifestEntry.hash,
      wgsl: manifestEntry.wgsl,
      glsl: '',
      bindings:
        typeof manifestEntry.bindings === 'string'
          ? manifestEntry.bindings
          : JSON.stringify(manifestEntry.bindings),
      ...(shader.programContract === undefined ? {} : { programContract: shader.programContract }),
    });
    materialShaders.push({
      identifier: shader.reservedIdentifier,
      sourcePath: shader.id,
      hash: manifestEntry.hash,
      composedWgsl: manifestEntry.wgsl,
      paramSchema: '[]',
      variants: [],
    });
  }
  return { entries, materialShaders };
}
const fixtureInputs = await loadEngineShaderEntries();
export const waterInfoShaderFixture = await nativeUtilityFixture(
  waterInfoRasterEngineEntries(fixtureInputs),
  fixtureInputs.imports,
);
export const nativeOutputShaderFixture = await nativeUtilityFixture(
  [fixtureInputs.standardOutputV2],
  fixtureInputs.imports,
);
const deferredDefines = [false, true].flatMap((cluster) =>
  [false, true].flatMap((screenAo) =>
    [false, true].flatMap((extended) =>
      [false, true].map((projector) => ({
        CLUSTER_FORWARD_AVAILABLE: cluster,
        DEFERRED_SCREEN_AO_AVAILABLE: screenAo,
        EXTENDED_LIGHTING_AVAILABLE: extended,
        PROJECTOR_AVAILABLE: projector,
      })),
    ),
  ),
);
const nativeDeferredShaderFixture = await nativeUtilityFixture(
  deferredDefines.map((defines) => ({
    ...fixtureInputs.standardDeferred,
    defines: { ...fixtureInputs.standardDeferred.defines, ...defines },
  })),
  fixtureInputs.imports,
);
const deferredBase = nativeDeferredShaderFixture.materialShaders.at(0);
if (deferredBase === undefined) throw new Error('Missing native Deferred fixture');
const deferredMaterial = {
  ...deferredBase,
  variants: nativeDeferredShaderFixture.materialShaders.map((shader, index) => {
    const defines = deferredDefines[index];
    if (defines === undefined) throw new Error('Missing Deferred fixture selection');
    return {
      ...shader,
      defines,
      definesKey: Object.values(defines).every(Boolean)
        ? ''
        : Object.entries(defines)
            .map(([key, value]) => `${key}=${value}`)
            .join('+'),
    };
  }),
};

const entries = [
  ...baseEntries,
  ...waterInfoShaderFixture.entries,
  ...nativeOutputShaderFixture.entries,
  ...nativeDeferredShaderFixture.entries,
];
const materialShaders = [
  ...baseMaterialShaders,
  ...waterInfoShaderFixture.materialShaders,
  ...nativeOutputShaderFixture.materialShaders,
  deferredMaterial,
];

/**
 * Build the smallest manifest that exercises renderer post-process assembly.
 * The fixture is intentionally self-contained so package tests do not depend
 * on a generated app dist directory or on the caller's working directory.
 */
export function renderLifecycleManifestUrl(
  options: { readonly waterWaves?: boolean } = {},
): string {
  return `data:application/json,${encodeURIComponent(renderLifecycleManifestJson(options))}`;
}

export function renderLifecycleManifestJson(
  options: { readonly waterWaves?: boolean } = {},
): string {
  const fixtureMaterials = options.waterWaves
    ? materialShaders.map((shader) =>
        shader.identifier === 'forgeax::default-standard-pbr'
          ? { ...shader, variants: standardPbrFixtureVariants(shader.composedWgsl, true) }
          : shader,
      )
    : materialShaders;
  return JSON.stringify({ entries, materialShaders: fixtureMaterials });
}
