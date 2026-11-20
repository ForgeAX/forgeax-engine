export const DAWN_VITEST_CONFIG = 'config/vitest.dawn.config.ts';

import { DAWN_COMPACT_TEST_FILES } from './dawn-compact-roster.mjs';
import { DAWN_HEAVY_TEST_PARTITIONS } from './dawn-heavy-roster.mjs';

export const DIRECT_LIGHT_DAWN_TEST_FILE =
  'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.dawn.test.ts';
export const VFX_DEPTH_DAWN_TEST_FILE =
  'packages/runtime/src/__tests__/vfx-depth-material.dawn.test.ts';

// Modeling's full example captures remain local authoring tools. Engine CI
// uses the portable model-render fixtures and the 60-frame Modeling Show.
const modelingAuthoringCaptures = [
  'packages/modeling/examples/mech-gt/__tests__/s6.case.dawn.test.ts',
  'packages/modeling/examples/mech-gt/__tests__/s6b-paint.case.dawn.test.ts',
];

export function dawnAuthoringCapturesOutsideCi(environment = process.env) {
  return environment.FORGEAX_DAWN_OMIT_AUTHORING_CAPTURES === '1' ? modelingAuthoringCaptures : [];
}

// Every file excluded from the ordinary Dawn project has one execution owner.
// Vitest configuration and local/PR/nightly execution derive from these groups.
export const DAWN_ISOLATED_GROUPS = [
  {
    id: 'shadow-quality',
    files: [
      'packages/runtime/src/__tests__/cube-plane-shadow-contact.dawn.test.ts',
      'packages/runtime/src/__tests__/curved-shadow-receiver.dawn.test.ts',
    ],
  },
  {
    id: 'renderer',
    nativeProcessSlots: 1,
    files: [
      'packages/runtime/src/__tests__/point-light-shadow.dawn.test.ts',
      'packages/runtime/src/__tests__/dawn/instances-uniform-fallback.dawn.test.ts',
    ],
  },
  {
    id: 'feature-depth',
    nativeProcessSlots: 1,
    files: ['packages/runtime/src/__tests__/feature-depth-material.dawn.test.ts'],
  },
  {
    // This capture/replay file ran to completion in a fresh fork but lost
    // its worker beside ordinary Dawn files under the same memory limit.
    id: 'alpha-hash',
    nativeProcessSlots: 2,
    // The complete historical file cost is 186.15 seconds. Include admission
    // headroom so every retained cohort fits the existing placement bounds.
    placementReserveSeconds: 200,
    files: ['packages/runtime/src/__tests__/alpha-hash.dawn.test.ts'],
  },
  {
    // The full Three Surface cook and replay needs the native lane after
    // run 44387085437 exhausted all three case budgets in ordinary-2.
    id: 'three-surface-expression',
    nativeProcessSlots: 2,
    placementReserveSeconds: 420,
    files: ['packages/three/src/__tests__/surface-expression.dawn.test.ts'],
  },
  {
    // The complete S6 capture journey owns a fresh native parent process;
    // keep both case tests and their original budgets outside ordinary backfill.
    id: 'modeling-s6',
    nativeProcessSlots: 1,
    // Run 429298 measured a 443-second full-profile capture. Reserve ten
    // minutes so it still starts before ordinary backfill with time for drift.
    placementReserveSeconds: 600,
    files: ['packages/modeling/examples/mech-gt/__tests__/s6.case.dawn.test.ts'],
  },
  {
    id: 'modeling-show',
    nativeProcessSlots: 1,
    // Run 41597394498 reached this full capture journey at minute 36. The
    // retained complete-owner maximum is 187 seconds; preserve ten minutes of
    // startup/capture headroom without starving ordinary work on other lanes.
    placementReserveSeconds: 600,
    // Run 41306958512 missed the original sky-preparation deadline inside
    // ordinary-3. Keep all cues, pixel controls and sixty completed frames
    // in one fresh native lifetime; the scene and readiness budget stay fixed.
    files: ['apps/modeling-show/__tests__/show.dawn.test.ts'],
  },
  {
    id: 'surface-pipelines',
    // The planar fixtures cook a cold authored Pack before native readback.
    // The paired one-compiler allocation exhausted both original case limits.
    nativeProcessSlots: 2,
    // Run 42325043736 completed ordinary-4 after 2,058 seconds, leaving
    // this complete owner too little of the unchanged 40-minute step.
    // Reserve the existing complete-owner maximum plus both newly serial
    // planar files before ordinary backfill; case/frame/step bounds remain.
    placementReserveSeconds: 840,
    files: [
      'packages/runtime/src/__tests__/surface-standard-pipeline.dawn.test.ts',
      'packages/runtime/src/__tests__/standard-deferred-parity.dawn.test.ts',
      'packages/runtime/src/__tests__/clipping-planes.dawn.test.ts',
      // Full planar capture/replay crossed its unchanged 180-second case
      // bound in run 43943068121's two-worker ordinary lane. Reuse this
      // serial Surface owner for both complete planar carriers.
      'packages/runtime/src/__tests__/planar-reflection.dawn.test.ts',
      'packages/runtime/src/__tests__/standard-planar-reflection.dawn.test.ts',
      // Same cold Surface Pack and renderer path as the planar carriers.
      'packages/runtime/src/__tests__/cooked-transmission-low-limit.dawn.test.ts',
      'packages/render/src/__tests__/standard-lean-inputs.dawn.test.ts',
    ],
  },
  {
    id: 'vfx-depth',
    nativeProcessSlots: 1,
    // Runs 44113035424 and 44136739089 interrupted this complete owner.
    // Retain its historical maximum and ten-minute admission headroom.
    placementReserveSeconds: 600,
    files: [VFX_DEPTH_DAWN_TEST_FILE],
  },
  {
    id: 'nested-discard',
    nativeProcessSlots: 1,
    // Complete multi-scene pixel coverage needs an independent native lifetime.
    files: ['packages/runtime/src/__tests__/dawn/nested-discard-pixels.dawn.test.ts'],
  },
  {
    // This capture/replay owner lost its native worker inside ordinary-4.
    // Keep the complete source-texture proof in one fresh native process.
    id: 'rect-source',
    nativeProcessSlots: 1,
    files: ['packages/runtime/src/__tests__/rect-light-source-texture.dawn.test.ts'],
  },
  {
    id: 'transmission',
    nativeProcessSlots: 1,
    // Run 43718751716 reached this complete owner after minute 34 and lost
    // its final partition at the unchanged 40-minute gate. Start its retained
    // complete-owner forecast before ordinary backfill; no deadline changes.
    placementReserveSeconds: 294.878,
    files: ['packages/render/src/transmission/__tests__/standard-transmission.dawn.test.ts'],
  },
  ...DAWN_HEAVY_TEST_PARTITIONS.map((files, index) => ({
    id: `heavy-${index + 1}`,
    nativeProcessSlots: 1,
    // Recovery sequences retain their module state within one test.
    files,
    isolate: false,
  })),
  {
    id: 'shadow-fields',
    nativeProcessSlots: 1,
    files: ['packages/runtime/src/__tests__/shadow-fields-observable.dawn.test.ts'],
  },
  {
    id: 'specular-aa',
    nativeProcessSlots: 1,
    files: ['packages/runtime/src/__tests__/specular-aa.dawn.test.ts'],
  },
  // Global-illumination owners grow together; complete file groups keep them
  // off the discovered ordinary shards and leave room for later GI files.
  {
    id: 'gi-1',
    nativeProcessSlots: 1,
    // Run 44152394166 stopped after its first file. Reserve the larger
    // complete historical owner, never the partial file duration.
    placementReserveSeconds: 241.472,
    files: [
      'packages/runtime/src/__tests__/renderer-probe-global.dawn.test.ts',
      'packages/render/src/__tests__/raytracing/raster-source.dawn.test.ts',
    ],
  },
  {
    id: 'path-tracer',
    // The cold shared-material cook needs the full compiler allocation before
    // the first native replay. Keep the complete file and every case deadline.
    nativeProcessSlots: 2,
    placementReserveSeconds: 150,
    files: ['packages/render/src/__tests__/raytracing/path-tracer.dawn.test.ts'],
  },
  {
    id: 'gi-2',
    // The path-buffer fixture cooks the complete ray-material input set and
    // replays both sources. Keep the full compiler allocation for this owner.
    nativeProcessSlots: 2,
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
    nativeProcessSlots: 1,
    files: [
      'packages/runtime/src/__tests__/renderer-irradiance-field-edit.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-gi-coverage.dawn.test.ts',
    ],
  },
  {
    id: 'gi-4',
    nativeProcessSlots: 1,
    files: [
      'packages/runtime/src/__tests__/renderer-irradiance-field-add.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-irradiance-field-clipmap.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-reflection-denoise.dawn.test.ts',
    ],
  },
  {
    id: 'gi-5',
    nativeProcessSlots: 1,
    // Run 42122803571 reached this complete journey at minute 37 and
    // interrupted it at the unchanged step deadline. Reserve ten minutes
    // and admit it before ordinary backfill; the test budgets stay fixed.
    placementReserveSeconds: 600,
    files: [
      'packages/runtime/src/__tests__/renderer-irradiance-field-residency.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-irradiance-field-multiview.dawn.test.ts',
      'packages/runtime/src/__tests__/renderer-baked-field.dawn.test.ts',
      'packages/render/src/__tests__/raytracing/irradiance-bake.dawn.test.ts',
    ],
  },
  {
    id: 'gi-6',
    nativeProcessSlots: 1,
    files: ['packages/runtime/src/__tests__/renderer-irradiance-field.dawn.test.ts'],
  },
  {
    id: 'screen-probe',
    nativeProcessSlots: 1,
    // The same run never reached this owner; retain its complete maximum.
    placementReserveSeconds: 190.617,
    files: ['packages/runtime/src/__tests__/renderer-screen-probe.dawn.test.ts'],
  },
];

export const DAWN_ISOLATED_TEST_FILES = DAWN_ISOLATED_GROUPS.flatMap(({ files }) => files);

// Complete native owners share four lanes; ordinary files fill the remaining
// time using the latest measured costs. Each process keeps its native lifetime.
// Independent long capture journeys occupy separate lanes; one slow runner
// must not amplify both Modeling captures before the same ordinary backfill.
// Run 44039100905 exhausted lanes one and four. Match the current core costs
// and spread complete native owners and reserved headroom across these lanes;
// one-pass backfill retains every file without historical layout constraints.
export const DAWN_GATE_SHARDS = Object.freeze([
  Object.freeze([
    'ordinary-1',
    'direct-light',
    'gi-1',
    'heavy-4',
    'modeling-s6',
    'path-tracer',
    'rect-source',
    'three-surface-expression',
  ]),
  Object.freeze([
    'ordinary-2',
    'compact-2',
    'gi-4',
    'gi-6',
    'heavy-2',
    'specular-aa',
    'shadow-quality',
    'surface-pipelines',
    'transmission',
  ]),
  Object.freeze([
    'ordinary-3',
    'alpha-hash',
    'compact-3',
    'feature-depth',
    'gi-2',
    'heavy-1',
    'heavy-3',
    'modeling-show',
    'screen-probe',
  ]),
  Object.freeze([
    'ordinary-4',
    'compact-1',
    'gi-3',
    'gi-5',
    'nested-discard',
    'shadow-fields',
    'renderer',
    'vfx-depth',
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
    nativeProcessSlots: 1,
    files: DAWN_COMPACT_TEST_FILES.filter((_file, index) => index % 3 === partition),
    env: { FORGEAX_DAWN_COMPACT: '1' },
  })),
  ...DAWN_ISOLATED_GROUPS.map((group) => ({ ...group, env: { FORGEAX_DAWN_ISOLATED: '1' } })),
  {
    id: 'direct-light',
    nativeProcessSlots: 1,
    // Run 42388664877 reached this complete journey at minute 39. Admit it
    // before ordinary backfill with its retained complete-owner placement forecast;
    // retain every phase and its original native process/test deadlines.
    placementReserveSeconds: 219.011,
    files: [DIRECT_LIGHT_DAWN_TEST_FILE],
    env: {},
  },
];

// These files retain one measured logical owner while bounding native lifetimes.
// The anchor's historical file cost covers the complete eighteen-test family.
export const DAWN_ORDINARY_FILE_FAMILIES = [
  {
    anchor: 'packages/three/src/__tests__/node-inputs.dawn.test.ts',
    children: [
      'packages/three/src/__tests__/node-optical-inputs.dawn.test.ts',
      'packages/three/src/__tests__/node-primitive-inputs.dawn.test.ts',
    ],
    additionalProcessReserveSeconds: 40,
  },
];
