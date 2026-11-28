import type {
  GraphAccess,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { PlanarCapture } from '../capture/planar-state';
import { planarReflectionLevels } from '../capture/planar-target';
import { addAtmosphereBackground } from '../environment/background';
import { atmosphereAccesses, atmosphereVolumeViews } from '../environment/luts';
import { atmosphereStorage } from '../environment/storage';
import { RenderTargetDescriptorInvalidError } from '../errors/render';
import { addGraphColorMipPasses } from '../graph-color-mips';
import { analyticFogSampleCountError } from '../pipeline/analytic-fog-pass';
import type { StandardClusterGraphBuffers } from '../pipeline/standard-lighting/graph';
import { cameraAdmitsLayers } from '../render-layers';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenProjection } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { FORWARD_PASS_SELECTOR } from '../systems/pass-selector';
import {
  type RenderTarget,
  renderTargetLayerCount,
  renderTargetMipCount,
} from '../targets/contracts';
import { resolveRenderTargetMaterialSource } from '../targets/material-source';
import { type RenderTargetPhysical, renderTargetMipPhysical } from '../targets/physical';
import { isCanvasTextureSource } from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import type { TransmissionBackdropMipEncoder } from '../transmission/backdrop';
import type { TypedShadowTargets } from '../typed-shadow-passes';
import { addCaptureFaceFeaturePasses } from './capture-face-features';
import { buildPerFrameBindGroups } from './frame-lighting';
import { encodeMainPass, type MainPassOptions } from './main-pass';
import type { _InternalRenderPipelineContext, RenderSystemInternals } from './render-context';
import { type CaptureScenePasses, registerScenePass, scenePassContext } from './scene-pass-work';
import { selectForwardFragmentEntry } from './standard-opaque-entry';
import type { ReflectionProbeGraphState } from './typed-frame-graph';

export interface CubeCaptureGraphWork {
  readonly write?: import('../render-contract').RenderTargetWrite;
  readonly mipLevel?: number;
  readonly sceneInput?: true;
  /** The Feature that requested this scene input; absent for every other face. */
  readonly featureIdentity?: string;
  readonly candidateGeneration?: number;
  readonly target: RenderTarget;
  /** Cube face, array layer, or 3D depth slice written by this work item. */
  readonly layer: number;
  readonly physical: RenderTargetPhysical;
  readonly faceCamera: import('../render-contract').CameraSnapshot;
  /** Feature work the face records after its scene passes; set by `render-capture-schedule`. */
  feature?: CaptureFaceFeatureWork | undefined;
}

/** The sealed Feature plans of one capture face (see `capture/feature-policy`). */
export interface CaptureFaceFeatureWork {
  readonly executions: readonly import('../features/host').RenderFeaturePlanExecution[];
  readonly plans: readonly import('../features/plan').RenderFeaturePlannedFrame[];
}

export interface CubeCaptureGraphState {
  work: readonly CubeCaptureGraphWork[];
  /** Device views claimed by active writers. The capture batch releases unclaimed ordinals. */
  lightingViews?: import('./target-capture-lighting').CaptureLightingViews;
  atmosphere?: boolean;
  reflectionProbes?: ReflectionProbeGraphState;
  planar?: import('../capture/planar-state').PlanarCaptureState;
  /** The engine-owned mirror target of a targetless PlanarReflection. */
  planarTarget?: import('../capture/planar-target').PlanarTargetLease;
}

/** Whether a material binds `target` as a sampled texture source. */
export function materialSamplesTarget(
  material: Pick<import('../render-system-extract').MaterialSnapshot, 'textureSources'>,
  target: RenderTarget,
): boolean {
  if (material.textureSources === undefined) return false;
  for (const source of material.textureSources.values()) {
    if (
      source.source !== 'feature' &&
      !isCanvasTextureSource(source) &&
      !isExternalTextureSource(source) &&
      resolveRenderTargetMaterialSource(source)?.target === target
    )
      return true;
  }
  return false;
}

/** Captures hold the same face visibility used by their queued passes until receipt settlement. */
export function capturePresentation(
  writes: readonly Pick<CubeCaptureGraphWork, 'faceCamera' | 'target' | 'write'>[],
) {
  if (!writes.length) return undefined;
  type Visibility = (row: RenderableSnapshot) => boolean;
  const faces = writes.map(({ faceCamera, target, write }) => ({
    camera: faceCamera,
    target,
    clearOnly: write?.clearOnly === true,
    visible: undefined as Visibility | undefined,
  }));
  return {
    observe(eye: CubeCaptureGraphWork['faceCamera'], visible: Visibility | undefined) {
      for (const face of faces) if (face.camera === eye) face.visible = visible;
    },
    admits(row: RenderableSnapshot, material: RenderableSnapshot['material']) {
      return faces.some(
        (face) =>
          !face.clearOnly &&
          cameraAdmitsLayers(face.camera, row) &&
          face.visible?.(row) !== false &&
          !materialSamplesTarget(material.snapshot, face.target),
      );
    },
  };
}

/** Exclude only the submitted material bindings that sample this writer's destination. */
function captureDispatch(
  internal: ReturnType<typeof scenePassContext>,
  target: RenderTarget,
  write: CubeCaptureGraphWork['write'],
) {
  let feedback: Map<number, Set<number>> | undefined;
  let index = 0;
  let lastSlot = -1;
  let samplesTarget = false;
  for (const row of internal.validatedOrdered) {
    const slots = internal.materialSlotIndices.at(index++);
    if (slots === undefined) continue;
    for (const slot of slots) {
      const material = internal.materialSlots[slot];
      if (material === undefined) throw new Error('Capture has no submitted material');
      if (slot !== lastSlot) {
        samplesTarget = materialSamplesTarget(material, target);
        lastSlot = slot;
      }
      if (!samplesTarget) continue;
      if (write !== undefined)
        throw new RenderTargetDescriptorInvalidError({
          field: 'targetWrite',
          value: target,
          expected: 'no sampled feedback from the destination target',
        });
      feedback ??= new Map();
      let handles = feedback.get(row.renderableIndex);
      if (handles === undefined) {
        handles = new Set();
        feedback.set(row.renderableIndex, handles);
      }
      handles.add(material.materialHandle ?? 0);
    }
  }
  if (feedback === undefined) return internal.dispatch;
  const excluded = feedback;
  return internal.dispatch.filter(
    (entry) => !excluded.get(entry.renderableIndex)?.has(entry.materialHandle),
  );
}

/** The face recorder consumes the current submitted rows, target and physical bindings. */
export function encodeCaptureScenePass(
  pass: RhiRenderPassEncoder,
  internal: _InternalRenderPipelineContext,
  face: CubeCaptureGraphWork,
  descriptor: RenderTargetPhysical['descriptor'],
  options: MainPassOptions,
  keepGpuMaterials: boolean,
  groups?: ReturnType<typeof buildPerFrameBindGroups>,
  environmentIbl?: _InternalRenderPipelineContext['environmentIbl'],
  capturedAtmosphere?: _InternalRenderPipelineContext['capturedAtmosphere'],
): void {
  const dispatch = captureDispatch(internal, face.target, face.write);
  // The main pass reads an empty dispatch as "no roster" and draws
  // every row. When the exclusion removed all of them, no CPU row
  // participates: a row sampling this target is a same-pass
  // attachment/binding conflict that invalidates the whole submission.
  const excludedEveryRow = dispatch.length === 0 && internal.dispatch.length > 0;
  const captureContext = {
    ...internal,
    ...groups,
    ...(environmentIbl === undefined ? {} : { environmentIbl }),
    ...(capturedAtmosphere === undefined ? {} : { capturedAtmosphere }),
    camera: face.faceCamera,
    planarReflectionAllowed: false,
    targetW: descriptor.width,
    targetH: descriptor.height,
    dispatch,
    ...(excludedEveryRow ? { validatedOrdered: [] } : {}),
    foldDispatchPlan: null,

    // Cube faces are raw scene captures, not display-camera HDR output.
    // Select the PSO against the actual target attachment so an LDR
    // cube target is rendered by a compatible forward pipeline.
    tonemapActive: false,
    skyboxActive: false,
    transparentColorFormat: face.physical.descriptor.format as GPUTextureFormat,
    msaaActive: face.physical.descriptor.sampleCount === 4,
    viewBindGroupDynamicOffset: 0,
    splitLdrSprite: false,
  };
  delete captureContext.planarReflectionView;
  delete captureContext.planarReflectionPhysical;
  delete captureContext.gpuDrivenSelection;
  if (!keepGpuMaterials) delete captureContext.gpuDrivenStandardPbrFrameResources;
  encodeMainPass(captureContext, pass, FORWARD_PASS_SELECTOR, options);
}

function captureShadowReads(shadows: TypedShadowTargets | undefined): GraphAccess[] {
  if (shadows === undefined) return [];
  const targets = [shadows.directional, shadows.spot, shadows.point];
  return targets.flatMap((target) =>
    target === undefined ? [] : [{ resource: target.view, usage: 'sampled-read' as const }],
  );
}

function importCaptureColor(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  initial: CubeCaptureGraphWork,
  current: () => CubeCaptureGraphWork,
  attachment: RenderTargetPhysical,
  label: string,
  slot: number,
  mipUsage: number,
) {
  const descriptor = attachment.descriptor;
  const mip = initial.mipLevel ?? 0;
  const volume = descriptor.shape === '3d';
  const msaa = descriptor.sampleCount === 4;
  const layers = renderTargetLayerCount(descriptor);
  const texture = builder.importTexture(
    `${label}.${slot}.texture`,
    {
      format: descriptor.format,
      size: {
        width: msaa ? descriptor.width : initial.physical.descriptor.width,
        height: msaa ? descriptor.height : initial.physical.descriptor.height,
        depthOrArrayLayers: msaa ? 1 : layers,
      },
      mipLevelCount: msaa ? 1 : renderTargetMipCount(initial.physical.descriptor),
      sampleCount: descriptor.sampleCount,
      dimension: volume ? '3d' : '2d',
      usage: 0x10 | 0x04 | 0x01 | (msaa ? 0 : mipUsage),
    },
    () => attachment.colorTextures[current().layer] ?? initial.physical.texture,
  );
  if (!texture.ok) return texture;
  const color = builder.importView(
    texture.value,
    {
      label: `${label}.${slot}.color`,
      dimension: volume ? '3d' : '2d',
      baseMipLevel: msaa ? 0 : mip,
      mipLevelCount: 1,
      baseArrayLayer: msaa || volume ? 0 : initial.layer,
      arrayLayerCount: 1,
    },
    () =>
      attachment.layerViews[current().layer] ??
      attachment.layerViews[initial.layer] ??
      initial.physical.view,
  );
  if (!color.ok) return color;
  return ok({ texture, color });
}

function importCaptureResolve(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  initial: CubeCaptureGraphWork,
  current: () => CubeCaptureGraphWork,
  attachment: RenderTargetPhysical,
  label: string,
  slot: number,
  mipUsage: number,
) {
  const descriptor = attachment.descriptor;
  const mip = initial.mipLevel ?? 0;
  const msaa = descriptor.sampleCount === 4;
  const layers = renderTargetLayerCount(descriptor);
  const resolveTexture = msaa
    ? builder.importTexture(
        `${label}.${slot}.resolve-texture`,
        {
          format: descriptor.format,
          size: {
            width: initial.physical.descriptor.width,
            height: initial.physical.descriptor.height,
            depthOrArrayLayers: layers,
          },
          mipLevelCount: renderTargetMipCount(initial.physical.descriptor),
          sampleCount: 1,
          dimension: '2d',
          usage: 0x10 | 0x04 | 0x01 | mipUsage,
        },
        () =>
          current().physical.resolveTexture ??
          initial.physical.resolveTexture ??
          initial.physical.texture,
      )
    : undefined;
  if (resolveTexture !== undefined && !resolveTexture.ok) return resolveTexture;
  const resolve =
    resolveTexture === undefined
      ? undefined
      : builder.importView(
          resolveTexture.value,
          {
            label: `${label}.${slot}.resolve`,
            dimension: '2d',
            baseMipLevel: mip,
            mipLevelCount: 1,
            baseArrayLayer: initial.layer,
            arrayLayerCount: 1,
          },
          () =>
            attachment.resolveLayerViews[current().layer] ??
            attachment.resolveLayerViews[initial.layer] ??
            initial.physical.resolveView,
        );
  if (resolve !== undefined && !resolve.ok) return resolve;
  return ok({ texture: resolveTexture?.value, view: resolve?.value });
}

/**
 * Capture face passes. Without `view` a face belongs to another recording's
 * camera and draws its retained rows directly. With `view` the face camera is
 * the recording view itself (a capture view): its rows are culled for that
 * camera, its opaque GPU-lane rows are drawn indirectly by the view's own
 * production, and the face publishes the view's shadow evidence.
 *
 * `encodeMip` downsamples one level; with it a planar mirror that generates
 * mipmaps fills its chain after the face, before any receiver samples it.
 */
export function addTargetCaptureGraphPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  state: CubeCaptureGraphState,
  lighting?: {
    readonly shadows: TypedShadowTargets;
    readonly accesses: readonly GraphAccess[];
    readonly clusters?: StandardClusterGraphBuffers | null;
  },
  view?: { readonly gpuDriven: RenderPipelineGpuDrivenProjection | undefined },
  encodeMip?: TransmissionBackdropMipEncoder,
  scenePasses?: CaptureScenePasses,
): Result<GraphTextureView | undefined, RenderGraphError | import('../errors/render').RenderError> {
  const gpuDriven = view?.gpuDriven;
  if (
    state.atmosphere === true &&
    state.work.some((work) => work.physical.descriptor.sampleCount !== 1)
  )
    return err(analyticFogSampleCountError());
  let planarView: GraphTextureView | undefined;
  for (let index = 0; index < state.work.length; index += 1) {
    const slot = index;
    const initial = state.work[slot];
    if (initial === undefined) continue;
    const label = captureLabel(initial);
    const current = (): CubeCaptureGraphWork => state.work[slot] ?? initial;
    const selected = renderTargetMipPhysical(initial.physical, initial.mipLevel ?? 0);
    if (!selected.ok) return err(selected.error);
    const attachment = selected.value;
    const descriptor = attachment.descriptor;
    const colorFormats = [descriptor.format];
    const volume = descriptor.shape === '3d';
    const { levels: mipLevels, usage: mipUsage } = planarMipPlan(encodeMip, initial, descriptor);
    const colorAttachment = importCaptureColor(
      builder,
      initial,
      current,
      attachment,
      label,
      slot,
      mipUsage,
    );
    if (!colorAttachment.ok) return colorAttachment;
    const { texture, color } = colorAttachment.value;
    const depthTexture = builder.importTexture(
      `${label}.${slot}.depth-texture`,
      {
        format: 'depth32float-stencil8',
        size: { width: descriptor.width, height: descriptor.height, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: descriptor.sampleCount,
        dimension: '2d',
        usage: 0x10 | (initial.physical.sampledDepth ? 0x04 : 0),
      },
      () => attachment.depthTexture,
    );
    if (!depthTexture.ok) return depthTexture;
    const depth = builder.importView(
      depthTexture.value,
      {
        label: `${label}.${slot}.depth`,
        dimension: '2d',
        baseArrayLayer: 0,
        arrayLayerCount: 1,
      },
      () => attachment.depthView,
    );
    if (!depth.ok) return depth;
    const resolveAttachment = importCaptureResolve(
      builder,
      initial,
      current,
      attachment,
      label,
      slot,
      mipUsage,
    );
    if (!resolveAttachment.ok) return resolveAttachment;
    const { texture: resolveTexture, view: resolve } = resolveAttachment.value;
    if (initial.faceCamera.planarReflection !== undefined) planarView = resolve ?? color.value;
    const environment =
      state.atmosphere === true && initial.sceneInput !== true
        ? addAtmosphereBackground(
            builder,
            {
              texture: texture.value,
              view: color.value,
              format: initial.physical.descriptor.format,
              sampleCount: initial.physical.descriptor.sampleCount,
            },
            { directional: lighting?.shadows.directional?.view },
            {
              mode: 'full',
              clusters: lighting?.clusters,
            },
          )
        : undefined;
    if (environment !== undefined && !environment.ok) return environment;
    const atmosphere = environment?.value.atmosphere;
    const recordModes =
      initial.sceneInput === true ? (['opaque'] as const) : (['opaque', 'transparent'] as const);
    const requests = (initial.write?.clearOnly ? [] : recordModes).map((recordMode) => {
      const gpu = gpuDriven !== undefined && recordMode === 'opaque';
      return registerScenePass(
        builder,
        (view === undefined && state.work.length === 1 ? scenePasses?.[recordMode] : undefined) ?? {
          selector: FORWARD_PASS_SELECTOR,
          excludeSelector: undefined,
          recordMode,
          passKind: 'forward',
          gpu,
          gpuFilter: gpu ? 'opaque' : undefined,
          late: false,
          capture: view === undefined,
          camera: () => current().faceCamera,
        },
      );
    });
    const gpuFragmentEntry = selectForwardFragmentEntry({
      passKind: 'forward',
      fragmentEntry: undefined,
      oitAccumulate: false,
      viewOffset: 0,
      atmosphereCapture: atmosphere !== undefined,
    });
    gpuDriven?.registerPipelinePreparation?.([descriptor.format], 'opaque', gpuFragmentEntry);
    const added = builder.addRasterPass(`${label}-face.${slot}`, {
      accesses: [
        ...(lighting?.accesses ?? []),
        ...(atmosphere === undefined ? [] : atmosphereAccesses(atmosphere)),
        ...(environment === undefined
          ? []
          : [
              { resource: environment.value.skySh, usage: 'uniform-read' as const },
              { resource: environment.value.prefilter, usage: 'sampled-read' as const },
            ]),
        ...captureShadowReads(lighting?.shadows),
        ...(gpuDriven?.accesses ?? []),
        { resource: color.value, usage: 'color-attachment' },
        { resource: depth.value, usage: 'depth-stencil-write' },
        ...(resolve === undefined
          ? []
          : [{ resource: resolve, usage: 'color-attachment' as const }]),
      ],
      colorAttachments: [
        {
          view: color.value,
          ...(resolve === undefined ? {} : { resolveTarget: resolve }),
          ...(volume ? { depthSlice: initial.layer } : {}),
          loadOp:
            initial.write !== undefined && !initial.write.clearColor
              ? 'load'
              : environment === undefined
                ? 'clear'
                : 'load',
          storeOp: 'store',
          clearValue: () => {
            const clear =
              current().physical.descriptor.shape === 'cube' && current().write === undefined
                ? [0, 0, 0, 1]
                : current().faceCamera.clearColor;
            return { r: clear[0] ?? 0, g: clear[1] ?? 0, b: clear[2] ?? 0, a: clear[3] ?? 1 };
          },
        },
      ],
      depthStencilAttachment: {
        view: depth.value,
        depthClearValue: 0,
        depthLoadOp: initial.write !== undefined && !initial.write.clearDepth ? 'load' : 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp:
          initial.write !== undefined && !initial.write.clearStencil ? 'load' : 'clear',
        stencilStoreOp: 'store',
      },
      encodeDirect: (pass, frame, resources) => {
        const captureFaceOptions = (request: (typeof requests)[number]): MainPassOptions => {
          const gpu = gpuDriven !== undefined && request.gpu;
          return {
            colorFormats,
            passKind: 'forward',
            ...(request.recordMode === undefined ? {} : { recordMode: request.recordMode }),
            ...(gpu && gpuDriven !== undefined
              ? {
                  gpuDriven: { projection: gpuDriven, resources },
                  gpuDrivenFilter: 'opaque' as const,
                }
              : {}),
          };
        };
        for (const request of requests) {
          const internal = scenePassContext(frame as _InternalRenderPipelineContext, request);
          const face = current();
          const resolveShadow = (
            target: import('../render-pipeline').RenderPipelineTarget | undefined,
          ) => {
            if (target === undefined) return undefined;
            const view = resources.textureView(target.view);
            if (!view.ok) throw view.error;
            return view.value;
          };
          if (view !== undefined && lighting !== undefined) {
            const directional = resolveShadow(lighting.shadows.directional);
            const spot = resolveShadow(lighting.shadows.spot);
            if (directional !== undefined)
              internal.frameState.frameOutputs.directionalShadowView = directional;
            if (spot !== undefined) internal.frameState.frameOutputs.spotShadowView = spot;
          }
          const groups =
            lighting === undefined
              ? undefined
              : buildPerFrameBindGroups(
                  internal.runtime as RenderSystemInternals,
                  internal.frameState,
                  internal.pipelineState,
                  internal.validatedOrdered.length > 0 || gpuDriven !== undefined,
                  internal.bindGroupCounts,
                  {
                    atmosphere: atmosphereVolumeViews(resources, atmosphere),
                    directionalShadow: resolveShadow(lighting.shadows.directional),
                    spotShadow: resolveShadow(lighting.shadows.spot),
                  },
                  true,
                  internal.standardLighting,
                );
          encodeCaptureScenePass(
            pass,
            internal,
            face,
            descriptor,
            captureFaceOptions(request),
            gpuDriven !== undefined,
            groups,
            environment === undefined
              ? undefined
              : {
                  skySh: resources.buffer(environment.value.skySh).unwrap(),
                  prefilter: resources.textureView(environment.value.prefilter).unwrap(),
                },
            view === undefined || atmosphere === undefined ? undefined : atmosphereStorage(frame),
          );
        }
      },
    });
    const featured = addCaptureFaceFeaturePasses(builder, added, {
      work: initial,
      color: color.value,
      colorTexture: texture.value,
      depth: depth.value,
      depthTexture: depthTexture.value,
      lighting,
    });
    if (!featured.ok) return featured;
    const mipped = addGraphColorMipPasses(
      builder,
      `${label}.${slot}`,
      resolveTexture ?? texture.value,
      descriptor,
      mipLevels,
      encodeMip,
      planarView,
      initial.physical.device.caps.backendKind,
    );
    if (!mipped.ok) return mipped;
    planarView = mipped.value;
  }
  const retained = state.planar?.current();
  if (planarView === undefined && retained !== undefined) {
    const imported = importRetainedPlanarView(builder, state, retained);
    if (!imported.ok) return imported;
    planarView = imported.value;
  }
  return ok(planarView);
}

/** Import the previous planar mirror when this frame's update interval skipped the capture. */
function importRetainedPlanarView(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  state: CubeCaptureGraphState,
  retained: PlanarCapture,
): Result<GraphTextureView, RenderGraphError> {
  return importPlanarCaptureView(
    builder,
    retained.physical.descriptor,
    () => (state.planar?.current() ?? retained).physical,
  );
}

export function importPlanarCaptureView(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  descriptor: RenderTargetPhysical['descriptor'],
  current: (frame: RenderPipelineFrame) => RenderTargetPhysical,
): Result<GraphTextureView, RenderGraphError> {
  const texture = builder.importTexture(
    'planar-reflection.retained',
    {
      format: descriptor.format,
      size: { width: descriptor.width, height: descriptor.height },
      mipLevelCount: renderTargetMipCount(descriptor),
      sampleCount: 1,
      dimension: '2d',
      usage: 0x10 | 0x04 | 0x01,
    },
    (frame) => {
      const physical = current(frame);
      return physical.resolveTexture ?? physical.texture;
    },
  );
  if (!texture.ok) return texture;
  return builder.importView(
    texture.value,
    { dimension: '2d' },
    (frame) => current(frame).resolveView,
  );
}

export function captureLabel(work: CubeCaptureGraphWork): string {
  if (work.sceneInput) return 'feature-scene-depth';
  return work.faceCamera.planarReflection === undefined ? 'cube-capture' : 'planar-reflection';
}

/** A planar mirror's mip levels and any backend-required copy destination usage. */
function planarMipPlan(
  encodeMip: TransmissionBackdropMipEncoder | undefined,
  work: CubeCaptureGraphWork,
  descriptor: RenderTargetPhysical['descriptor'],
): { readonly levels: number; readonly usage: number } {
  const levels =
    encodeMip === undefined
      ? 1
      : planarReflectionLevels(work.physical.device, work.faceCamera.planarReflection, descriptor);
  // WebGPU writes disjoint mip attachments; WebGL2 copies back from scratch.
  return {
    levels,
    usage: levels > 1 && work.physical.device.caps.backendKind === 'wgpu-webgl2' ? 0x02 : 0,
  };
}
