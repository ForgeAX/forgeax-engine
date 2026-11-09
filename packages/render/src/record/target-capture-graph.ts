import type {
  GraphAccess,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, mipDimension, ok, type Result } from '@forgeax/engine-types';
import type { PlanarCapture } from '../capture/planar-state';
import { planarReflectionLevels } from '../capture/planar-target';
import { addAtmosphereBackground } from '../environment/background';
import { atmosphereStorage } from '../environment/storage';
import { analyticFogSampleCountError } from '../pipeline/analytic-fog-pass';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenProjection } from '../render-pipeline';
import { FORWARD_PASS_SELECTOR } from '../systems/pass-selector';
import {
  type RenderTarget,
  renderTargetLayerCount,
  renderTargetMipCount,
} from '../targets/contracts';
import { resolveRenderTargetMaterialSource } from '../targets/material-source';
import type { RenderTargetPhysical } from '../targets/physical';
import { isCanvasTextureSource } from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import type { TransmissionBackdropMipEncoder } from '../transmission/backdrop';
import type { TypedShadowTargets } from '../typed-shadow-passes';
import { addCaptureFaceFeaturePasses } from './capture-face-features';
import { buildPerFrameBindGroups } from './frame-lighting';
import { encodeMainPass } from './main-pass';
import type { _InternalRenderPipelineContext, RenderSystemInternals } from './render-context';
import { registerScenePass, scenePassContext } from './scene-pass-work';
import { selectForwardFragmentEntry } from './standard-opaque-entry';
import type { ReflectionProbeGraphState } from './typed-frame-graph';

export interface CubeCaptureGraphWork {
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
  for (const source of material.textureSources?.values() ?? []) {
    if (
      !isCanvasTextureSource(source) &&
      !isExternalTextureSource(source) &&
      resolveRenderTargetMaterialSource(source)?.target === target
    )
      return true;
  }
  return false;
}

/** Materials sampling the target cannot participate in that same target write. */
function captureSelfSampling(
  internal: ReturnType<typeof scenePassContext>,
  target: RenderTarget,
): Map<number, Set<number>> {
  const selfSampling = new Map<number, Set<number>>();
  let nextIndex = 0;
  for (const row of internal.validatedOrdered) {
    const index = nextIndex++;
    for (const slot of internal.materialSlotIndices.at(index) ?? []) {
      const material = internal.materialSlots[slot];
      if (material === undefined) throw new Error('Capture has no submitted material');
      if (!materialSamplesTarget(material, target)) continue;
      let handles = selfSampling.get(row.renderableIndex);
      if (handles === undefined) {
        handles = new Set();
        selfSampling.set(row.renderableIndex, handles);
      }
      handles.add(material.materialHandle ?? 0);
    }
  }
  return selfSampling;
}

function captureShadowReads(shadows: TypedShadowTargets | undefined): GraphAccess[] {
  if (shadows === undefined) return [];
  const targets = [shadows.directional, shadows.spot, shadows.moments, shadows.point];
  return targets.flatMap((target) =>
    target === undefined ? [] : [{ resource: target.view, usage: 'sampled-read' as const }],
  );
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
  lighting?: { readonly shadows: TypedShadowTargets; readonly accesses: readonly GraphAccess[] },
  view?: { readonly gpuDriven: RenderPipelineGpuDrivenProjection | undefined },
  encodeMip?: TransmissionBackdropMipEncoder,
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
    const descriptor = initial.physical.descriptor;
    const volume = descriptor.shape === '3d';
    const msaa = descriptor.sampleCount === 4;
    const layers = renderTargetLayerCount(descriptor);
    const { levels: mipLevels, usage: mipUsage } = planarMipPlan(encodeMip, initial, descriptor);
    const texture = builder.importTexture(
      `${label}.${slot}.texture`,
      {
        format: descriptor.format,
        size: {
          width: descriptor.width,
          height: descriptor.height,
          depthOrArrayLayers: msaa ? 1 : layers,
        },
        mipLevelCount: msaa ? 1 : renderTargetMipCount(descriptor),
        sampleCount: descriptor.sampleCount,
        dimension: volume ? '3d' : '2d',
        usage: 0x10 | 0x04 | 0x01 | (msaa ? 0 : mipUsage),
      },
      () => current().physical.colorTextures[current().layer] ?? initial.physical.texture,
    );
    if (!texture.ok) return texture;
    const color = builder.importView(
      texture.value,
      {
        label: `${label}.${slot}.color`,
        dimension: volume ? '3d' : '2d',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: msaa || volume ? 0 : initial.layer,
        arrayLayerCount: 1,
      },
      () =>
        current().physical.layerViews[current().layer] ??
        initial.physical.layerViews[initial.layer] ??
        initial.physical.view,
    );
    if (!color.ok) return color;
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
      () => current().physical.depthTexture,
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
      () => current().physical.depthView,
    );
    if (!depth.ok) return depth;
    const resolveTexture = msaa
      ? builder.importTexture(
          `${label}.${slot}.resolve-texture`,
          {
            format: descriptor.format,
            size: {
              width: descriptor.width,
              height: descriptor.height,
              depthOrArrayLayers: layers,
            },
            mipLevelCount: renderTargetMipCount(descriptor),
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
              baseMipLevel: 0,
              mipLevelCount: 1,
              baseArrayLayer: initial.layer,
              arrayLayerCount: 1,
            },
            () =>
              current().physical.resolveLayerViews[current().layer] ??
              initial.physical.resolveLayerViews[initial.layer] ??
              initial.physical.resolveView,
          );
    if (resolve !== undefined && !resolve.ok) return resolve;
    if (initial.faceCamera.planarReflection !== undefined)
      planarView = resolve?.value ?? color.value;
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
          )
        : undefined;
    if (environment !== undefined && !environment.ok) return environment;
    const atmosphere = environment?.value.atmosphere;
    const recordModes =
      initial.sceneInput === true ? (['opaque'] as const) : (['opaque', 'transparent'] as const);
    const requests = recordModes.map((recordMode) => {
      const gpu = gpuDriven !== undefined && recordMode === 'opaque';
      return registerScenePass(builder, {
        selector: FORWARD_PASS_SELECTOR,
        excludeSelector: undefined,
        recordMode,
        passKind: 'forward',
        gpu,
        gpuFilter: gpu ? 'opaque' : undefined,
        late: false,
        capture: view === undefined,
        camera: () => current().faceCamera,
      });
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
        ...(atmosphere === undefined
          ? []
          : [
              atmosphere.transmittance,
              atmosphere.multipleScattering,
              atmosphere.aerialPerspective,
              atmosphere.aerialTransmittance,
              atmosphere.distantSkyLight,
            ].map((resource) => ({ resource, usage: 'sampled-read' as const }))),
        ...(environment === undefined
          ? []
          : [environment.value.irradiance, environment.value.prefilter].map((resource) => ({
              resource,
              usage: 'sampled-read' as const,
            }))),
        ...captureShadowReads(lighting?.shadows),
        ...(gpuDriven?.accesses ?? []),
        { resource: color.value, usage: 'color-attachment' },
        { resource: depth.value, usage: 'depth-stencil-write' },
        ...(resolve === undefined
          ? []
          : [{ resource: resolve.value, usage: 'color-attachment' as const }]),
      ],
      colorAttachments: [
        {
          view: color.value,
          ...(resolve === undefined ? {} : { resolveTarget: resolve.value }),
          ...(volume ? { depthSlice: initial.layer } : {}),
          loadOp: environment === undefined ? 'clear' : 'load',
          storeOp: 'store',
          clearValue: () => {
            const clear =
              current().physical.descriptor.shape === 'cube'
                ? [0, 0, 0, 1]
                : current().faceCamera.clearColor;
            return { r: clear[0] ?? 0, g: clear[1] ?? 0, b: clear[2] ?? 0, a: clear[3] ?? 1 };
          },
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
        for (const request of requests) {
          const internal = scenePassContext(frame as _InternalRenderPipelineContext, request);
          const selfSampling = captureSelfSampling(internal, current().target);
          const dispatch = internal.dispatch.filter(
            (entry) => !selfSampling.get(entry.renderableIndex)?.has(entry.materialHandle),
          );
          // The main pass reads an empty dispatch as "no roster" and draws
          // every row. When the exclusion removed all of them, no CPU row
          // participates: a row sampling this target is a same-pass
          // attachment/binding conflict that invalidates the whole submission.
          const excludedEveryRow = dispatch.length === 0 && internal.dispatch.length > 0;
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
                    ...(atmosphere === undefined
                      ? {}
                      : {
                          atmosphere: {
                            transmittance: resources.textureView(atmosphere.transmittance).unwrap(),
                            multipleScattering: resources
                              .textureView(atmosphere.multipleScattering)
                              .unwrap(),
                            aerialPerspective: resources
                              .textureView(atmosphere.aerialPerspective)
                              .unwrap(),
                            aerialTransmittance: resources
                              .textureView(atmosphere.aerialTransmittance)
                              .unwrap(),
                            distantSkyLight: resources
                              .textureView(atmosphere.distantSkyLight)
                              .unwrap(),
                          },
                        }),
                    directionalShadow: resolveShadow(lighting.shadows.directional),
                    spotShadow: resolveShadow(lighting.shadows.spot),
                    shadowMoments: resolveShadow(lighting.shadows.moments),
                  },
                  true,
                  internal.standardLighting,
                );
          const gpu = gpuDriven !== undefined && request.gpu;
          const captureContext = {
            ...internal,
            ...(groups === undefined ? {} : groups),
            // A capture view's atmosphere is its own recording storage; the
            // in-shader aerial chain replaces the display's post pass.
            ...(view === undefined || atmosphere === undefined
              ? {}
              : { capturedAtmosphere: atmosphereStorage(frame) }),
            ...(environment === undefined
              ? {}
              : {
                  environmentIbl: {
                    irradiance: resources.textureView(environment.value.irradiance).unwrap(),
                    prefilter: resources.textureView(environment.value.prefilter).unwrap(),
                  },
                }),
            camera: current().faceCamera,
            targetW: current().physical.descriptor.width,
            targetH: current().physical.descriptor.height,
            dispatch,
            ...(excludedEveryRow ? { validatedOrdered: [] } : {}),
            foldDispatchPlan: null,

            // Cube faces are raw scene captures, not display-camera HDR output.
            // Select the PSO against the actual target attachment so an LDR
            // cube target is rendered by a compatible forward pipeline.
            tonemapActive: false,
            skyboxActive: false,
            transparentColorFormat: initial.physical.descriptor.format as GPUTextureFormat,
            msaaActive: initial.physical.descriptor.sampleCount === 4,
            viewBindGroupDynamicOffset: 0,
            splitLdrSprite: false,
          };
          delete captureContext.planarReflectionView;
          delete captureContext.gpuDrivenSelection;
          if (gpuDriven === undefined) delete captureContext.gpuDrivenStandardPbrFrameResources;
          // Each prepared lane uses the capture camera's own sorted draw roster.
          encodeMainPass(captureContext, pass, FORWARD_PASS_SELECTOR, {
            colorFormats: [initial.physical.descriptor.format as GPUTextureFormat],
            passKind: 'forward',
            ...(request.recordMode === undefined ? {} : { recordMode: request.recordMode }),
            ...(gpu && gpuDriven !== undefined
              ? {
                  gpuDriven: { projection: gpuDriven, resources },
                  gpuDrivenFilter: 'opaque' as const,
                }
              : {}),
          });
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
    const mipped = addPlanarMipPasses(
      builder,
      `${label}.${slot}`,
      resolveTexture?.value ?? texture.value,
      descriptor,
      mipLevels,
      encodeMip,
      planarView,
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
  const latest = () => state.planar?.current() ?? retained;
  const texture = builder.importTexture(
    'planar-reflection.retained',
    {
      format: retained.physical.descriptor.format,
      size: {
        width: retained.physical.descriptor.width,
        height: retained.physical.descriptor.height,
      },
      mipLevelCount: renderTargetMipCount(retained.physical.descriptor),
      sampleCount: 1,
      dimension: '2d',
      usage: 0x10 | 0x04 | 0x01,
    },
    () => latest().physical.resolveTexture ?? latest().physical.texture,
  );
  if (!texture.ok) return texture;
  return builder.importView(
    texture.value,
    { dimension: '2d' },
    () => latest().physical.resolveView,
  );
}

/**
 * Fill a planar mirror's mip chain from level 0, then return the full-chain
 * view its receivers sample. Each level renders into scratch and is copied
 * back, as the transmission backdrop does, so no draw samples its own
 * attachment texture (some WebGL2 drivers reject that as a feedback loop).
 */
function addPlanarMipPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  texture: import('@forgeax/engine-render-graph').GraphTexture,
  descriptor: RenderTargetPhysical['descriptor'],
  levels: number,
  encodeMip: TransmissionBackdropMipEncoder | undefined,
  direct: GraphTextureView | undefined,
): Result<GraphTextureView | undefined, RenderGraphError> {
  if (levels <= 1 || encodeMip === undefined) return ok(direct);
  const levelSize = (level: number) => ({
    width: mipDimension(descriptor.width, level),
    height: mipDimension(descriptor.height, level),
  });
  const mipView = (level: number) =>
    builder.view(texture, {
      label: `${label}.mip-${level}`,
      dimension: '2d',
      baseMipLevel: level,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1,
    });
  const scratch = builder.createTexture(`${label}.mip-scratch`, {
    format: descriptor.format,
    size: levelSize(1),
    sampleCount: 1,
    mipLevelCount: levels - 1,
  });
  if (!scratch.ok) return scratch;
  let source = mipView(0);
  if (!source.ok) return source;
  for (let level = 1; level < levels; level += 1) {
    const destination = mipView(level);
    if (!destination.ok) return destination;
    const scratchView = builder.view(scratch.value, {
      label: `${label}.mip-scratch.${level - 1}`,
      baseMipLevel: level - 1,
      mipLevelCount: 1,
    });
    if (!scratchView.ok) return scratchView;
    const from = source.value;
    const mip = builder.addRasterPass(`${label}-mip-${level}`, {
      accesses: [
        { resource: from, usage: 'sampled-read' },
        { resource: scratchView.value, usage: 'color-attachment' },
      ],
      colorAttachments: [
        {
          view: scratchView.value,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      encodeDirect: (pass, frame, resources) =>
        encodeMip({
          pass,
          frame,
          resources,
          source: from,
          destination: scratchView.value,
          format: descriptor.format,
          level,
        }),
    });
    if (!mip.ok) return mip;
    const copied = builder.addCopyPass(`${label}-mip-copy-${level}`, {
      accesses: [
        { resource: scratchView.value, usage: 'copy-src' },
        { resource: destination.value, usage: 'copy-dst' },
      ],
      encodeDirect: (encoder, _frame, resources) => {
        const scratchTexture = resources.texture(scratch.value);
        const target = resources.texture(texture);
        if (!scratchTexture.ok) throw scratchTexture.error;
        if (!target.ok) throw target.error;
        encoder.copyTextureToTexture(
          { texture: scratchTexture.value, mipLevel: level - 1, origin: { x: 0, y: 0, z: 0 } },
          { texture: target.value, mipLevel: level, origin: { x: 0, y: 0, z: 0 } },
          { ...levelSize(level), depthOrArrayLayers: 1 },
        );
      },
    });
    if (!copied.ok) return copied;
    source = destination;
  }
  return builder.view(texture, {
    label: `${label}.mips`,
    dimension: '2d',
    baseMipLevel: 0,
    mipLevelCount: levels,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
}

function captureLabel(work: CubeCaptureGraphWork): string {
  if (work.sceneInput) return 'feature-scene-depth';
  return work.faceCamera.planarReflection === undefined ? 'cube-capture' : 'planar-reflection';
}

/** A planar mirror's mip level count and the extra texture usage its chain copies need. */
function planarMipPlan(
  encodeMip: TransmissionBackdropMipEncoder | undefined,
  work: CubeCaptureGraphWork,
  descriptor: RenderTargetPhysical['descriptor'],
): { readonly levels: number; readonly usage: number } {
  const levels =
    encodeMip === undefined
      ? 1
      : planarReflectionLevels(work.physical.device, work.faceCamera.planarReflection, descriptor);
  // The mip chain is written by copies into the sampled texture.
  return { levels, usage: levels > 1 ? 0x02 : 0 };
}
