import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  RenderPipeline,
  Sampler,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
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
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { pmremExtent } from '../ibl/pmrem';
import type { RenderExtent } from '../pipeline/render-extent';
import { type ProbeBackgroundResources, recordProbeBackground } from '../reflection/background';
import { addPmremArrayMigrations, type PmremArrayMigration } from '../reflection/pmrem-array';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { WATER_SSR_PARAMS_BYTES } from '../ssr/history';
import {
  CLOUD_HISTORY_FORMATS,
  getTemporalGpuState,
  TEMPORAL_HISTORY_FORMATS,
  temporalReadIndex,
  temporalWriteIndex,
} from '../temporal/gpu';
import { recordContext } from '../world/view-record-context';
import { buildPerFrameBindGroups } from './frame-lighting';
import type { RenderFrameState } from './frame-snapshot';
import { encodeMainPass } from './main-pass';
import { resolveReflectionProbeAtmosphereBindings } from './reflection-probe-atmosphere-bindings';
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
    const internal = frame as _InternalRenderPipelineContext;
    const state = getTemporalGpuState(
      internal.frameState,
      internal.runtime.device,
      recordContext(internal.runtime).deviceScope,
      frame.targetW,
      frame.targetH,
      true,
      frame.camera,
      isTemporalAntialias(internal.camera.antialias)
        ? internal.camera.antialias === 'tsr'
          ? 'tsr'
          : 'taa'
        : 'scene-color',
    );
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

function importSsrHistoryTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  role: 'read' | 'write',
  extent: RenderExtent | undefined,
  surface = false,
  storage = true,
  water = false,
  previousExtent?: { readonly width: number; readonly height: number },
): import('../render-pipeline').RenderPipelineTarget {
  const resolveSurface = (frame: RenderPipelineFrame) => {
    const internal = frame as import('./render-context')._InternalRenderPipelineContext;
    const owner = water
      ? internal.frameState.waterSsrHistoryOwner
      : internal.frameState.ssrHistoryOwner;
    const candidate = owner?.candidate;
    if (owner === undefined || candidate === undefined) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'SSR history candidate to be staged before graph execution',
        hint: 'begin the SSR history candidate before executing the admitted graph',
      });
    }
    const slot =
      role === 'read'
        ? (candidate.readSlot ?? (candidate.writeSlot === 0 ? 1 : 0))
        : candidate.writeSlot;
    const resolved = (role === 'read' ? candidate.previousResources : owner.resources).slots[slot];
    if (resolved === undefined)
      throw new Error('SSR history slot is outside the admitted resource cohort');
    return resolved;
  };
  const texture = graph.importTexture(
    label,
    {
      format: surface ? 'rgba8unorm' : 'rgba16float',
      size:
        role === 'read' && previousExtent !== undefined
          ? { width: previousExtent.width, height: previousExtent.height }
          : extent === undefined
            ? 'surface'
            : {
                width: extent.internalWidth,
                height: extent.internalHeight,
              },
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        (storage ? GPU_TEXTURE_USAGE_STORAGE_BINDING : 0) |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      domain: 'linear-hdr',
    },
    (frame) => {
      const slot = resolveSurface(frame);
      if (!surface) return slot.texture;
      if (slot.profile === 'opaque') return slot.surfaceTexture;
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'opaque SSR surface history',
        hint: 'Water history stores only reflected RGBA',
      });
    },
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d' },
    (frame) => {
      const slot = resolveSurface(frame);
      if (!surface) return slot.view;
      if (slot.profile === 'opaque') return slot.surfaceView;
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'opaque SSR surface history',
        hint: 'Water history stores only reflected RGBA',
      });
    },
  );
  if (!view.ok) throw view.error;
  return {
    texture: texture.value,
    view: view.value,
    format: surface ? 'rgba8unorm' : 'rgba16float',
    sampleCount: 1,
    domain: 'linear-hdr',
  };
}

export function importSsrHistoryTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  extent: RenderExtent | undefined,
  storage: boolean,
  water: true,
  previousExtent?: { readonly width: number; readonly height: number },
): NonNullable<
  NonNullable<
    import('../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>['waterSsr']
  >['temporal']
>;

export function importSsrHistoryTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  extent: RenderExtent | undefined,
  storage: boolean,
  water?: false,
  previousExtent?: { readonly width: number; readonly height: number },
): NonNullable<
  import('../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>['ssrHistory']
>;

export function importSsrHistoryTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  extent: RenderExtent | undefined,
  storage: boolean,
  water = false,
  previousExtent?: { readonly width: number; readonly height: number },
): NonNullable<
  | import('../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>['ssrHistory']
  | NonNullable<
      import('../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>['waterSsr']
    >['temporal']
> {
  const prefix = water ? 'water-' : '';
  const shared = {
    previous: importSsrHistoryTarget(
      graph,
      `${prefix}ssr-history-previous`,
      'read',
      extent,
      false,
      storage,
      water,
      previousExtent,
    ),
    output: importSsrHistoryTarget(
      graph,
      `${prefix}ssr-history-output`,
      'write',
      extent,
      false,
      storage,
      water,
    ),
    params: (() => {
      const imported = graph.importBuffer(
        `${prefix}ssr-history-params`,
        { size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
        (frame) => {
          const internal = frame as import('./render-context')._InternalRenderPipelineContext;
          const owner = water
            ? internal.frameState.waterSsrHistoryOwner
            : internal.frameState.ssrHistoryOwner;
          if (owner === undefined) {
            throw new RhiError({
              code: 'rhi-not-available',
              expected: 'SSR history owner to be staged before graph execution',
              hint: 'create the renderer-owned SSR history before executing the admitted graph',
            });
          }
          return owner.resources.paramsBuffer;
        },
      );
      if (!imported.ok) throw imported.error;
      return imported.value;
    })(),
  };
  if (!water) {
    return {
      ...shared,
      previousSurface: importSsrHistoryTarget(
        graph,
        'ssr-history-previous-surface',
        'read',
        extent,
        true,
        storage,
      ),
      outputSurface: importSsrHistoryTarget(
        graph,
        'ssr-history-output-surface',
        'write',
        extent,
        true,
        storage,
      ),
    };
  }
  return shared;
}

export function importWaterSsrInputParams(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): import('@forgeax/engine-render-graph').GraphBuffer {
  const inputParams = graph.importBuffer(
    'water-ssr-input-params',
    { size: WATER_SSR_PARAMS_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
    (frame) => {
      const buffer = (frame as _InternalRenderPipelineContext).frameState.ssrHistoryOwner?.resources
        .waterParamsBuffer;
      if (buffer === undefined) {
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'Water SSR input parameters staged before execution',
          hint: 'begin the Water SSR history candidate before executing its trace',
        });
      }
      return buffer;
    },
  );
  if (!inputParams.ok) throw inputParams.error;
  return inputParams.value;
}

/** Borrow accepted scene color; both producer shapes use the same submission owner. */
export function importSsrSceneColorHistoryTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  frameState: RenderFrameState,
  width: number,
  height: number,
): RenderPipelineTarget {
  const accepted = frameState.activeTemporalGpuState;
  const resolve = (frame: RenderPipelineFrame) => {
    const internal = frame as _InternalRenderPipelineContext;
    const active = internal.frameState.activeTemporalGpuState;
    const state =
      active?.device === internal.runtime.device
        ? active
        : getTemporalGpuState(
            internal.frameState,
            internal.runtime.device,
            recordContext(internal.runtime).deviceScope,
            frame.targetW,
            frame.targetH,
            false,
            internal.camera,
            isTemporalAntialias(internal.camera.antialias)
              ? internal.camera.antialias === 'tsr'
                ? 'tsr'
                : 'taa'
              : 'scene-color',
          );
    return state.color[temporalReadIndex(state)];
  };
  const texture = graph.importTexture(
    'ssr-hit-color-history',
    {
      format: 'rgba16float',
      size: { width: accepted?.width ?? width, height: accepted?.height ?? height },
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      domain: 'linear-hdr',
    },
    (frame) => resolve(frame).texture,
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { dimension: '2d', label: 'ssr-hit-color-history.view' },
    (frame) => resolve(frame).view,
  );
  if (!view.ok) throw view.error;
  return {
    texture: texture.value,
    view: view.value,
    format: 'rgba16float',
    sampleCount: 1,
    domain: 'linear-hdr',
  };
}

export function importSsrSceneColorOutput(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
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
  const texture = graph
    .importTexture(
      'ssr-scene-color-output',
      {
        format: 'rgba16float',
        size: 'surface',
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
      { label: 'ssr-scene-color-output.view', dimension: '2d' },
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
  Record<string, import('@forgeax/engine-render-graph').GraphTextureView>,
  RenderGraphError
> {
  const frozen = work.atmosphere;
  const frozenViews: Record<string, import('@forgeax/engine-render-graph').GraphTextureView> = {};
  if (frozen !== undefined) {
    for (const [name, width, height, layers, mips, usage] of [
      ['sky', 128, 128, 6, 1, 0x14],
      ['irradiance', 16, 16, 6, 1, 0x14],
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
  }
  return ok(frozenViews);
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
    const frozenViews = tables.value;
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
                captureShadows.spot.view,
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
          ...(environmentCube === undefined
            ? []
            : [environmentCube.sky, environmentCube.irradiance, environmentCube.prefilter].map(
                (resource) => ({ resource, usage: 'sampled-read' as const }),
              )),
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
                  : resources.textureView(captureShadows.spot.view).unwrap(),
            },
            true,
            internal.standardLighting,
          );
          const requireEnvironmentCube = () => {
            if (environmentCube === undefined) throw new Error('Missing capture environment cube');
            return environmentCube;
          };
          const captureContext = {
            ...internal,
            viewBindGroup: capturedGroups.viewBindGroup,
            ...(environmentCube === undefined && frozen === undefined
              ? {}
              : {
                  environmentIbl: {
                    irradiance:
                      frozen === undefined
                        ? resources.textureView(requireEnvironmentCube().irradiance).unwrap()
                        : captured('irradiance'),
                    prefilter:
                      frozen === undefined
                        ? resources.textureView(requireEnvironmentCube().prefilter).unwrap()
                        : captured('prefilter'),
                  },
                }),
          };
          delete captureContext.reflectionProbes;
          delete captureContext.hdrpSsaoBlurredView;
          delete captureContext.gpuDrivenSelection;
          delete captureContext.gpuDrivenStandardPbrFrameResources;
          encodeMainPass(
            {
              ...captureContext,
              dispatch: internal.dispatch,
              foldDispatchPlan: null,
              camera: work.faceCamera,
              viewBindGroupDynamicOffset: work.viewBindGroupDynamicOffset,
              transparentColorFormat: work.outputFormat as GPUTextureFormat,
              msaaActive: false,
              splitLdrSprite: false,
            },
            pass,
            undefined,
            {
              colorFormats: [work.outputFormat as GPUTextureFormat],
              passKind: 'forward',
            },
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
