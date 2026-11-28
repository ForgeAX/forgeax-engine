import { err, ok } from '@forgeax/engine-types';
import { CloudLayerResourceFailureError } from '../../errors/cloud';
import type {
  RenderFeaturePlan,
  RenderFeatureResourceDeclaration,
  RenderFeatureWork,
} from '../../features/plan';
import type {
  RenderFeature,
  RenderFeatureExtractView,
  RenderFeaturePlanContext,
} from '../../features/types';
import { SkyPass } from '../../record/gpu-pass-timing/sky-pass-names';
import { createAnalyticCloudFeature } from '../analytic-feature';
import { CLOUD_DEPTH_RANGE_QUARTER } from '../contracts';
import type { ExtractedCookedCloudLayer } from '../extract';
import {
  type CloudLayerInspection,
  cloudCapabilitiesFromRhi,
  inspectCloudLayer,
} from '../inspection';
import { selectCloudShadowFormat } from '../lighting/shadow-format';
import { cloudShadowSpatialLayout } from '../lighting/shadow-spatial-layout';
import { CLOUD_MODE0_BLUE_NOISE } from '../tracing/blue-noise';
import { type CloudRecordedAdoption, captureCloudAdoption } from './adoption';
import {
  abortCloudHistory,
  acceptCloudHistory,
  type CloudHistoryCandidate,
  type CloudHistoryStamp,
  type CloudHistoryState,
  type CloudTransportFormat,
  createCloudHistoryState,
  invalidateCloudHistory,
  prepareCloudHistory,
  UE5_CLOUD_DEPTH_CLEAR_KM,
} from './history';

export const CLOUD_MODE0_TRACE_TARGETS = [
  'cloud-mode0-trace-far',
  'cloud-mode0-trace-near',
  'cloud-mode0-trace-depth',
] as const;
export const CLOUD_MODE0_PROBE_TARGETS = [
  'cloud-mode0-probe-color',
  'cloud-mode0-probe-data',
  'cloud-mode0-probe-depth',
] as const;
export const CLOUD_MODE0_PROBE_PASS = SkyPass.cloudProbe;
const UE5_CLEAR_DEPTH = Object.freeze({
  r: UE5_CLOUD_DEPTH_CLEAR_KM,
  g: UE5_CLOUD_DEPTH_CLEAR_KM,
  b: UE5_CLOUD_DEPTH_CLEAR_KM,
  a: UE5_CLOUD_DEPTH_CLEAR_KM,
});
const CLEAR_TRANSPORT = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });

function cloudMode0Clear(target: string, ueDepthKm: boolean) {
  return ueDepthKm
    ? { clearValue: target.includes('depth') ? UE5_CLEAR_DEPTH : CLEAR_TRANSPORT }
    : {};
}

// The shader takes a one-based slice. Keep the spatial dither stable across
// temporal updates so a newly traced pixel cannot alternate between noise values.
const MODE0_STABLE_BLUE_NOISE_SLICE = 1;
// A negative selector keeps the UE kilometer contract and takes midpoint samples.
const MODE0_MIDPOINT_WITH_UE_DEPTH = -1;

const MODE0_DEPTH_RANGE_ENTRY = /\bfn\s+fs_trace_mode_zero(?:_air)?_depth_range\s*\(/g;
const CURRENT = [
  'cloud-history-radiance-current',
  'cloud-history-transmittance-current',
  'cloud-history-depth-current',
] as const;
const PREVIOUS = [
  'cloud-history-radiance-previous',
  'cloud-history-transmittance-previous',
  'cloud-history-depth-previous',
] as const;
interface FrameData {
  inspection: Readonly<Record<string, CloudLayerInspection>>;
  readonly layers: Readonly<Record<string, ExtractedCookedCloudLayer>>;
  readonly views: readonly RenderFeatureExtractView[];
}
const INACTIVE_CLOUD_FRAME: FrameData = Object.freeze({
  layers: Object.freeze({}),
  inspection: Object.freeze({}),
  views: Object.freeze([]),
});

interface ResourceStamp {
  readonly matrix: readonly number[];
  readonly frameNumber: number;
  readonly phase: number;
}
interface Pending {
  readonly view: string;
  readonly state: CloudHistoryState<ResourceStamp>;
  readonly candidate: CloudHistoryCandidate<ResourceStamp>;
  readonly resource: ResourceStamp;
  readonly tracePass: string;
}

function cloudHistoryLighting(
  layer: ExtractedCookedCloudLayer,
  facts: RenderFeatureExtractView | undefined,
): CloudHistoryStamp['lighting'] {
  const sun = facts?.frame?.cloudSun;
  const direction = sun?.direction;
  const solar =
    layer.lighting?.atmosphereTransmittanceMode === 1
      ? [1, 1, 1]
      : (layer.lightEnvironment?.groundSolarTransmittance ?? [1, 1, 1]);
  return direction === undefined && layer.shadowSettings === undefined
    ? undefined
    : {
        directionToLight:
          direction === undefined
            ? (layer.shadowSettings?.directionToLight ?? [0, 1, 0])
            : [-(direction[0] ?? 0), -(direction[1] ?? 0), -(direction[2] ?? 0)],
        illuminance: [0, 1, 2].map(
          (channel) => (solar[channel] ?? 1) * (sun?.color?.[channel] ?? sun?.intensity ?? 1),
        ) as [number, number, number],
      };
}

function cloudHistoryStamp(
  layer: ExtractedCookedCloudLayer,
  facts: RenderFeatureExtractView | undefined,
  id: string,
  width: number,
  height: number,
  generation: number,
  ueDepthKm: boolean,
): CloudHistoryStamp {
  return {
    lighting: cloudHistoryLighting(layer, facts),
    viewId: id,
    width,
    height,
    deviceGeneration: facts?.frame?.view?.deviceGeneration ?? generation,
    materialIdentity:
      layer.status !== 'analytic'
        ? `${layer.programIdentity}:${layer.cookIdentity}`
        : JSON.stringify(layer.sample),
    policyIdentity: `${ueDepthKm ? 'ue5-desktop-km-v1' : 'meters'}:${JSON.stringify({
      ...layer,
      adoption: undefined,
      aerialPerspectiveIdentity: facts?.frame?.aerialPerspectiveIdentity,
      aerialPerspectiveFar: facts?.selectedCamera?.far,
      windOffsetMeters: undefined,
      lightEnvironment:
        layer.lightEnvironment === undefined
          ? undefined
          : {
              ...layer.lightEnvironment,
              groundSolarTransmittance: undefined,
            },
      shadowSettings:
        layer.shadowSettings === undefined
          ? undefined
          : {
              ...layer.shadowSettings,
              directionToLight: undefined,
            },
      diagnostic: undefined,
      shadowMap:
        layer.shadowMap === undefined
          ? undefined
          : {
              extentMeters: layer.shadowMap.extentMeters,
              resolution: layer.shadowMap.resolution,
              mapSamples: layer.shadowMap.mapSamples,
              spatialPasses: layer.shadowMap.spatialPasses,
              mode: layer.shadowMap.mode,
              cast: layer.shadowMap.cast,
              biasMeters: layer.shadowMap.biasMeters,
              strength: layer.shadowMap.strength,
              surfaceStrength: layer.shadowMap.surfaceStrength,
            },
    })}:${facts?.selectedCamera?.historyVersion ?? 0}`,
    initializationRevision: layer.initializationRevision ?? 0,
    // Renderer transport is scene-linear; camera exposure belongs to Output Transform.
    exposure: 1,
    cameraCut: facts?.frame?.view?.cameraCut === true || facts?.frame?.view?.recovery === true,
  };
}

function cloudMode0Inspection(
  layer: ExtractedCookedCloudLayer,
  candidate: CloudHistoryCandidate<ResourceStamp>,
  id: string,
  context: RenderFeaturePlanContext,
): CloudLayerInspection {
  return {
    ...inspectCloudLayer({
      authored: true,
      sourceKey: candidate.stamp.materialIdentity,
      generation: context.generation,
      candidateGeneration: context.generation,
      capability: cloudCapabilitiesFromRhi(context.caps),
    }),
    mode0: {
      viewId: id,
      deviceGeneration: candidate.stamp.deviceGeneration,
      materialIdentity: candidate.stamp.materialIdentity,
      historyValid: candidate.history !== undefined,
      preparedPhase: candidate.phase,
      acceptedFrame: candidate.history?.resource.frameNumber,
      acceptedPhase: candidate.history?.resource.phase,
      resetReasons: candidate.resetReasons,
      ...(layer.shadowMap === undefined
        ? {}
        : {
            shadowMap: {
              format: selectCloudShadowFormat(context.caps),
              rawResolution: layer.shadowMap.resolution,
              filteredResolution: cloudShadowSpatialLayout(
                layer.shadowMap.resolution,
                layer.shadowMap.spatialPasses,
                layer.shadowMap.ue5Reference,
              ).filteredResolution,
              spatialPasses: layer.shadowMap.spatialPasses ?? 1,
              traceSamples: layer.shadowMap.traceSamples ?? layer.shadowMap.mapSamples,
              originMeters: layer.shadowMap.origin,
              fullWidthMeters: layer.shadowMap.extentMeters,
            },
          }),
      diagnostic:
        layer.status === 'analytic'
          ? { mode: 0, status: 'inactive' }
          : layer.diagnostic?.[0] === 1 || layer.diagnostic?.[0] === 2
            ? {
                mode: layer.diagnostic[0],
                status: layer.status === 'sampled' ? 'probe' : 'unsupported',
                ...(layer.status === 'program'
                  ? {
                      reason: 'This material declares no conservative C4/count diagnostic contract',
                    }
                  : {}),
              }
            : {
                mode: layer.diagnostic?.[0] ?? 0,
                status: (layer.diagnostic?.[0] ?? 0) > 0 ? 'display' : 'inactive',
              },
    },
  };
}

type Mode0FullscreenProgram = Extract<
  RenderFeatureResourceDeclaration,
  { kind: 'fullscreen-program' }
>;

function mode0TraceProgram(
  resource: Mode0FullscreenProgram,
  params: NonNullable<Mode0FullscreenProgram['params']>,
  layer: ExtractedCookedCloudLayer,
  mode0: readonly number[],
  useDepthRange: boolean,
  ueDepthKm: boolean,
  useNoise: boolean,
): RenderFeatureResourceDeclaration {
  const values = new Float32Array(params.defaultValue.slice().buffer);
  const next = new Float32Array(
    Math.max(
      values.length,
      layer.status === 'analytic' ? 16 : layer.status === 'program' ? 48 : 44,
    ),
  );
  next.set(values);
  next.set(mode0, layer.status === 'sampled' ? 40 : layer.status === 'program' ? 44 : 12);
  if (useNoise && layer.status !== 'analytic') {
    next[layer.status === 'sampled' ? 27 : 59] =
      layer.viewBlueNoise === false ? MODE0_MIDPOINT_WITH_UE_DEPTH : MODE0_STABLE_BLUE_NOISE_SLICE;
  }
  const frameParams = new Uint8Array(next.buffer);
  return {
    ...resource,
    // The cooked shader keeps this exact name; Naga rewrites identifiers ending in a digit.
    fragmentEntryPoint: `fs_trace_mode_zero${
      layer.lightEnvironment?.atmosphereAvailable === true ? '_air' : ''
    }${useDepthRange ? '_depth_range' : ''}${ueDepthKm ? '_ue' : ''}`,
    ...(useDepthRange || useNoise
      ? {
          reads: [
            ...(resource.reads ?? []),
            {
              key: useDepthRange ? CLOUD_DEPTH_RANGE_QUARTER : 'unused-cloud-depth-range',
              sampleType: 'unfilterable-float' as const,
            },
            ...(useNoise ? [CLOUD_MODE0_BLUE_NOISE] : []),
          ],
        }
      : {}),
    params: { byteSize: next.byteLength, defaultValue: frameParams },
    paramsSource: 'current-view',
    frameParams,
  };
}

function mode0DepthRangeAvailable(
  layer: ExtractedCookedCloudLayer,
  view: RenderFeaturePlanContext['views'][number],
  context: RenderFeaturePlanContext,
): boolean {
  const extent = view.frame.extent;
  return (
    context.caps.rg16floatRenderable === true &&
    (layer.status !== 'program' ||
      layer.rendererSource.match(MODE0_DEPTH_RANGE_ENTRY)?.length === 2) &&
    view.targets.some((target) => target.name === 'depth' && target.sampleCount === 1) &&
    (extent === undefined ||
      (extent.internalWidth === extent.outputWidth &&
        extent.internalHeight === extent.outputHeight))
  );
}

function mode0TraceWork(
  work: RenderFeatureWork,
  layer: ExtractedCookedCloudLayer,
  mode0: readonly number[],
  transportFormat: CloudTransportFormat,
  useDepthRange: boolean,
  ueDepthKm = false,
) {
  const useNoise = ueDepthKm && layer.status !== 'analytic';
  const traceResources = work.resources.map((resource): RenderFeatureResourceDeclaration => {
    if (
      resource.kind === 'fullscreen-program' &&
      resource.params !== undefined &&
      resource.name.startsWith('cloud-')
    ) {
      return mode0TraceProgram(
        resource,
        resource.params,
        layer,
        mode0,
        useDepthRange,
        ueDepthKm,
        useNoise,
      );
    }
    if (
      (useDepthRange || useNoise) &&
      resource.kind === 'graphics-bindings' &&
      resource.name === 'analytic-cloud-inputs'
    ) {
      const current = resource.values.additionalTextures;
      return {
        ...resource,
        values: {
          ...resource.values,
          additionalTextures: [
            ...(Array.isArray(current) ? current : []),
            useDepthRange ? CLOUD_DEPTH_RANGE_QUARTER : false,
            ...(useNoise ? [CLOUD_MODE0_BLUE_NOISE] : []),
          ],
        },
      };
    }
    if (resource.kind === 'graphics-program' && resource.name === 'analytic-cloud-pipeline')
      return {
        ...resource,
        program: {
          ...resource.program,
          colorFormats: [
            transportFormat,
            transportFormat,
            ueDepthKm ? 'rgba16float' : 'rgba32float',
          ],
        },
      };
    return resource;
  });
  const trace = {
    ...work,
    resources: traceResources,
    passes: work.passes.map((pass) =>
      pass.kind === 'raster' &&
      (pass.name === SkyPass.cloudSampledTrace || pass.name === SkyPass.cloudAnalyticTrace)
        ? {
            ...pass,
            ...(useDepthRange
              ? { sampledTargets: [...(pass.sampledTargets ?? []), CLOUD_DEPTH_RANGE_QUARTER] }
              : {}),
            colorAttachments: CLOUD_MODE0_TRACE_TARGETS.map((target) => ({
              target,
              ...cloudMode0Clear(target, ueDepthKm),
              loadOp: 'clear',
              storeOp: 'store',
            })),
          }
        : pass,
    ),
  } satisfies RenderFeatureWork;
  return trace;
}

function mode0ProbeWork(
  work: RenderFeatureWork,
  traceResources: readonly RenderFeatureResourceDeclaration[],
): RenderFeatureWork {
  const renamed = new Map(
    (traceResources ?? []).map((resource) => [resource.name, `${resource.name}.probe`]),
  );
  const probeResources = traceResources.map((resource): RenderFeatureResourceDeclaration => {
    const name = renamed.get(resource.name) ?? resource.name;
    if (resource.kind === 'fullscreen-program')
      return { ...resource, name, fragmentEntryPoint: 'fs_probe' };
    if (resource.kind === 'graphics-program')
      return {
        ...resource,
        name,
        program: {
          ...resource.program,
          shader: renamed.get(resource.program.shader) ?? resource.program.shader,
          colorFormats: ['rgba16float', 'rgba16float', 'rgba32float'],
        },
      };
    if (resource.kind === 'graphics-bindings')
      return {
        ...resource,
        name,
        program: renamed.get(resource.program) ?? resource.program,
        values: {
          ...resource.values,
          ...(typeof resource.values.shader === 'string'
            ? { shader: renamed.get(resource.values.shader) ?? resource.values.shader }
            : {}),
        },
      };
    return { ...resource, name };
  });
  return {
    scope: work.scope,
    resources: probeResources,
    passes: [
      {
        kind: 'raster',
        name: CLOUD_MODE0_PROBE_PASS,
        colorAttachments: CLOUD_MODE0_PROBE_TARGETS.map((target) => ({
          target,
          loadOp: 'clear',
          storeOp: 'store',
        })),
        sampledTargets:
          work.passes.find(
            (pass) => pass.kind === 'raster' && pass.name === SkyPass.cloudSampledTrace,
          )?.kind === 'raster'
            ? work.passes.flatMap((pass) =>
                pass.kind === 'raster' && pass.name === SkyPass.cloudSampledTrace
                  ? (pass.sampledTargets ?? [])
                  : [],
              )
            : ['motion-input', 'depth'],
        draws: [
          {
            program: 'analytic-cloud-pipeline.probe',
            bindings: ['analytic-cloud-view.probe', 'analytic-cloud-inputs.probe'],
            vertexData: [],
            vertexLayout: 'none',
            draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
          },
        ],
      },
    ],
  };
}

const MODE0_SCENE_BLEND = {
  color: { operation: 'add', srcFactor: 'one', dstFactor: 'src-alpha' },
  alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
} as const;

function mode0StageWork(
  stage: 'reconstruct' | 'compose',
  source: string,
  layer: ExtractedCookedCloudLayer,
  params: Uint8Array<ArrayBuffer>,
  id: string,
  transportFormat: CloudTransportFormat,
  ueDepthKm: boolean,
  blendIntoScene: boolean,
): RenderFeatureWork {
  const reconstruct = stage === 'reconstruct';
  const blend = !reconstruct && blendIntoScene;
  const diagnostic =
    layer.status === 'sampled' || layer.status === 'program' ? (layer.diagnostic?.[0] ?? 0) : 0;
  const stageParams = reconstruct
    ? params
    : new Uint8Array(
        new Float32Array([
          ...new Float32Array(params.buffer),
          diagnostic,
          ueDepthKm ? Number(new Float32Array(params.buffer)[23]) * 0.001 : 0,
          0,
          0,
          layer.bottomMeters,
          layer.thicknessMeters,
          layer.entryLimitMeters,
          layer.traceLimitMeters,
        ]).buffer,
      );
  const name = reconstruct ? SkyPass.cloudReconstruction : SkyPass.cloudResolve;
  const inputs = reconstruct
    ? [...CLOUD_MODE0_TRACE_TARGETS, ...PREVIOUS]
    : blend
      ? CURRENT
      : ['motion-input', ...CURRENT];
  const targets = reconstruct ? CURRENT : ['motion-output'];
  const reads = inputs.map((key) =>
    !ueDepthKm && (key.endsWith('depth') || key.includes('depth-'))
      ? { key, sampleType: 'unfilterable-float' as const }
      : key,
  );
  return {
    scope: { view: id },
    resources: [
      {
        kind: 'fullscreen-program',
        name,
        source,
        usesView: true,
        ...(ueDepthKm ? { fragmentEntryPoint: blend ? 'fs_ue_blend' : 'fs_ue_mode' } : {}),
        reads: [...reads, { key: 'depth', sampleType: 'depth' }],
        params: { byteSize: stageParams.byteLength, defaultValue: stageParams },
        paramsSource: 'current-view',
        frameParams: stageParams,
      },
      {
        kind: 'graphics-program',
        name: `${name}.pipeline`,
        program: {
          shader: name,
          vertexLayout: 'none',
          sampleCount: 1,
          colorFormats: reconstruct
            ? [transportFormat, transportFormat, ueDepthKm ? 'rgba16float' : 'rgba32float']
            : [blend ? 'rgba16float' : transportFormat],
          renderState: {
            depthWriteEnabled: false,
            depthCompare: 'always',
            ...(blend ? { blend: MODE0_SCENE_BLEND } : {}),
          },
        },
      },
      {
        kind: 'graphics-bindings',
        name: `${name}.view`,
        program: `${name}.pipeline`,
        values: { group: 0, view: true },
      },
      {
        kind: 'graphics-bindings',
        name: `${name}.inputs`,
        program: `${name}.pipeline`,
        values: {
          group: 1,
          fullscreen: true,
          shader: name,
          input: inputs[0] ?? '',
          depth: 'depth',
          additionalTextures: inputs.slice(1),
        },
      },
    ],
    passes: [
      // Reconstruction synthesizes neutral history in shader when there is no accepted page.
      {
        kind: 'raster',
        name,
        colorAttachments: targets.map((target) => ({
          target,
          ...(reconstruct ? cloudMode0Clear(target, ueDepthKm) : {}),
          loadOp: blend ? 'load' : 'clear',
          storeOp: 'store',
        })),
        sampledTargets: [...inputs, 'depth'],
        draws: [
          {
            program: `${name}.pipeline`,
            bindings: [`${name}.view`, `${name}.inputs`],
            vertexData: [],
            vertexLayout: 'none',
            draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
          },
        ],
      },
    ],
  };
}

function removeObsoleteHistory(
  states: Map<string, CloudHistoryState<ResourceStamp>>,
  data: FrameData,
): void {
  for (const [id, state] of states) {
    const view = data.views.find((entry) => entry.identity === id);
    if (
      view === undefined ||
      (view.render
        ? data.layers[id] === undefined
        : view.frame !== undefined && view.frame.cloudLayer === undefined)
    ) {
      invalidateCloudHistory(state);
      states.delete(id);
    }
  }
}

function inspectUnavailableViews(
  states: Map<string, CloudHistoryState<ResourceStamp>>,
  unavailable: ReadonlyMap<string, string>,
  context: RenderFeaturePlanContext,
): Record<string, CloudLayerInspection> {
  const inspection: Record<string, CloudLayerInspection> = Object.create(null);
  for (const [id, reason] of unavailable) {
    const state = states.get(id);
    if (state !== undefined) {
      invalidateCloudHistory(state);
      states.delete(id);
    }
    inspection[id] = inspectCloudLayer({
      authored: true,
      capability: cloudCapabilitiesFromRhi(context.caps),
      unavailableReason: reason,
    });
  }
  return inspection;
}

function mode0TargetSize(
  plannedView: RenderFeaturePlanContext['views'][number],
  facts: RenderFeatureExtractView | undefined,
) {
  const transportFormat =
    plannedView.targets.find((target) => target.name === 'motion-output')?.format === 'rgba32float'
      ? 'rgba32float'
      : 'rgba16float';
  const width =
    plannedView.frame.width ?? facts?.frameSize?.width ?? facts?.frame?.view?.width ?? 1;
  const height =
    plannedView.frame.height ?? facts?.frameSize?.height ?? facts?.frame?.view?.height ?? 1;

  return { transportFormat, width, height } as const;
}

function prepareViewHistory(
  states: Map<string, CloudHistoryState<ResourceStamp>>,
  id: string,
): CloudHistoryState<ResourceStamp> {
  let state = states.get(id);
  if (state === undefined) {
    state = createCloudHistoryState<ResourceStamp>();
    states.set(id, state);
  }
  // Replanning revokes the old candidate before a successor can be admitted.
  if (state.prepared !== undefined) abortCloudHistory(state, state.prepared);
  return state;
}

function atomicMode0Plan(works: readonly RenderFeatureWork[]): RenderFeaturePlan {
  const grouped = new Map<string, RenderFeatureWork>();
  for (const work of works) {
    const key = work.scope === 'frame' ? 'frame' : `view:${work.scope.view}`;
    const previous = grouped.get(key);
    grouped.set(
      key,
      previous === undefined
        ? work
        : {
            ...previous,
            resources: [...previous.resources, ...work.resources],
            passes: [...previous.passes, ...work.passes],
          },
    );
  }
  return {
    work: [...grouped.values()].map((work) => ({ ...work, submission: 'atomic' as const })),
  };
}

function mode0Receipt(
  context: RenderFeaturePlanContext,
  plannedView: RenderFeaturePlanContext['views'][number],
  facts: RenderFeatureExtractView | undefined,
  id: string,
  state: CloudHistoryState<ResourceStamp>,
  candidate: CloudHistoryCandidate<ResourceStamp>,
  layer: ExtractedCookedCloudLayer,
): Pending {
  const matrix = Array.from(
    facts?.selectedView?.viewProjection ??
      plannedView.selectedView?.viewProjection ??
      new Float32Array(16),
  );
  return {
    view: id,
    state,
    candidate,
    resource: { matrix, frameNumber: context.frame.frameNumber, phase: candidate.phase },
    tracePass: layer.status === 'analytic' ? SkyPass.cloudAnalyticTrace : SkyPass.cloudSampledTrace,
  };
}

function isMode0ProbeLayer(layer: ExtractedCookedCloudLayer): boolean {
  return layer.status === 'sampled' && (layer.diagnostic[0] === 1 || layer.diagnostic[0] === 2);
}

/** Mode 0 uses the Renderer-owned half-resolution ping-pong targets and submit fence. */
export function createMode0CloudFeature(
  recordAdoption?: (frameNumber: number, view: string, adoption: CloudRecordedAdoption) => void,
): RenderFeature<FrameData> {
  const traceFeature = createAnalyticCloudFeature();
  const states = new Map<string, CloudHistoryState<ResourceStamp>>();
  const pending = new WeakMap<FrameData, readonly Pending[]>();
  return {
    identity: traceFeature.identity,
    inactiveSourceData: INACTIVE_CLOUD_FRAME,
    placement: 'scene',
    extract(context) {
      const layers = traceFeature.extract(context).value;
      // Frameless held views can retain accepted history. An explicitly cloud-free
      // source can omit its publication row and invalidate all remaining history.
      const canRetainHistory = context.views.some(
        (view) =>
          view.frame?.cloudLayer !== undefined || (!view.render && view.frame === undefined),
      );
      if (!canRetainHistory) return ok(INACTIVE_CLOUD_FRAME);
      return ok({ layers, inspection: {}, views: context.views });
    },
    requiresPreparation: (data) => Object.keys(data.layers).length > 0,
    plan(data, context) {
      removeObsoleteHistory(states, data);
      if (data === INACTIVE_CLOUD_FRAME) return ok({ work: [] });
      const base = traceFeature.plan(data.layers, context);
      if (!base.ok) return base;
      data.inspection = inspectUnavailableViews(states, base.value.unavailable, context);
      const works: RenderFeatureWork[] = [];
      const receipts: Pending[] = [];
      for (const work of base.value.work) {
        if (typeof work.scope !== 'object' || !('view' in work.scope)) {
          works.push(work);
          continue;
        }
        const id = work.scope.view;
        if (
          !work.passes.some(
            (pass) =>
              pass.name === SkyPass.cloudSampledTrace || pass.name === SkyPass.cloudAnalyticTrace,
          )
        ) {
          works.push(work);
          continue;
        }
        const layer = data.layers[id];
        const facts = data.views.find((view) => view.identity === id);
        const plannedView = context.views.find((view) => view.identity === id);
        if (layer === undefined || plannedView === undefined) continue;
        const { transportFormat, width, height } = mode0TargetSize(plannedView, facts);
        const ueDepthKm = plannedView.targets.some(
          (target) => target.name === 'cloud-mode0-trace-depth' && target.format === 'rgba16float',
        );
        const blendIntoScene =
          ueDepthKm &&
          plannedView.targets.some(
            ({ name, format, sampleCount }) =>
              name === 'motion-input' && format === 'rgba16float' && sampleCount === 1,
          );
        const state = prepareViewHistory(states, id);
        const candidate = prepareCloudHistory(
          state,
          cloudHistoryStamp(layer, facts, id, width, height, context.generation, ueDepthKm),
        );
        const receipt = mode0Receipt(context, plannedView, facts, id, state, candidate, layer);
        receipts.push(receipt);
        data.inspection = {
          ...data.inspection,
          [id]: cloudMode0Inspection(layer, candidate, id, context),
        };
        const mode0 = [candidate.pixelOffset[0], candidate.pixelOffset[1], width, height];
        const useDepthRange = mode0DepthRangeAvailable(layer, plannedView, context);
        const trace = mode0TraceWork(work, layer, mode0, transportFormat, useDepthRange, ueDepthKm);
        works.push(trace);
        if (isMode0ProbeLayer(layer)) {
          // The full-resolution probe has its own entry and input layout.
          works.push(
            mode0ProbeWork(
              work,
              mode0TraceWork(work, layer, mode0, transportFormat, false).resources,
            ),
          );
        }
        const previousMatrix = candidate.history?.resource.matrix ?? receipt.resource.matrix;
        const params = new Uint8Array(
          new Float32Array([
            ...previousMatrix,
            ...mode0,
            candidate.history === undefined ? 0 : 1,
            candidate.stamp.exposure,
            candidate.history?.stamp.exposure ?? 1,
            5000,
          ]).buffer,
        );
        for (const stage of ['reconstruct', 'compose'] as const) {
          const source = context.getFeatureShaderSource?.(`forgeax::cloud-mode0-${stage}`);
          if (source === undefined) {
            for (const receipt of receipts) abortCloudHistory(receipt.state, receipt.candidate);
            return err(
              new CloudLayerResourceFailureError({
                stage: 'view',
                generation: context.generation,
                cause: `Missing cooked Mode 0 ${stage} shader`,
              }),
            );
          }
          works.push(
            mode0StageWork(
              stage,
              source,
              layer,
              params,
              id,
              transportFormat,
              ueDepthKm,
              blendIntoScene,
            ),
          );
        }
      }
      pending.set(data, receipts);
      return ok(atomicMode0Plan(works));
    },
    onFrameSubmitted(data, submission) {
      for (const receipt of pending.get(data) ?? []) {
        const submittedDraw = (name: string) =>
          submission?.works.some(
            (work) =>
              typeof work.scope === 'object' &&
              'view' in work.scope &&
              work.scope.view === receipt.view &&
              work.passes.some(
                (pass) => pass.name === name && (pass.graphics?.draws.length ?? 0) > 0,
              ),
          ) === true;
        const submitted = [
          receipt.tracePass,
          SkyPass.cloudReconstruction,
          SkyPass.cloudResolve,
        ].every(submittedDraw);
        if (submitted && acceptCloudHistory(receipt.state, receipt.candidate, receipt.resource)) {
          const layer = data.layers[receipt.view];
          if (recordAdoption !== undefined && layer?.adoption !== undefined) {
            const adoption = captureCloudAdoption(
              layer,
              data.views.find((view) => view.identity === receipt.view),
              submittedDraw(SkyPass.cloudShadow),
            );
            if (adoption !== undefined)
              recordAdoption(receipt.resource.frameNumber, receipt.view, adoption);
          }
          const inspection = data.inspection[receipt.view];
          if (inspection?.mode0 !== undefined)
            data.inspection = {
              ...data.inspection,
              [receipt.view]: {
                ...inspection,
                resourceStage: 'accepted',
                candidateGeneration: undefined,
                mode0: {
                  ...inspection.mode0,
                  historyValid: true,
                  acceptedFrame: receipt.resource.frameNumber,
                  acceptedPhase: receipt.resource.phase,
                },
              },
            };
        } else abortCloudHistory(receipt.state, receipt.candidate);
      }
      pending.delete(data);
    },
    onFrameAborted(data) {
      for (const receipt of pending.get(data) ?? []) {
        abortCloudHistory(receipt.state, receipt.candidate);
        const inspection = data.inspection[receipt.view];
        if (inspection?.mode0 !== undefined)
          data.inspection = {
            ...data.inspection,
            [receipt.view]: {
              ...inspection,
              resourceStage: receipt.state.accepted === undefined ? 'none' : 'accepted',
              candidateGeneration: undefined,
              mode0: {
                ...inspection.mode0,
                historyValid: receipt.state.accepted !== undefined,
                acceptedFrame: receipt.state.accepted?.resource.frameNumber,
                acceptedPhase: receipt.state.accepted?.resource.phase,
              },
            },
          };
      }
      pending.delete(data);
    },
  };
}
