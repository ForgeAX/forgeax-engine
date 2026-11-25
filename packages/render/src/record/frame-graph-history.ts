import type {
  GraphAccess,
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  RenderPipeline,
  Sampler,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { CloudTransportFormat } from '../cloud/reconstruction/history';
import { isTemporalAntialias } from '../components/camera';
import { addAtmosphereBackground } from '../environment/background';
import { recordAtmosphereCaptureBackground } from '../environment/capture';
import { motionBlurTemporalDemand } from '../features/motion-blur/motion-blur-params';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { pmremExtent } from '../ibl/pmrem';
import { SKY_SH_BYTES } from '../ibl/sky-sh';
import { type ProbeBackgroundResources, recordProbeBackground } from '../reflection/background';
import { addPmremArrayMigrations, type PmremArrayMigration } from '../reflection/pmrem-array';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import {
  fullSsrColorViewport,
  ssrColorExtent,
  writeSsrColorViewport,
} from '../ssr/scene-color-input';
import { WATER_SSR_DEFAULT_PROFILE, WATER_SSR_PARAMS_BYTES } from '../ssr/water-profile';
import {
  CLOUD_HISTORY_FORMATS,
  getTemporalGpuState,
  stageTemporalGpuWrite,
  TEMPORAL_HISTORY_FORMATS,
  temporalReadIndex,
  temporalWriteIndex,
} from '../temporal/gpu';
import { recordContext } from '../world/view-record-context';
import { buildPerFrameBindGroups } from './frame-lighting';
import type { RenderFrameState } from './frame-snapshot';
import { resolveReflectionProbeAtmosphereBindings } from './reflection-probe-atmosphere-bindings';
import { encodeProbeFaceDraws } from './reflection-probe-face';
import { addReflectionProbePmremPasses } from './reflection-probe-pmrem';

import type { _InternalRenderPipelineContext, RenderSystemInternals } from './render-context';

import { type CaptureScenePasses, registerScenePass, scenePassContext } from './scene-pass-work';

function importTemporalHistoryTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  kind: 'color' | 'temporal' | 'stability' | 'flicker',
  role: 'read' | 'write',
  algorithm: 'taa' | 'tsr',
  compute: boolean,
): import('../render-pipeline').RenderPipelineTarget {
  const format =
    algorithm === 'tsr' && kind === 'stability' ? 'rgba8unorm' : TEMPORAL_HISTORY_FORMATS[kind];
  const resolveSurface = (frame: RenderPipelineFrame) => {
    const internal = frame as import('./render-context')._InternalRenderPipelineContext;
    const state = getTemporalGpuState(
      internal.frameState,
      internal.runtime.device,
      recordContext(internal.runtime).deviceScope,
      frame.targetW,
      frame.targetH,
      false,
      frame.camera,
    );
    const index = role === 'read' ? temporalReadIndex(state) : temporalWriteIndex(state);
    const pair = state[kind];
    if (pair === undefined) throw new Error(`temporal ${kind} history resolved for ${algorithm}`);
    return pair[index];
  };
  const texture = graph.importTexture(
    algorithm === 'tsr' ? label.replace('taa-', 'tsr-') : label,
    {
      format,
      size: 'surface',
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING |
        (algorithm === 'tsr' && compute ? GPU_TEXTURE_USAGE_STORAGE_BINDING : 0),
    },
    (frame) => resolveSurface(frame).texture,
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d' },
    (frame) => resolveSurface(frame).view,
  );
  if (!view.ok) throw view.error;
  return { texture: texture.value, view: view.value, format, sampleCount: 1 };
}

export function importTemporalHistoryTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  algorithm: 'taa' | 'tsr',
  compute: boolean,
): NonNullable<
  import('../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>['taaHistory']
> {
  return {
    currentColor: importTemporalHistoryTarget(
      graph,
      'taa-history-current-color',
      'color',
      'write',
      algorithm,
      compute,
    ),
    currentStability: importTemporalHistoryTarget(
      graph,
      'taa-history-current-stability',
      'stability',
      'write',
      algorithm,
      compute,
    ),
    previousStability: importTemporalHistoryTarget(
      graph,
      'taa-history-previous-stability',
      'stability',
      'read',
      algorithm,
      compute,
    ),
    previousColor: importTemporalHistoryTarget(
      graph,
      'taa-history-previous-color',
      'color',
      'read',
      algorithm,
      compute,
    ),
    currentTemporal: importTemporalHistoryTarget(
      graph,
      'taa-history-current-temporal',
      'temporal',
      'write',
      algorithm,
      compute,
    ),
    previousTemporal: importTemporalHistoryTarget(
      graph,
      'taa-history-previous-temporal',
      'temporal',
      'read',
      algorithm,
      compute,
    ),
    ...(algorithm === 'taa'
      ? {
          currentFlicker: importTemporalHistoryTarget(
            graph,
            'taa-history-current-flicker',
            'flicker',
            'write',
            algorithm,
            compute,
          ),
          previousFlicker: importTemporalHistoryTarget(
            graph,
            'taa-history-previous-flicker',
            'flicker',
            'read',
            algorithm,
            compute,
          ),
        }
      : {}),
  };
}

type CloudHistoryKind = keyof typeof CLOUD_HISTORY_FORMATS;

function cloudHistorySurface(
  state: import('../temporal/gpu').TemporalGpuState,
  kind: CloudHistoryKind,
  index: 0 | 1,
): { readonly texture: Texture; readonly view: TextureView } {
  if (!state.cloudHistoryEnabled) {
    throw new Error('cloud history target resolved without a cloud-enabled temporal state');
  }
  switch (kind) {
    case 'radiance':
      if (state.cloudRadiance === undefined)
        throw new Error('cloud radiance history is unavailable');
      return state.cloudRadiance[index];
    case 'transmittance':
      if (state.cloudTransmittance === undefined)
        throw new Error('cloud transmittance history is unavailable');
      return state.cloudTransmittance[index];
    case 'depth':
      if (state.cloudDepth === undefined) throw new Error('cloud depth history is unavailable');
      return state.cloudDepth[index];
  }
}

function cloudHistoryState(frame: _InternalRenderPipelineContext) {
  return getTemporalGpuState(
    frame.frameState,
    frame.runtime.device,
    recordContext(frame.runtime).deviceScope,
    frame.targetW,
    frame.targetH,
    true,
    frame.camera,
    isTemporalAntialias(frame.camera.antialias)
      ? frame.camera.antialias === 'tsr'
        ? 'tsr'
        : 'taa'
      : 'scene-color',
  );
}

/** Stage the same ping-pong state that backs the imported cloud attachments. */
export function stageCloudHistoryWrite(frame: _InternalRenderPipelineContext): void {
  stageTemporalGpuWrite(frame.frameState, cloudHistoryState(frame));
}

/** Import one renderer-owned cloud history attachment into the typed graph. */
function importCloudHistoryTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  kind: CloudHistoryKind,
  role: 'read' | 'write',
  transportFormat: CloudTransportFormat,
): import('../render-pipeline').RenderPipelineTarget {
  const format = kind === 'depth' ? CLOUD_HISTORY_FORMATS.depth : transportFormat;
  const resolveSurface = (frame: RenderPipelineFrame) => {
    const state = cloudHistoryState(frame as _InternalRenderPipelineContext);
    const index = role === 'read' ? temporalReadIndex(state) : temporalWriteIndex(state);
    return cloudHistorySurface(state, kind, index);
  };
  const texture = graph.importTexture(
    label,
    {
      format,
      // Cloud transport/history is intentionally half-resolution. The
      // renderer-owned temporal state allocates the same ceil(width/2) extent
      // and the full-resolution resolve reconstructs scene colour from it.
      size: 'half-surface',
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      domain: 'linear-hdr',
    },
    (frame) => resolveSurface(frame).texture,
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d' },
    (frame) => resolveSurface(frame).view,
  );
  if (!view.ok) throw view.error;
  return { texture: texture.value, view: view.value, format, sampleCount: 1 };
}

export function importCloudHistoryTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  transportFormat: CloudTransportFormat,
): NonNullable<
  import('../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>['cloudHistory']
> {
  return {
    currentRadiance: importCloudHistoryTarget(
      graph,
      'cloud-history-radiance-current',
      'radiance',
      'write',
      transportFormat,
    ),
    previousRadiance: importCloudHistoryTarget(
      graph,
      'cloud-history-radiance-previous',
      'radiance',
      'read',
      transportFormat,
    ),
    currentTransmittance: importCloudHistoryTarget(
      graph,
      'cloud-history-transmittance-current',
      'transmittance',
      'write',
      transportFormat,
    ),
    previousTransmittance: importCloudHistoryTarget(
      graph,
      'cloud-history-transmittance-previous',
      'transmittance',
      'read',
      transportFormat,
    ),
    currentDepth: importCloudHistoryTarget(
      graph,
      'cloud-history-depth-current',
      'depth',
      'write',
      transportFormat,
    ),
    previousDepth: importCloudHistoryTarget(
      graph,
      'cloud-history-depth-previous',
      'depth',
      'read',
      transportFormat,
    ),
  };
}

export function importWaterSsrInputParams(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): GraphBuffer {
  const params = graph
    .createBuffer('water-ssr-input-params', { size: WATER_SSR_PARAMS_BYTES })
    .unwrap();
  const payload = new Float32Array(WATER_SSR_PARAMS_BYTES / 4);
  const values = new DataView(payload.buffer);
  graph
    .addCopyPass('water-ssr-input-params-upload', {
      accesses: [{ resource: params, usage: 'copy-dst' }],
      encodeDirect: (_encoder, frame, resources) => {
        const internal = frame as _InternalRenderPipelineContext;
        const { activeTemporalGpuState: history, temporalView } = internal.frameState;
        const temporal = isTemporalAntialias(internal.camera.antialias);
        const valid =
          temporal &&
          history?.valid === true &&
          history.device === frame.runtime.device &&
          history.mode === internal.camera.antialias &&
          history.width === frame.targetW &&
          history.height === frame.targetH &&
          temporalView.accepted?.input.historyVersion === internal.camera.historyVersion;
        const colorSize = ssrColorExtent({ width: frame.targetW, height: frame.targetH });
        writeSsrColorViewport(values, 32, fullSsrColorViewport(colorSize.width, colorSize.height));
        payload.set([Number(valid), 1, WATER_SSR_DEFAULT_PROFILE.intensity, 0], 16);
        frame.runtime.device.queue
          .writeBuffer(resources.buffer(params).unwrap(), 0, payload)
          .unwrap();
      },
    })
    .unwrap();
  return params;
}

/** Borrow accepted scene color; both producer shapes use the same submission owner. */
export function importSsrSceneColorHistoryTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  frameState: RenderFrameState,
  width: number,
  height: number,
  sceneColorOnly = false,
): Result<RenderPipelineTarget, RenderGraphError> {
  const accepted = frameState.activeTemporalGpuState;
  const size = sceneColorOnly
    ? { width, height }
    : { width: accepted?.width ?? width, height: accepted?.height ?? height };
  const halfSize = ssrColorExtent(size);
  const mipLevelCount = 1;
  const resolve = (frame: RenderPipelineFrame) => {
    const internal = frame as _InternalRenderPipelineContext;
    const active = internal.frameState.activeTemporalGpuState;
    const mode = sceneColorOnly
      ? 'scene-color'
      : internal.camera.antialias === 'tsr'
        ? 'tsr'
        : 'taa';
    const state =
      active?.device === internal.runtime.device &&
      active.mode === mode &&
      active.width === size.width &&
      active.height === size.height
        ? active
        : getTemporalGpuState(
            internal.frameState,
            internal.runtime.device,
            recordContext(internal.runtime).deviceScope,
            frame.targetW,
            frame.targetH,
            false,
            internal.camera,
            mode,
          );
    return state.color[temporalReadIndex(state)];
  };
  const texture = graph.importTexture(
    sceneColorOnly ? 'ssr-hit-color-history' : 'ssr-temporal-color-history',
    {
      format: 'rgba16float',
      size: sceneColorOnly ? halfSize : size,
      mipLevelCount,
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      domain: 'linear-hdr',
    },
    (frame) => resolve(frame).texture,
  );
  if (!texture.ok) return texture;
  const viewDescriptor = {
    dimension: '2d',
    label: sceneColorOnly ? 'ssr-hit-color-history.view' : 'ssr-temporal-color-history.view',
    mipLevelCount,
  } as const;
  const view = graph.importView(texture.value, viewDescriptor, (frame) => resolve(frame).view);
  if (!view.ok) return view;
  const history = {
    texture: texture.value,
    view: view.value,
    format: 'rgba16float',
    sampleCount: 1,
    domain: 'linear-hdr',
  } as const;
  return ok(history);
}

export function importSsrSceneColorOutput(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  width: number,
  height: number,
): RenderPipelineTarget {
  const resolve = (frame: RenderPipelineFrame) => {
    const internal = frame as _InternalRenderPipelineContext;
    const state = getTemporalGpuState(
      internal.frameState,
      internal.runtime.device,
      recordContext(internal.runtime).deviceScope,
      frame.targetW,
      frame.targetH,
      false,
      internal.camera,
      'scene-color',
    );
    return state.color[temporalWriteIndex(state)];
  };
  const size = ssrColorExtent({ width, height });
  const texture = graph
    .importTexture(
      'ssr-scene-color-output',
      {
        format: 'rgba16float',
        size,
        mipLevelCount: 1,
        usage:
          GPU_TEXTURE_USAGE_COPY_SRC |
          GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
          GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        domain: 'linear-hdr',
      },
      (frame) => resolve(frame).texture,
    )
    .unwrap();
  const view = graph
    .importView(
      texture,
      { label: 'ssr-scene-color-output.view', dimension: '2d', mipLevelCount: 1 },
      (frame) => resolve(frame).view,
    )
    .unwrap();
  return { texture, view, format: 'rgba16float', sampleCount: 1, domain: 'linear-hdr' };
}

export function shouldUseTemporalFrameTransaction(
  antialias: CameraSnapshot['antialias'],
  temporalDemand = false,
): boolean {
  return isTemporalAntialias(antialias) || temporalDemand;
}

export function isMotionBlurTemporalDemand(
  motionBlur: CameraSnapshot['motionBlur'] | undefined,
): boolean {
  return (
    motionBlur !== undefined &&
    motionBlurTemporalDemand({
      shutterAngle: motionBlur.shutterAngle,
      maxRadiusPixels: motionBlur.maxRadiusPixels,
      sampleCount: motionBlur.sampleCount,
      targetFps: motionBlur.targetFps ?? 60,
    })
  );
}

export interface ReflectionProbeFilterGraphWork {
  readonly probeIndex: number;
  readonly faceIndex: number;
  readonly mipLevel: number;
}

export interface ReflectionProbeFilterGraphState {
  readonly work: readonly ReflectionProbeFilterGraphWork[];
  readonly maxStepsPerFrame: number;
}

export interface ReflectionProbeGraphWork {
  readonly captureGeneration?: number;
  readonly atmosphere?: import('../environment/storage').AtmosphereStorage | undefined;
  readonly background?: ProbeBackgroundResources;
  readonly probeIndex: number;
  readonly rawTexture: Texture;
  readonly rawCubeView: TextureView;
  readonly rawFaceViews: readonly TextureView[];
  readonly rawDepthTexture: Texture;
  readonly rawCaptureFace: number | undefined;
  readonly rawDepthView: TextureView;
  readonly rawSize: number;
  readonly faceCamera?: import('../render-contract').CameraSnapshot;
  readonly viewBindGroupDynamicOffset?: number;
  readonly filteredTexture: Texture;
  readonly filteredView: TextureView;
  readonly filterScratchTexture: Texture;
  readonly filterScratchView: TextureView;
  readonly outputFormat: TextureFormat;
  readonly sampler: Sampler;
  readonly filterPipeline: RenderPipeline;
  readonly filterGroup0: readonly BindGroup[] | undefined;
  readonly filterGroup1: BindGroup;
  readonly filteredSize: number;
  readonly filteredLayer?: number;
  readonly filteredArrayLayers?: number;
  readonly filteredGeneration?: number;
  readonly step: ReflectionProbeFilterGraphWork | undefined;
}

export interface ReflectionProbeGraphState {
  readonly work: readonly ReflectionProbeGraphWork[];
  readonly migrations?: readonly PmremArrayMigration[] | undefined;
}

export function boundedReflectionProbeFilterWork(
  state: ReflectionProbeFilterGraphState,
): readonly ReflectionProbeFilterGraphWork[] {
  return state.work.slice(0, Math.max(0, state.maxStepsPerFrame));
}

/** Import the retained medium generation rather than the live display generation. */
function importProbeAtmosphereTables(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  work: ReflectionProbeGraphWork,
  clusters:
    | import('../pipeline/standard-lighting/graph').StandardClusterGraphBuffers
    | null
    | undefined,
): Result<
  { readonly views: Record<string, GraphTextureView>; readonly skySh?: GraphBuffer },
  RenderGraphError
> {
  const frozen = work.atmosphere;
  const frozenViews: Record<string, import('@forgeax/engine-render-graph').GraphTextureView> = {};
  if (frozen === undefined) return ok({ views: frozenViews });
  for (const [name, width, height, layers, mips, usage] of [
    ['sky', 128, 128, 6, 1, 0x14],
    ['prefilter', 336, 256, 1, 1, 0x17],
    ['distantSkyLight', 1, 1, 1, 1, 0x0c],
    ['transmittance', 256, 64, 1, 1, 0x0c],
    ['multipleScattering', 32, 32, 1, 1, 0x0c],
  ] as const) {
    const texture = builder.importTexture(
      `reflection-probe.${work.probeIndex}.atmosphere.${name}`,
      {
        format: 'rgba16float',
        size: { width, height, depthOrArrayLayers: layers },
        mipLevelCount: mips,
        usage: clusters?.kind === 'texture' ? (usage & ~0x08) | 0x10 : usage,
      },
      () => frozen[name],
    );
    if (!texture.ok) return texture;
    const view = builder.view(texture.value, { dimension: layers === 6 ? 'cube' : '2d' });
    if (!view.ok) return view;
    frozenViews[name] = view.value;
  }
  const skySh = builder.importBuffer(
    `reflection-probe.${work.probeIndex}.sky-sh`,
    { size: SKY_SH_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM },
    () => frozen.skySh,
  );
  return skySh.ok ? ok({ views: frozenViews, skySh: skySh.value }) : skySh;
}

function probeEnvironmentAccesses(
  skySh: GraphBuffer | undefined,
  environment: import('../environment/ibl').GraphEnvironment | undefined,
): GraphAccess[] {
  const reads: GraphAccess[] = [];
  const uniform = skySh ?? environment?.skySh;
  if (uniform !== undefined) reads.push({ resource: uniform, usage: 'uniform-read' });
  if (environment !== undefined)
    reads.push(
      { resource: environment.sky, usage: 'sampled-read' },
      { resource: environment.prefilter, usage: 'sampled-read' },
    );
  return reads;
}

function importReflectionProbeTargets(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  work: ReflectionProbeGraphWork,
) {
  const raw = builder.importTexture(
    `reflection-probe.${work.probeIndex}.raw`,
    {
      format: work.outputFormat,
      size: { width: work.rawSize, height: work.rawSize, depthOrArrayLayers: 6 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      usage: 0x10 | 0x04 | 0x01,
    },
    () => work.rawTexture,
  );
  if (!raw.ok) return raw;
  const rawCube = builder.importView(
    raw.value,
    {
      label: `reflection-probe.${work.probeIndex}.raw-cube`,
      dimension: 'cube',
      arrayLayerCount: 6,
    },
    () => work.rawCubeView,
  );
  if (!rawCube.ok) return rawCube;
  const filtered = builder.importTexture(
    `reflection-probe.${work.probeIndex}.filtered`,
    {
      format: work.outputFormat,
      size: {
        ...pmremExtent(work.filteredSize),
        depthOrArrayLayers: work.filteredArrayLayers ?? 1,
      },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      usage: 0x10 | 0x04 | 0x01,
    },
    () => work.filteredTexture,
  );
  if (!filtered.ok) return filtered;
  const filteredAtlas = builder.importView(
    filtered.value,
    {
      label: `reflection-probe.${work.probeIndex}.filtered-atlas`,
      dimension: '2d',
      baseArrayLayer: work.filteredLayer ?? 0,
      arrayLayerCount: 1,
    },
    () => work.filteredView,
  );
  if (!filteredAtlas.ok) return filteredAtlas;
  return ok({
    raw: raw.value,
    rawCube: rawCube.value,
    filtered: filtered.value,
    filteredAtlas: filteredAtlas.value,
  });
}

export function addReflectionProbeGraphPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  state: ReflectionProbeGraphState,
  environmentCube?: import('../environment/ibl').GraphEnvironment,
  captureShadows?: import('../typed-shadow-passes').TypedShadowTargets,
  clusters?: import('../pipeline/standard-lighting/graph').StandardClusterGraphBuffers | null,
  scenePasses?: CaptureScenePasses,
): Result<readonly import('@forgeax/engine-render-graph').GraphAccess[], RenderGraphError> {
  const accesses: import('@forgeax/engine-render-graph').GraphAccess[] = [];
  const migrated = addPmremArrayMigrations(builder, state.migrations ?? []);
  if (!migrated.ok) return migrated;
  for (const work of state.work) {
    const frozen = work.atmosphere;
    const tables = importProbeAtmosphereTables(builder, work, clusters);
    if (!tables.ok) return tables;
    const { views: frozenViews, skySh: frozenSkySh } = tables.value;
    const targets = importReflectionProbeTargets(builder, work);
    if (!targets.ok) return targets;
    const { raw, rawCube, filtered, filteredAtlas } = targets.value;
    if (work.rawCaptureFace !== undefined) {
      const face = work.rawCaptureFace;
      const view = builder.importView(
        raw,
        {
          label: `reflection-probe.${work.probeIndex}.capture-face-${face}`,
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
        },
        () => work.rawFaceViews[face] as TextureView,
      );
      if (!view.ok) return view;
      const depthTexture = builder.importTexture(
        `reflection-probe.${work.probeIndex}.capture-depth`,
        {
          format: 'depth32float-stencil8',
          size: { width: work.rawSize, height: work.rawSize, depthOrArrayLayers: 1 },
          mipLevelCount: 1,
          sampleCount: 1,
          dimension: '2d',
          usage: 0x10,
        },
        () => work.rawDepthTexture,
      );
      if (!depthTexture.ok) return depthTexture;
      const depth = builder.importView(
        depthTexture.value,
        { label: `reflection-probe.${work.probeIndex}.capture-depth-view`, dimension: '2d' },
        () => work.rawDepthView,
      );
      if (!depth.ok) return depth;
      const atmosphereBackground = captureShadows !== undefined && frozen !== undefined;
      if (atmosphereBackground) {
        const prepared = addAtmosphereBackground(
          builder,
          { texture: raw, view: view.value, format: work.outputFormat, sampleCount: 1 },
          { directional: captureShadows.directional?.view },
          { mode: 'full', clusters },
        );
        if (!prepared.ok) return prepared;
      }
      const request = registerScenePass(
        builder,
        (state.work.length === 1 ? scenePasses?.probe : undefined) ?? {
          selector: undefined,
          excludeSelector: undefined,
          recordMode: undefined,
          passKind: 'forward',
          gpu: false,
          gpuFilter: undefined,
          late: false,
          capture: true,
          camera: () => work.faceCamera,
        },
      );
      const added = builder.addRasterPass(`reflection-probe.${work.probeIndex}.capture.${face}`, {
        accesses: [
          ...(captureShadows === undefined
            ? []
            : [
                captureShadows.directional?.view,
                captureShadows.spot?.view,
                captureShadows.point?.view,
              ]
                .filter(
                  (resource): resource is import('@forgeax/engine-render-graph').GraphTextureView =>
                    resource !== undefined,
                )
                .map((resource) => ({ resource, usage: 'sampled-read' as const }))),
          ...Object.values(frozenViews).map((resource) => ({
            resource,
            usage: 'sampled-read' as const,
          })),
          ...probeEnvironmentAccesses(frozenSkySh, environmentCube),
          { resource: view.value, usage: 'color-attachment' },
          { resource: depth.value, usage: 'depth-stencil-write' },
        ],
        colorAttachments: [
          {
            view: view.value,
            loadOp: atmosphereBackground ? 'load' : 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
        depthStencilAttachment: {
          view: depth.value,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'store',
        },
        encodeDirect: (pass, frame, resources) => {
          const internal = scenePassContext(frame as _InternalRenderPipelineContext, request);
          if (work.faceCamera === undefined || work.viewBindGroupDynamicOffset === undefined)
            return;
          const captured = (name: string) => {
            const view = frozenViews[name];
            if (view === undefined) throw new Error(`Missing frozen atmosphere view: ${name}`);
            return resources.textureView(view).unwrap();
          };
          if (frozen !== undefined && captureShadows === undefined) {
            recordAtmosphereCaptureBackground(
              frame,
              pass,
              work.outputFormat,
              work.viewBindGroupDynamicOffset,
              captured('transmittance'),
              captured('transmittance'),
              captured('multipleScattering'),
            );
          } else if (frozen === undefined) {
            recordProbeBackground(
              work.background,
              internal,
              work.faceCamera,
              pass,
              environmentCube === undefined
                ? undefined
                : resources.textureView(environmentCube.sky).unwrap(),
            );
          }
          const captureViews =
            frozen === undefined
              ? undefined
              : resolveReflectionProbeAtmosphereBindings(
                  {
                    atmosphereAvailable: internal.pipelineState.atmosphereAvailable === true,
                    atmosphereFallbackView: internal.pipelineState.atmosphereFallbackView,
                  },
                  () => ({
                    distantSkyLight: captured('distantSkyLight'),
                    transmittance: captured('transmittance'),
                    multipleScattering: captured('multipleScattering'),
                  }),
                );
          const capturedGroups = buildPerFrameBindGroups(
            internal.runtime as RenderSystemInternals,
            internal.frameState,
            internal.pipelineState,
            true,
            internal.bindGroupCounts,
            {
              atmosphere: captureViews,
              directionalShadow:
                captureShadows?.directional === undefined
                  ? (internal.frameState.frameOutputs.directionalShadowView ?? undefined)
                  : resources.textureView(captureShadows.directional.view).unwrap(),
              spotShadow:
                captureShadows === undefined
                  ? (internal.frameState.frameOutputs.spotShadowView ?? undefined)
                  : captureShadows.spot === undefined
                    ? undefined
                    : resources.textureView(captureShadows.spot.view).unwrap(),
            },
            true,
            internal.standardLighting,
          );
          const requireEnvironmentCube = () => {
            if (environmentCube === undefined) throw new Error('Missing capture environment cube');
            return environmentCube;
          };
          const environmentIbl =
            environmentCube === undefined && frozen === undefined
              ? internal.environmentIbl
              : {
                  skySh: resources.buffer(frozenSkySh ?? requireEnvironmentCube().skySh).unwrap(),
                  prefilter:
                    frozen === undefined
                      ? resources.textureView(requireEnvironmentCube().prefilter).unwrap()
                      : captured('prefilter'),
                };
          encodeProbeFaceDraws(
            internal,
            pass,
            work.faceCamera,
            work.viewBindGroupDynamicOffset,
            work.outputFormat,
            capturedGroups.viewBindGroup,
            environmentIbl,
          );
        },
      });
      if (!added.ok) return added;
    }
    const filteredStep = addReflectionProbePmremPasses(
      builder,
      work,
      rawCube,
      filtered,
      filteredAtlas,
    );
    if (!filteredStep.ok) return filteredStep;
    accesses.push({ resource: filteredAtlas, usage: 'sampled-read' });
  }
  return ok(accesses);
}
