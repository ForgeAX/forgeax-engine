import { DAWN_COMPACT_TEST_FILES } from './dawn-compact-roster.mjs';
import { DAWN_HEAVY_TEST_PARTITIONS } from './dawn-heavy-roster.mjs';

export const DIRECT_LIGHT_DAWN_TEST_FILE =
  'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.dawn.test.ts';
export const VFX_DEPTH_DAWN_TEST_FILE =
  'packages/runtime/src/__tests__/vfx-depth-material.dawn.test.ts';

// Every file excluded from the ordinary Dawn project has one execution owner.
// Vitest configuration and local/PR/nightly execution derive from these groups.
export const DAWN_ISOLATED_GROUPS = [
  {
    id: 'surface-pipelines',
    files: [
      'packages/runtime/src/__tests__/surface-standard-pipeline.dawn.test.ts',
      'packages/runtime/src/__tests__/standard-deferred-parity.dawn.test.ts',
      'packages/runtime/src/__tests__/clipping-planes.dawn.test.ts',
    ],
  },
  {
    id: 'renderer',
    files: [
      'packages/runtime/src/__tests__/point-light-shadow.dawn.test.ts',
      'packages/runtime/src/__tests__/dawn/instances-uniform-fallback.dawn.test.ts',
    ],
  },
  {
    id: 'feature-depth',
    files: ['packages/runtime/src/__tests__/feature-depth-material.dawn.test.ts'],
  },
  { id: 'vfx-depth', files: [VFX_DEPTH_DAWN_TEST_FILE] },
  {
    id: 'nested-discard',
    // Complete multi-scene pixel coverage needs an independent native lifetime.
    files: ['packages/runtime/src/__tests__/dawn/nested-discard-pixels.dawn.test.ts'],
  },
  {
    // This capture/replay owner lost its native worker inside ordinary-4.
    // Keep the complete source-texture proof in one fresh native process.
    id: 'rect-source',
    files: ['packages/runtime/src/__tests__/rect-light-source-texture.dawn.test.ts'],
  },
  {
    id: 'transmission',
    files: ['packages/render/src/transmission/__tests__/standard-transmission.dawn.test.ts'],
  },
  {
    id: 'timing-lifecycle',
    files: [
      'packages/render/bench/gpu-pass-timing/__tests__/gpu-pass-timing-lifecycle.dawn.test.ts',
    ],
  },
  {
    id: 'gpu-timing',
    files: ['packages/render/bench/gpu-pass-timing/__tests__/gpu-pass-timing.dawn.test.ts'],
  },
  ...DAWN_HEAVY_TEST_PARTITIONS.map((files, index) => ({
    id: `heavy-${index + 1}`,
    // Recovery sequences retain their module state within one test.
    files,
    isolate: false,
  })),
  {
    id: 'shadow-fields',
    files: ['packages/runtime/src/__tests__/shadow-fields-observable.dawn.test.ts'],
  },
  {
    id: 'specular-aa',
    files: ['packages/runtime/src/__tests__/specular-aa.dawn.test.ts'],
  },
  // Global-illumination owners grow together; complete file groups keep them
  // off the discovered ordinary shards and leave room for later GI files.
  {
    id: 'gi-1',
    files: [
      'packages/runtime/src/__tests__/renderer-probe-global.dawn.test.ts',
      'packages/render/src/__tests__/raytracing/raster-source.dawn.test.ts',
    ],
  },
  {
    id: 'gi-2',
    files: [
      'packages/runtime/src/__tests__/renderer-reflections.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-probe-placement.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-radiance-cache.dawn.test.ts',
      'packages/render/src/__tests__/raytracing/path-buffer.dawn.test.ts',
      'packages/render/src/__tests__/raytracing/diffuse-gi.dawn.test.ts',
    ],
  },
  {
    id: 'gi-3',
    files: [
      'packages/runtime/src/__tests__/renderer-irradiance-field-edit.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-gi-coverage.dawn.test.ts',
    ],
  },
  {
    id: 'gi-4',
    files: [
      'packages/runtime/src/__tests__/renderer-irradiance-field-add.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-irradiance-field-clipmap.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-reflection-denoise.dawn.test.ts',
    ],
  },
  {
    id: 'gi-5',
    files: [
      'packages/runtime/src/__tests__/renderer-irradiance-field-residency.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-irradiance-field-multiview.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-baked-field.dawn.test.ts',
      'packages/render/src/__tests__/raytracing/irradiance-bake.dawn.test.ts',
    ],
  },
  {
    id: 'gi-6',
    files: ['packages/runtime/src/__tests__/renderer-irradiance-field.dawn.test.ts'],
  },
  {
    id: 'screen-probe',
    files: ['packages/runtime/src/__tests__/renderer-screen-probe.dawn.test.ts'],
  },
];

export const DAWN_ISOLATED_TEST_FILES = DAWN_ISOLATED_GROUPS.flatMap(({ files }) => files);

// Complete native owners share four lanes; ordinary files fill the remaining
// time using the latest measured costs. Each process keeps its native lifetime.
export const DAWN_GATE_SHARDS = Object.freeze([
  Object.freeze([
    'ordinary-1',
    'surface-pipelines',
    'gi-1',
    'direct-light',
    'gi-6',
    'heavy-1',
    'renderer',
    'screen-probe',
  ]),
  Object.freeze([
    'ordinary-2',
    'gi-2',
    'compact-2',
    'vfx-depth',
    'transmission',
    'heavy-3',
    'timing-lifecycle',
  ]),
  Object.freeze(['ordinary-3', 'feature-depth', 'gi-3', 'compact-3', 'heavy-2', 'heavy-4']),
  Object.freeze([
    'ordinary-4',
    'rect-source',
    'shadow-fields',
    'compact-1',
    'nested-discard',
    'specular-aa',
    'gpu-timing',
    'gi-4',
    'gi-5',
  ]),
]);

export const DAWN_GATE_GROUPS = [
  ...DAWN_GATE_SHARDS.map((_, index) => ({
    id: `ordinary-${index + 1}`,
    files: [],
    env: {},
    retryMode: 'vitest-dawn',
    vitestShard: `${index + 1}/${DAWN_GATE_SHARDS.length}`,
  })),
  ...Array.from({ length: 3 }, (_, partition) => ({
    id: `compact-${partition + 1}`,
    files: DAWN_COMPACT_TEST_FILES.filter((_file, index) => index % 3 === partition),
    env: { FORGEAX_DAWN_COMPACT: '1' },
  })),
  ...DAWN_ISOLATED_GROUPS.map((group) => ({ ...group, env: { FORGEAX_DAWN_ISOLATED: '1' } })),
  { id: 'direct-light', files: [DIRECT_LIGHT_DAWN_TEST_FILE], env: {} },
];
