import {
  type BindGroup,
  type BindGroupEntry,
  type BindGroupLayout,
  type Buffer,
  type RhiComputePassEncoder,
  type RhiDevice,
  RhiError,
  type Sampler,
  type ShaderModule,
  type TextureView,
  type Tlas,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { StandardScreenProbes } from '../pipeline/standard-profile';
import { GlobalSdfQueryStatus } from './global-sdf-query';
import {
  type Binding,
  createComputeLayout,
  createIrradianceFieldSampleLayout,
  type IrradianceFieldKernelInput,
  kernelResource,
  linearDispatch,
} from './irradiance-field';
import { prepareComputePipeline } from './prepare-pipeline';
import { SCREEN_PROBE_DF_RECEIVER_WGSL } from './screen-probe-df-receiver';
import { SCREEN_PROBE_ENDPOINT_ROSTER, SCREEN_PROBE_ENDPOINT_WGSL } from './screen-probe-endpoint';
import {
  SCREEN_PROBE_HIT_MOVING,
  SCREEN_PROBE_REACHED_CACHE,
  ScreenProbeRayStatus,
} from './screen-probe-plan';
import { SCREEN_PROBE_CONTACT_WGSL } from './screen-probe-receiver';
import { SCREEN_PROBE_RECEIVER_REQUEST_WGSL } from './screen-probe-records';
import {
  SCREEN_PROBE_ROOT_RAY_ROSTER,
  SCREEN_PROBE_WORLD_RECORDS_WGSL,
  type ScreenProbeRootStage,
} from './screen-probe-root-kernels';
import {
  type MeshDfApproxPolicy,
  WORLD_CARD_RADIANCE_WGSL,
  WORLD_TRAVERSAL_ROSTER,
  WorldCardSampleStatus,
  type WorldTraversal,
  worldRayQueryMotionTraversalWgsl,
  worldTraversalWgsl,
} from './world-traversal';

/** Named group-0 resources of `forgeax_ray::screen_probe`; the binding index is the SSOT in WGSL. */
export const SCREEN_PROBE_BINDINGS = {
  frame: [0, 'uniform'],
  view: [1, 'uniform'],
  depth: [2, 'depth'],
  normal: [3, 'uint'],
  depthPyramid: [4, 'float'],
  scene: [5, 'float'],
  probes: [6, 'storage'],
  probesIn: [7, 'read'],
  adaptiveCount: [8, 'storage'],
  adaptiveCountIn: [9, 'read'],
  tileAdaptive: [10, 'storage'],
  tileAdaptiveIn: [11, 'read'],
  rays: [12, 'storage'],
  raysIn: [13, 'read'],
  previousScene: [14, 'read'],
  previousSceneOut: [15, 'storage'],
  radianceIn: [16, 'read'],
  radianceOut: [17, 'storage'],
  probeRadiance: [19, 'read'],
  integratedOut: [20, 'storage'],
  integrated: [21, 'read'],
  historyIn: [22, 'read'],
  historyOut: [23, 'storage'],
  metaIn: [24, 'read'],
  metaOut: [25, 'storage'],
  probeHistoryIn: [26, 'read'],
  probeHistoryOut: [27, 'storage'],
  fallbackList: [28, 'storage'],
  fallbackListIn: [29, 'read'],
  traceDispatch: [30, 'storage'],
  traceCells: [31, 'storage'],
  traceCellsIn: [32, 'read'],
  previousScreenDepth: [33, 'read'],
  previousScreenDepthOut: [34, 'storage'],
  screenMotion: [35, 'float'],
  atlasOut: [36, 'storage-rgba16float'],
  atlasIn: [37, 'filtered-float'],
  shortRangeAoOut: [39, 'storage'],
  shortRangeAoIn: [40, 'read'],
  scatterNoise: [41, 'float'],
  directionalReflection: [42, 'float'],
  albedo: [43, 'uint'],
  motionWithDepth: [44, 'uint'],
  receiverMotionOut: [45, 'storage'],
  receiverMotionIn: [46, 'read'],
  probeMovingOut: [47, 'storage'],
  probeMovingIn: [48, 'read'],
  pixelMovingOut: [49, 'storage'],
  pixelMovingIn: [50, 'read'],
} as const satisfies Record<string, readonly [number, Binding]>;
export type ScreenProbeSlot = keyof typeof SCREEN_PROBE_BINDINGS;

/** Published entry -> its binding roster and dispatch shape. */
export const SCREEN_PROBE_STAGES = {
  placeUniformProbes: {
    slots: ['frame', 'view', 'depth', 'normal', 'probes', 'adaptiveCount', 'tileAdaptive'],
    dispatch: 'threads',
  },
  placeAdaptiveProbes: {
    slots: ['frame', 'view', 'depth', 'normal', 'probes', 'adaptiveCount', 'tileAdaptive'],
    dispatch: 'threads',
  },
  compactAdaptiveProbes: {
    slots: ['frame', 'view', 'depth', 'normal', 'probes', 'adaptiveCount', 'tileAdaptive'],
    dispatch: 'threads',
  },
  generateProbeRays: {
    slots: ['frame', 'probesIn', 'adaptiveCountIn', 'rays'],
    dispatch: 'probes',
  },
  traceScreenProbes: {
    slots: [
      'frame',
      'view',
      'depth',
      'normal',
      'depthPyramid',
      'probesIn',
      'rays',
      'previousScene',
    ],
    dispatch: 'threads',
  },
  resolveProbeRays: {
    slots: ['frame', 'probesIn', 'adaptiveCountIn', 'raysIn', 'radianceOut'],
    dispatch: 'probes',
  },
  temporalProbeRadiance: {
    slots: ['frame', 'probesIn', 'radianceIn', 'radianceOut', 'probeHistoryIn', 'probeHistoryOut'],
    dispatch: 'probes',
  },
  filterProbeRadiance: {
    slots: ['frame', 'view', 'probesIn', 'adaptiveCountIn', 'radianceIn', 'radianceOut'],
    dispatch: 'probes',
  },
  integrateScreenProbes: {
    slots: [
      'frame',
      'view',
      'depth',
      'normal',
      'probesIn',
      'adaptiveCountIn',
      'tileAdaptiveIn',
      'probeRadiance',
      'integratedOut',
    ],
    dispatch: 'threads',
  },
  temporalScreenProbes: {
    slots: [
      'frame',
      'view',
      'depth',
      'normal',
      'integrated',
      'historyIn',
      'historyOut',
      'metaIn',
      'metaOut',
    ],
    dispatch: 'threads',
  },
  copySceneHistory: {
    slots: ['frame', 'scene', 'previousSceneOut'],
    dispatch: 'threads',
  },
  copyDiffuseSceneHistory: {
    slots: ['frame', 'scene', 'directionalReflection', 'previousSceneOut'],
    dispatch: 'threads',
  },
} as const satisfies Record<
  string,
  { readonly slots: readonly ScreenProbeSlot[]; readonly dispatch: 'threads' | 'probes' }
>;
export type ScreenProbeStage = keyof typeof SCREEN_PROBE_STAGES;

const SCREEN_PROBE_CURRENT_AO_SLOTS = [
  'frame',
  'view',
  'depth',
  'normal',
  'shortRangeAoIn',
  'integrated',
  'integratedOut',
  'albedo',
] as const;
const SCREEN_PROBE_RETAINED_AO_SLOTS = [
  'frame',
  'integrated',
  'integratedOut',
  'metaIn',
  'albedo',
] as const;

export const SCREEN_PROBE_TRACE_STAGES = {
  prepareScreenProbeReceiverMotion: {
    slots: ['frame', 'view', 'probesIn', 'adaptiveCountIn', 'motionWithDepth', 'receiverMotionOut'],
    field: false,
  },
  computeScreenProbeShortRangeAo: {
    slots: ['frame', 'view', 'depth', 'normal', 'depthPyramid', 'shortRangeAoOut', 'scatterNoise'],
    field: false,
  },
  applyScreenProbeShortRangeAo: { slots: SCREEN_PROBE_CURRENT_AO_SLOTS, field: false },
  applyScreenProbeShortRangeAoCompact: { slots: SCREEN_PROBE_CURRENT_AO_SLOTS, field: false },
  temporalScreenProbesWithAo: {
    slots: [...SCREEN_PROBE_STAGES.temporalScreenProbes.slots, 'shortRangeAoIn'],
    field: false,
  },
  temporalScreenProbesWithVelocity: {
    slots: [...SCREEN_PROBE_STAGES.temporalScreenProbes.slots, 'motionWithDepth'],
    field: false,
  },
  temporalScreenProbesWithAoAndVelocity: {
    slots: [...SCREEN_PROBE_STAGES.temporalScreenProbes.slots, 'shortRangeAoIn', 'motionWithDepth'],
    field: false,
  },
  integrateScreenSpaceScreenProbesBent: {
    slots: [...SCREEN_PROBE_STAGES.integrateScreenProbes.slots, 'shortRangeAoIn'],
    field: false,
  },
  integrateScreenSpaceScreenProbesWithMotion: {
    slots: [...SCREEN_PROBE_STAGES.integrateScreenProbes.slots, 'probeMovingIn', 'pixelMovingOut'],
    field: false,
  },
  integrateScreenSpaceScreenProbesBentWithMotion: {
    slots: [
      ...SCREEN_PROBE_STAGES.integrateScreenProbes.slots,
      'shortRangeAoIn',
      'probeMovingIn',
      'pixelMovingOut',
    ],
    field: false,
  },
  temporalScreenProbesWithMotion: {
    slots: [...SCREEN_PROBE_STAGES.temporalScreenProbes.slots, 'motionWithDepth', 'pixelMovingIn'],
    field: false,
  },
  temporalScreenProbesWithAoAndMotion: {
    slots: [
      ...SCREEN_PROBE_STAGES.temporalScreenProbes.slots,
      'shortRangeAoIn',
      'motionWithDepth',
      'pixelMovingIn',
    ],
    field: false,
  },
  applyScreenProbeAoHistory: { slots: SCREEN_PROBE_RETAINED_AO_SLOTS, field: false },
  applyScreenProbeAoHistoryCompact: { slots: SCREEN_PROBE_RETAINED_AO_SLOTS, field: false },
  generateHistoryProbeRays: {
    slots: [
      ...SCREEN_PROBE_STAGES.generateProbeRays.slots,
      'radianceIn',
      'probeHistoryIn',
      'screenMotion',
    ],
    field: true,
  },
  generateHardwareCacheProbeRays: {
    slots: [
      ...SCREEN_PROBE_STAGES.generateProbeRays.slots,
      'radianceIn',
      'probeHistoryIn',
      'screenMotion',
      'atlasIn',
    ],
    field: true,
  },
  traceHardwareScreenProbes: {
    slots: [...SCREEN_PROBE_STAGES.traceScreenProbes.slots, 'previousScreenDepth', 'screenMotion'],
    field: false,
  },
  traceHardwareScreenProbesWithVelocity: {
    slots: [
      ...SCREEN_PROBE_STAGES.traceScreenProbes.slots,
      'previousScreenDepth',
      'motionWithDepth',
    ],
    field: false,
  },
  traceHardwareScreenProbesWithMotion: {
    slots: [
      ...SCREEN_PROBE_STAGES.traceScreenProbes.slots,
      'previousScreenDepth',
      'motionWithDepth',
      'receiverMotionIn',
    ],
    field: false,
  },
  copyScreenTraceDepth: {
    slots: ['frame', 'depth', 'previousScreenDepthOut'],
    field: false,
  },
  beginTraceResolve: {
    slots: ['frame', 'adaptiveCountIn', 'fallbackList', 'traceDispatch'],
    field: false,
  },
  resetTraceList: { slots: ['fallbackList'], field: false },
  compactWorldTraces: {
    slots: ['frame', 'probesIn', 'adaptiveCountIn', 'raysIn', 'fallbackList'],
    field: false,
  },
  compactTraceFallbacks: {
    slots: ['frame', 'probesIn', 'adaptiveCountIn', 'raysIn', 'fallbackList'],
    field: false,
  },
  prepareTraceFallbackDispatch: {
    slots: ['fallbackListIn', 'traceDispatch'],
    field: false,
  },
  packRadianceAtlas: {
    slots: ['atlasOut'],
    field: true,
  },
  lightTraceFallbacksAtlas: {
    slots: ['probesIn', 'rays', 'fallbackListIn', 'atlasIn'],
    field: true,
  },
  lightTraceFallbacks: {
    slots: ['probesIn', 'rays', 'fallbackListIn'],
    field: true,
  },
  scatterProbeTraces: {
    slots: ['frame', 'probesIn', 'adaptiveCountIn', 'raysIn', 'traceCells', 'scatterNoise'],
    field: false,
  },
  scatterProbeTracesWithMotion: {
    slots: [
      'frame',
      'probesIn',
      'adaptiveCountIn',
      'raysIn',
      'traceCells',
      'scatterNoise',
      'probeMovingOut',
    ],
    field: false,
  },
  temporalTraceRadiance: {
    slots: [
      'frame',
      'probesIn',
      'radianceOut',
      'probeHistoryIn',
      'probeHistoryOut',
      'traceCellsIn',
    ],
    field: true,
  },
} as const satisfies Record<
  string,
  { readonly slots: readonly ScreenProbeSlot[]; readonly field: boolean }
>;
export type ScreenProbeTraceStage = keyof typeof SCREEN_PROBE_TRACE_STAGES;

export const SCREEN_PROBE_IRRADIANCE_SLOTS = [
  'frame',
  'depth',
  'probesIn',
  'adaptiveCountIn',
  'probeRadiance',
  'radianceOut',
] as const;
export const SCREEN_PROBE_IRRADIANCE_TEXELS = 16;

export type ScreenProbeResource =
  | { readonly buffer: Buffer; readonly size?: number }
  | TextureView
  | Tlas;
export type ScreenProbeDispatch = number | { readonly buffer: Buffer; readonly offset: number };

export interface ScreenProbeKernel {
  /** The group-0 roster the graph declares as accesses. */
  readonly bindings: readonly (readonly [number, Binding, string])[];
  /** `work` is threads for per-thread entries and probes for per-probe entries. */
  record(
    pass: RhiComputePassEncoder,
    resolve: (slot: string) => ScreenProbeResource,
    sample: BindGroup | undefined,
    work: ScreenProbeDispatch,
  ): Result<void, RhiError>;
}

const denseTraceStages = [
  'generateProbeRays',
  'resolveProbeRays',
  'temporalProbeRadiance',
] as const;
type DenseTraceStage = (typeof denseTraceStages)[number];
const denseTraceOnly = new Set<ScreenProbeStage>(denseTraceStages);

export type ScreenProbeKernels = Readonly<
  Record<Exclude<ScreenProbeStage, DenseTraceStage>, ScreenProbeKernel> &
    Partial<
      Record<DenseTraceStage | ScreenProbeTraceStage | ScreenProbePreintegration, ScreenProbeKernel>
    >
>;
export type ScreenProbePreintegration = 'preintegrate' | 'preintegrateScattered';
export type ScreenProbeTracePath = 'dense' | 'compacted' | 'far-radiance';

async function createKernel(
  device: RhiDevice,
  module: ShaderModule,
  label: string,
  entryPoint: string,
  roster: readonly (readonly [number, Binding, string])[],
  sampleLayout: BindGroupLayout | undefined,
  perProbe: boolean,
  atlasSampler?: Sampler,
): Promise<Result<ScreenProbeKernel, RhiError>> {
  const layout = createComputeLayout(
    device,
    roster.map(([binding, kind]) => [binding, kind] as const),
    atlasSampler === undefined
      ? []
      : [{ binding: 38, visibility: 4, sampler: { type: 'filtering' } }],
  );
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: sampleLayout === undefined ? [layout.value] : [layout.value, sampleLayout],
  });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = await prepareComputePipeline(device, {
    label,
    layout: pipelineLayout.value,
    compute: { module, entryPoint },
  });
  if (!pipeline.ok) return pipeline;
  // Graph buffer identities stay valid for the current device/extent. Keep
  // the two history/filter parities with the kernel, comparing the actual
  // resolved handles and binding sizes on every use. Views and TLAS have
  // separate lifetimes and keep their ordinary binding path.
  const bufferOnly = roster.every(
    ([, kind]) => kind === 'read' || kind === 'storage' || kind === 'uniform',
  );
  const groups: { entries: readonly BindGroupEntry[]; value: BindGroup }[] = [];
  return ok({
    bindings: roster,
    record(pass, resolve, sample, work) {
      const entries = roster.map(([binding, kind, name]) =>
        kernelResource(binding, kind, resolve(name)),
      );
      if (atlasSampler !== undefined)
        entries.push({ binding: 38, resource: { kind: 'sampler', value: atlasSampler } });
      let group = bufferOnly
        ? groups.find((previous) =>
            previous.entries.every(({ resource }, index) => {
              const candidate = entries[index]?.resource;
              return (
                resource.kind === 'buffer' &&
                candidate?.kind === 'buffer' &&
                candidate.value.buffer === resource.value.buffer &&
                candidate.value.offset === resource.value.offset &&
                candidate.value.size === resource.value.size
              );
            }),
          )?.value
        : undefined;
      if (group === undefined) {
        const created = device.createBindGroup({ layout: layout.value, entries });
        if (!created.ok) return created;
        group = created.value;
        if (bufferOnly) {
          if (groups.length === 2) groups.shift();
          groups.push({ entries, value: group });
        }
      }
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group);
      if (sampleLayout !== undefined) {
        if (sample === undefined) return err(missingSample(label));
        pass.setBindGroup(1, sample);
      }
      if (typeof work !== 'number') {
        pass.dispatchWorkgroupsIndirect(work.buffer, work.offset);
        return ok(undefined);
      }
      const units = Math.max(1, work);
      if (perProbe) {
        const max = device.limits.maxComputeWorkgroupsPerDimension;
        const x = Math.min(units, max);
        pass.dispatchWorkgroups(x, Math.ceil(units / x));
      } else {
        const [x, y] = linearDispatch(device, units);
        pass.dispatchWorkgroups(x, y);
      }
      return ok(undefined);
    },
  });
}

/** One pipeline per published entry; group(1) is the Irradiance Field sample ABI. */
export async function createScreenProbeKernels(
  device: RhiDevice,
  module: ShaderModule,
  generateModule: ShaderModule,
  preintegrate = false,
  screenSpace = false,
  atlasModule?: ShaderModule,
  shortRangeAoMode?: StandardScreenProbes['shortRangeAoMode'],
  tracePath: ScreenProbeTracePath = 'dense',
) {
  const shortRangeAo = shortRangeAoMode !== undefined;
  const compacted = tracePath !== 'dense';
  const farAtlas = tracePath === 'far-radiance' && atlasModule !== undefined;
  const sampling =
    atlasModule === undefined
      ? undefined
      : device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  if (sampling !== undefined && !sampling.ok) return sampling;
  const sampleLayout = createIrradianceFieldSampleLayout(device, 'live');
  if (!sampleLayout.ok) return sampleLayout;
  const kernels = {} as {
    -readonly [Stage in keyof ScreenProbeKernels]: ScreenProbeKernels[Stage];
  };
  const bindingRoster = (slots: readonly ScreenProbeSlot[]) =>
    slots.map((slot) => {
      const [binding, kind] = SCREEN_PROBE_BINDINGS[slot];
      return [binding, kind, slot] as const;
    });
  // Stages share one sample layout, but no pipeline preparation depends on
  // another stage. Drain all requests before selecting the original first error.
  const requests: Promise<
    readonly [keyof ScreenProbeKernels, Result<ScreenProbeKernel, RhiError>]
  >[] = (Object.keys(SCREEN_PROBE_STAGES) as ScreenProbeStage[])
    .filter((stage) => !compacted || !denseTraceOnly.has(stage))
    .map(async (stage) => {
      const spec = SCREEN_PROBE_STAGES[stage];
      const screenSpaceIntegration = stage === 'integrateScreenProbes' && screenSpace;
      const kernel = await createKernel(
        device,
        stage === 'generateProbeRays' ? generateModule : module,
        `screen-probe.${stage}`,
        stage === 'generateProbeRays'
          ? 'generateCachedProbeRays'
          : screenSpaceIntegration
            ? 'integrateScreenSpaceScreenProbes'
            : stage === 'integrateScreenProbes' && preintegrate
              ? 'integratePreintegratedScreenProbes'
              : stage,
        bindingRoster(spec.slots),
        screenSpaceIntegration ? undefined : sampleLayout.value,
        spec.dispatch === 'probes',
      );
      return [stage, kernel] as const;
    });
  const isShortRangeAoStage = (stage: ScreenProbeTraceStage) =>
    stage === 'computeScreenProbeShortRangeAo' ||
    stage === 'applyScreenProbeShortRangeAo' ||
    stage === 'applyScreenProbeShortRangeAoCompact' ||
    stage === 'temporalScreenProbesWithAo' ||
    stage === 'applyScreenProbeAoHistory' ||
    stage === 'applyScreenProbeAoHistoryCompact';
  const isBentIntegrateStage = (stage: ScreenProbeTraceStage) =>
    stage === 'integrateScreenSpaceScreenProbesBent' ||
    stage === 'integrateScreenSpaceScreenProbesBentWithMotion';
  const bentStageEnabled = (stage: ScreenProbeTraceStage) =>
    shortRangeAoMode === 'full-bent' &&
    screenSpace &&
    (stage === 'integrateScreenSpaceScreenProbesBent' || compacted);
  const traceStageEnabled = (stage: ScreenProbeTraceStage) => {
    if (isBentIntegrateStage(stage)) return bentStageEnabled(stage);
    if (stage === 'temporalScreenProbesWithVelocity') return screenSpace;
    if (stage === 'temporalScreenProbesWithAoAndVelocity') return screenSpace && shortRangeAo;
    if (
      stage === 'integrateScreenSpaceScreenProbesWithMotion' ||
      stage === 'temporalScreenProbesWithMotion'
    )
      return screenSpace && compacted;
    if (stage === 'temporalScreenProbesWithAoAndMotion')
      return screenSpace && compacted && shortRangeAo;
    if (stage === 'traceHardwareScreenProbesWithVelocity')
      return screenSpace && device.caps.rayQuery.supported;
    const history = stage === 'traceHardwareScreenProbes' || stage === 'copyScreenTraceDepth';
    if (isShortRangeAoStage(stage)) return shortRangeAo && screenSpace;
    return history ? device.caps.rayQuery.supported : compacted;
  };
  const prepareTraceStages = () => {
    for (const stage of Object.keys(SCREEN_PROBE_TRACE_STAGES) as ScreenProbeTraceStage[]) {
      if (!traceStageEnabled(stage)) continue;
      const historyGeneration = stage === 'generateHistoryProbeRays';
      const cacheGeneration = stage === 'generateHardwareCacheProbeRays';
      if ((historyGeneration && farAtlas) || (cacheGeneration && !farAtlas)) continue;
      if (stage === 'lightTraceFallbacks' && atlasModule !== undefined) continue;
      const usesAtlas =
        cacheGeneration || stage === 'packRadianceAtlas' || stage === 'lightTraceFallbacksAtlas';
      const source = usesAtlas ? atlasModule : historyGeneration ? generateModule : module;
      if (source === undefined) continue;
      const spec = SCREEN_PROBE_TRACE_STAGES[stage];
      requests.push(
        createKernel(
          device,
          source,
          `screen-probe.${stage}`,
          stage,
          bindingRoster(spec.slots),
          spec.field ? sampleLayout.value : undefined,
          historyGeneration ||
            cacheGeneration ||
            stage === 'packRadianceAtlas' ||
            stage === 'temporalTraceRadiance',
          cacheGeneration || stage === 'lightTraceFallbacksAtlas' ? sampling?.value : undefined,
        ).then((result) => [stage, result] as const),
      );
    }
  };
  prepareTraceStages();
  if (preintegrate) {
    const [stage, entry] = compacted
      ? (['preintegrateScattered', 'preintegrateScatteredScreenProbes'] as const)
      : (['preintegrate', 'preintegrateScreenProbes'] as const);
    requests.push(
      createKernel(
        device,
        module,
        `screen-probe.${stage}`,
        entry,
        bindingRoster(SCREEN_PROBE_IRRADIANCE_SLOTS),
        undefined,
        false,
      ).then((result) => [stage, result] as const),
    );
  }
  const prepared = await Promise.allSettled(requests);
  for (const result of prepared) {
    if (result.status === 'rejected') throw result.reason;
    const [stage, kernel] = result.value;
    if (!kernel.ok) return kernel;
    kernels[stage] = kernel.value;
  }
  return ok({ sampleLayout: sampleLayout.value, kernels });
}

function missingSample(label: string): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: `${label} requires the Irradiance Field sample group`,
    hint: 'bind the current field sample group before recording screen-probe stages',
    detail: { error: { code: 'screen-probe-sample-missing', message: label } },
  });
}

function screenProbeWorldTraversalWgsl(
  traversal: WorldTraversal,
  rootResolve: boolean,
  approximate: MeshDfApproxPolicy | undefined,
  compact: boolean,
  classifyMotion: boolean,
) {
  if (classifyMotion && (traversal !== 'ray-query' || !compact || rootResolve))
    throw new Error('Screen Probe hit motion requires compact hardware World traversal');
  if (approximate !== undefined && (traversal !== 'global-sdf' || rootResolve))
    throw new Error(
      'Mesh DF Screen rendering uses its own query bank, not hardware or a strict prepared-root payload',
    );
  return classifyMotion
    ? worldRayQueryMotionTraversalWgsl()
    : worldTraversalWgsl(
        traversal,
        false,
        traversal === 'global-sdf',
        traversal === 'global-sdf' && !rootResolve && approximate === undefined,
        approximate,
      );
}

/** World trace for rays the screen trace left unresolved (UE
 * ScreenProbeTraceVoxels/MeshSDF -> Card radiance), mirroring the Irradiance
 * Field probe trace through the same world traversal: hit -> lit Card
 * texels; miss -> environment;
 * backface -> zero; budget, field and invalid outcomes remain incomplete. */
export const screenProbeWorldWgsl = (
  traversal: WorldTraversal,
  rootResolve = false,
  approximate?: MeshDfApproxPolicy,
  compact = false,
  classifyMotion = false,
) => {
  const traversalModule = screenProbeWorldTraversalWgsl(
    traversal,
    rootResolve,
    approximate,
    compact,
    classifyMotion,
  );
  const strictLocalSdf = traversal === 'global-sdf' && !rootResolve && approximate === undefined;
  const tracesToCacheBoundary = compact && traversal === 'ray-query';
  return `${traversalModule}
${SCREEN_PROBE_WORLD_RECORDS_WGSL}@group(0) @binding(5) var<storage,read> cards: array<Card>;
@group(0) @binding(6) var<storage,read> cardLit: array<vec4f>;
@group(0) @binding(7) var<storage,read_write> rays: array<ProbeRay>;
@group(0) @binding(8) var<storage,read> probesIn: array<ScreenProbe>;
@group(0) @binding(9) var<uniform> probeFrame: ScreenProbeFrame;
@group(0) @binding(10) var<uniform> settings: vec4u;
@group(0) @binding(11) var albedo: texture_2d<f32>;
@group(0) @binding(12) var normal: texture_2d<f32>;
@group(0) @binding(13) var emission: texture_2d<f32>;
@group(0) @binding(14) var f0: texture_2d<f32>;
@group(0) @binding(15) var cardDepth: texture_depth_2d;
${compact ? '@group(0) @binding(16) var<storage,read> traceListIn: array<u32>;' : ''}
${classifyMotion ? '@group(0) @binding(17) var<storage,read> receiverMotion: array<vec2f>;\n' : ''}fn worldSceneExpected()->vec4u{return probeFrame.expectedSource;}
${traversal === 'global-sdf' ? (approximate === undefined ? SCREEN_PROBE_CONTACT_WGSL : SCREEN_PROBE_DF_RECEIVER_WGSL) : ''}
${strictLocalSdf ? SCREEN_PROBE_ENDPOINT_WGSL : ''}
${WORLD_CARD_RADIANCE_WGSL}${
  rootResolve
    ? `
${SCREEN_PROBE_RECEIVER_REQUEST_WGSL}
@group(0) @binding(16) var<storage,read> rootRequests:array<ScreenProbeRootRequest>;
fn screenProbePreparedHit(i:u32)->Hit {
 let failed=Hit(vec4u(4u,0u,0u,0u),vec4f(0),vec4f(0),vec4f(0));let probe=probesIn[i/64u];
 if(i>=arrayLength(&rootRequests)){return failed;}let request=rootRequests[i];
 if(request.control.x!=3u || request.control.y!=i || request.control.z!=probeFrame.probes.w || request.control.w!=0u ||
  any(request.expected!=probeFrame.expectedSource) || probeFrame.expectedSource.w==0u ||
  any(grid.source!=probeFrame.expectedSource) || grid.source.x!=sdfInstanceRowCount()*36u ||
  grid.source.y!=sdfFieldWordCount() || grid.source.z!=grid.dimensionsCount.w ||
  any(request.originLo!=probe.canonicalLo)||any(request.originHi!=probe.canonicalHi)||request.receiverRow!=probe.receiverRow||request.receiverPrimitive!=probe.receiverPrimitive){return failed;}
 return Hit(request.payload[0],bitcast<vec4f>(request.payload[1]),bitcast<vec4f>(request.payload[2]),bitcast<vec4f>(request.payload[3]));
}
`
    : ''
}
fn withStatus(info: u32, status: u32) -> u32 { return (info & ~(7u << 12u)) | (status << 12u); }
@compute @workgroup_size(64) fn traceWorldProbes(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
 let index=gid.x+gid.y*groups.x*64u;
 ${compact ? 'if(index>=traceListIn[0]){return;} let i=traceListIn[index+1u];' : 'let i=index;'}
 if(i>=(probeFrame.probes.x+probeFrame.probes.y)*64u){return;}
 var ray=rays[i];
 if(((ray.info>>12u)&7u)!=${ScreenProbeRayStatus.world}u){return;}
 let probe=probesIn[i/64u];
 ${
   tracesToCacheBoundary
     ? `
 let cacheDistance=ray.hitDistance;
 let reachesCache=cacheDistance>0.0 && cacheDistance<probeFrame.environment.w;
 let tMax=select(probeFrame.environment.w,cacheDistance,reachesCache);
 `
     : 'let tMax=probeFrame.environment.w;'
 }
 ray.hitDistance=-1.0;
 if(tMax<=0.0){ray.radiance=probeFrame.environment.xyz;ray.info=withStatus(ray.info,${ScreenProbeRayStatus.resolved}u);rays[i]=ray;return;}
 // Screen misses do not prove empty world space, especially at subpixel walls.
 ${
   traversal === 'global-sdf'
     ? approximate === undefined
       ? `let contact=screenProbeContact(probe,ray.direction);
 if(contact.valid!=1u){ray.radiance=vec3f(0);ray.info=withStatus(ray.info,${ScreenProbeRayStatus.incomplete}u);rays[i]=ray;return;}
 let origin=bitcast<vec3f>(probe.canonicalLo);`
       : `let receiver=screenProbeDfReceiver(probe);
 if(receiver.valid!=1u){ray.radiance=vec3f(0);ray.info=withStatus(ray.info,${ScreenProbeRayStatus.incomplete}u);rays[i]=ray;return;}
 let origin=bitcast<vec3f>(probe.canonicalLo);`
     : 'let origin=worldSurfaceOrigin(probe.position,probe.normal,probeFrame.tuning.z);'
 }${
   strictLocalSdf
     ? `
 let endpoint=screenProbeEndpoint(probe,ray,contact);
 ray.info=(ray.info&~RAY_SCREEN_ENDPOINT_TESTED)|select(0u,RAY_SCREEN_ENDPOINT_TESTED,endpoint.tested==1u);`
     : ''
 }
 ${
   classifyMotion
     ? `let tracked = traceWorldWithHitMotion(Ray(origin,0.0,ray.direction,tMax,vec4u(1u,0u,0u,0u)),probeFrame.query.x);
 let hit = tracked.hit;
 let receiver = receiverMotion[i / 64u];
 // Lumen compares displacement magnitudes relative to linear probe depth.
 // The minimum distance of 100 cm is one metre in ForgeaX world units.
 if (tracked.displacement.w == 1.0 && receiver.x >= 0.0 &&
     abs(length(tracked.displacement.xyz) - receiver.x) > 0.005 * max(receiver.y, 1.0)) {
   ray.info |= ${SCREEN_PROBE_HIT_MOVING}u;
 }`
     : `let hit=${rootResolve ? 'screenProbePreparedHit(i)' : `traceWorld(Ray(origin,0.0,ray.direction,tMax,vec4u(1u,0u,0u,0u)),probeFrame.query.x,bitcast<f32>(probeFrame.query.y)${traversal === 'global-sdf' ? (approximate === undefined ? ',probe.canonicalHi,bitcast<vec3u>(ray.direction),contact,endpoint.trace' : ',probe.canonicalHi,bitcast<vec3u>(ray.direction),receiver') : ''})`};`
 }
 let status=hit.state.x;
 if(status!=${GlobalSdfQueryStatus.miss}u&&status!=${GlobalSdfQueryStatus.hit}u&&status!=${GlobalSdfQueryStatus.negativeStart}u){
  ray.radiance=vec3f(0.0);ray.info=withStatus(ray.info,${ScreenProbeRayStatus.incomplete}u);rays[i]=ray;return;
 }
 var resolved=true;
 if(status==${GlobalSdfQueryStatus.miss}u){${
   tracesToCacheBoundary
     ? `
  if(reachesCache){
   ray.hitDistance=tMax;
   ray.info=withStatus(ray.info,${ScreenProbeRayStatus.cacheBoundary}u)|${SCREEN_PROBE_REACHED_CACHE}u;
   rays[i]=ray;return;
  }`
     : ''
 }
  ray.radiance=probeFrame.environment.xyz;
  ray.hitDistance=tMax;
 } else if(status==${GlobalSdfQueryStatus.negativeStart}u||(status==${GlobalSdfQueryStatus.hit}u&&worldHitBackface(hit,Ray(origin,0.0,ray.direction,tMax,vec4u(1u,0u,0u,0u))))){
  ray.radiance=vec3f(0.0);
  ray.hitDistance=select(length(hit.position.xyz-probe.position),0.0,status==${GlobalSdfQueryStatus.negativeStart}u);
 } else if(status==${GlobalSdfQueryStatus.hit}u){
   let card=worldCardRadiance(hit,probeFrame.tuning.w,${traversal !== 'ray-query'},Ray(origin,0.0,ray.direction,tMax,vec4u(1u,0u,0u,0u)));
   ray.radiance=max(card.xyz,vec3f(0));resolved=card.w==${WorldCardSampleStatus.mapped}.0||card.w==${WorldCardSampleStatus.backface}.0;
   if(resolved){ray.hitDistance=length(hit.position.xyz-probe.position);}
 } else { resolved=false; }
 ray.info=withStatus(ray.info,select(${ScreenProbeRayStatus.fallback}u,${ScreenProbeRayStatus.resolved}u,resolved));
 rays[i]=ray;
}
`;
};

/** Irradiance Field resources plus the screen-probe frame/probes/rays the world kernel reads. */
type ScreenProbeWorldInput =
  | Exclude<
      IrradianceFieldKernelInput,
      'lights' | 'field' | 'surfaces' | 'probeRays' | 'irradiance' | 'moments' | 'meta' | 'frame'
    >
  | 'rays'
  | 'probesIn'
  | 'probeFrame'
  | 'traceListIn'
  | 'receiverMotion'
  | (typeof SCREEN_PROBE_ENDPOINT_ROSTER)[number][2];

export const screenProbeWorldRoster = (
  traversal: WorldTraversal,
  endpoint = true,
  compact = false,
  classifyMotion = false,
): readonly (readonly [number, Binding, ScreenProbeWorldInput])[] => [
  ...WORLD_TRAVERSAL_ROSTER[traversal],
  [5, 'read', 'cards'],
  [6, 'read', 'cardLit'],
  [7, 'storage', 'rays'],
  [8, 'read', 'probesIn'],
  [9, 'uniform', 'probeFrame'],
  [10, 'uniform', 'cardSettings'],
  [11, 'float', 'albedoRoughness'],
  [12, 'float', 'normals'],
  [13, 'float', 'emissionMetallic'],
  [14, 'float', 'f0Validity'],
  [15, 'depth', 'depth'],
  ...(traversal === 'global-sdf' && endpoint ? SCREEN_PROBE_ENDPOINT_ROSTER : []),
  ...(compact ? [[16, 'read', 'traceListIn'] as const] : []),
  ...(classifyMotion ? [[17, 'read', 'receiverMotion'] as const] : []),
];

/** The world trace already binds eight storage buffers (the WebGPU default
 * per-stage limit), so it carries no field sample group. */
export async function createScreenProbeWorldKernel(
  device: RhiDevice,
  module: ShaderModule,
  traversal: WorldTraversal,
  endpoint = true,
  compact = false,
  classifyMotion = false,
) {
  return createKernel(
    device,
    module,
    'screen-probe.traceWorldProbes',
    'traceWorldProbes',
    screenProbeWorldRoster(traversal, endpoint, compact, classifyMotion),
    undefined,
    false,
  );
}

/** Canonical construction is once per probe; its texture inputs add no ninth
 * storage buffer to the subsequent per-ray World traversal. */
export function createScreenProbeReceiverKernel(device: RhiDevice, module: ShaderModule) {
  return createKernel(
    device,
    module,
    'screen-probe.prepare-receivers',
    'prepareScreenReceivers',
    [
      [1, 'uniform', 'grid'],
      [2, 'read', 'instances'],
      [3, 'read', 'fields'],
      [6, 'storage', 'probesIn'],
      [9, 'uniform', 'probeFrame'],
      [17, 'uint', 'visibleSurface'],
      [18, 'uint', 'receiverSource'],
      [19, 'uniform', 'receiverView'],
    ],
    undefined,
    false,
  );
}

/** Qualification-only split. No ninth storage binding and no field sample
 * group: all three passes belong to the same Screen graph/source epoch. */
export async function createScreenProbeRootKernel(
  device: RhiDevice,
  module: ShaderModule,
  stage: ScreenProbeRootStage,
) {
  return createKernel(
    device,
    module,
    `screen-probe.${stage}`,
    stage === 'resolveRoot' ? 'traceWorldProbes' : stage,
    screenProbeRootRoster(stage),
    undefined,
    false,
  );
}

export function screenProbeRootRoster(
  stage: ScreenProbeRootStage,
): readonly (readonly [number, Binding, string])[] {
  return stage === 'resolveRoot'
    ? [
        ...screenProbeWorldRoster('global-sdf', false).filter(([binding]) => binding !== 0),
        [16, 'read', 'rootRequests'],
      ]
    : [
        ...(stage === 'refineRoot' ? WORLD_TRAVERSAL_ROSTER['global-sdf'] : []),
        ...SCREEN_PROBE_ROOT_RAY_ROSTER.map(([binding, kind, name]) =>
          stage === 'refineRoot' && binding === 7
            ? ([binding, 'storage', name] as const)
            : ([binding, kind, name] as const),
        ),
        ...(stage === 'refineRoot' ? SCREEN_PROBE_ENDPOINT_ROSTER : []),
      ];
}
