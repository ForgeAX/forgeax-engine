import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
} from '@forgeax/engine-shader';

type FixtureEntry = {
  readonly hash: string;
  readonly wgsl: string;
  readonly glsl: string;
  readonly bindings: string;
};

const pbrWgsl = '// fixture marker: f_schlick\n';
const unlitWgsl = '// fixture marker: default-unlit\n';
const shadowCasterWgsl = '// fixture marker: shadow-caster\n';

const entries: readonly FixtureEntry[] = [
  { hash: 'fixture-pbr', wgsl: pbrWgsl, glsl: '', bindings: '[]' },
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
    hash: 'fixture-bloom-downsample',
    wgsl: '// fixture marker: BloomDownsampleParams\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-bloom-upsample',
    wgsl: '// fixture marker: BloomUpsampleParams\n',
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
export function standardPbrFixtureVariants(composedWgsl: string) {
  const variants = [];
  for (const cluster of [false, true]) {
    for (const storage of [false, true]) {
      for (const vertexColor of [false, true]) {
        for (const transmission of [false, true]) {
          const defines = {
            CLUSTER_FORWARD_AVAILABLE: cluster,
            STORAGE_BUFFER_AVAILABLE: storage,
            TRANSMISSION_AVAILABLE: transmission,
            VERTEX_COLOR_AVAILABLE: vertexColor,
          };
          const sortedDefines = Object.entries(defines).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          );
          const definesKey = sortedDefines.every(([, value]) => value)
            ? ''
            : sortedDefines.map(([key, value]) => `${key}=${value}`).join('+');
          variants.push({ definesKey, defines, composedWgsl });
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
            variants.push({ definesKey, defines, composedWgsl: shadowCasterWgsl });
          }
        }
      }
    }
  }
  return variants;
})();

const materialShaders = [
  {
    identifier: 'forgeax::engine-standard-deferred-lighting',
    sourcePath: 'fixture://forgeax/standard-deferred-lighting.wgsl',
    composedWgsl: '// fixture marker: standard deferred',
    paramSchema: '[]',
    variants: [false, true].flatMap((cluster) =>
      [false, true].flatMap((extended) =>
        [false, true].flatMap((projector) =>
          [false, true].map((pcss) => ({
            definesKey:
              cluster && extended && projector && pcss
                ? ''
                : `CLUSTER_FORWARD_AVAILABLE=${cluster}+DIRECTIONAL_PCSS_AVAILABLE=${pcss}+EXTENDED_LIGHTING_AVAILABLE=${extended}+PROJECTOR_AVAILABLE=${projector}`,
            defines: {
              CLUSTER_FORWARD_AVAILABLE: cluster,
              EXTENDED_LIGHTING_AVAILABLE: extended,
              PROJECTOR_AVAILABLE: projector,
              DIRECTIONAL_PCSS_AVAILABLE: pcss,
            },
            composedWgsl: '// fixture marker: standard deferred',
          })),
        ),
      ),
    ),
  },
  {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'fixture://forgeax/default-standard-pbr.wgsl',
    composedWgsl: pbrWgsl,
    paramSchema: JSON.stringify(DEFAULT_STANDARD_PBR_PARAM_SCHEMA),
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
    paramSchema: JSON.stringify([]),
    variants: shadowCasterVariants,
  },
] as const;

/**
 * Build the smallest manifest that exercises renderer post-process assembly.
 * The fixture is intentionally self-contained so package tests do not depend
 * on a generated app dist directory or on the caller's working directory.
 */
export function renderLifecycleManifestUrl(): string {
  return `data:application/json,${encodeURIComponent(
    JSON.stringify({ entries, materialShaders }),
  )}`;
}
