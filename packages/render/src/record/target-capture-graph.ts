import type {
  GraphAccess,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { addAtmosphereBackground } from '../environment/background';
import { analyticFogSampleCountError } from '../pipeline/analytic-fog-pass';
import type { RenderPipelineFrame } from '../render-pipeline';
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
import type { TypedShadowTargets } from '../typed-shadow-passes';
import { buildPerFrameBindGroups } from './frame-lighting';
import { encodeMainPass } from './main-pass';
import type { _InternalRenderPipelineContext, RenderSystemInternals } from './render-context';
import { registerScenePass, scenePassContext } from './scene-pass-work';
import type { ReflectionProbeGraphState } from './typed-frame-graph';

export interface CubeCaptureGraphWork {
  readonly sceneInput?: true;
  readonly candidateGeneration?: number;
  readonly target: RenderTarget;
  /** Cube face, array layer, or 3D depth slice written by this work item. */
  readonly layer: number;
  readonly physical: RenderTargetPhysical;
  readonly faceCamera: import('../render-contract').CameraSnapshot;
}

export interface CubeCaptureGraphState {
  work: readonly CubeCaptureGraphWork[];
  atmosphere?: boolean;
  reflectionProbes?: ReflectionProbeGraphState;
  planar?: import('../capture/planar-state').PlanarCaptureState;
}

export function addTargetCaptureGraphPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  state: CubeCaptureGraphState,
  lighting?: { readonly shadows: TypedShadowTargets; readonly accesses: readonly GraphAccess[] },
): Result<GraphTextureView | undefined, RenderGraphError> {
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
    const label = initial.sceneInput
      ? 'feature-scene-depth'
      : initial.faceCamera.planarReflection === undefined
        ? 'cube-capture'
        : 'planar-reflection';
    const current = (): CubeCaptureGraphWork => state.work[slot] ?? initial;
    const descriptor = initial.physical.descriptor;
    const volume = descriptor.shape === '3d';
    const msaa = descriptor.sampleCount === 4;
    const layers = renderTargetLayerCount(descriptor);
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
        usage: 0x10 | 0x04 | 0x01,
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
            usage: 0x10 | 0x04 | 0x01,
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
    const requests = recordModes.map((recordMode) =>
      registerScenePass(builder, {
        selector: FORWARD_PASS_SELECTOR,
        excludeSelector: undefined,
        recordMode,
        passKind: 'forward',
        gpu: false,
        gpuFilter: undefined,
        late: false,
        capture: true,
        camera: () => current().faceCamera,
      }),
    );
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
        ...(lighting === undefined
          ? []
          : [
              ...(lighting.shadows.directional === undefined
                ? []
                : [
                    { resource: lighting.shadows.directional.view, usage: 'sampled-read' as const },
                  ]),
              { resource: lighting.shadows.spot.view, usage: 'sampled-read' as const },
              ...(lighting.shadows.moments === undefined
                ? []
                : [{ resource: lighting.shadows.moments.view, usage: 'sampled-read' as const }]),
              ...(lighting.shadows.point === undefined
                ? []
                : [{ resource: lighting.shadows.point.view, usage: 'sampled-read' as const }]),
            ]),
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
      encode: ({ pass, frame, resources }) => {
        for (const request of requests) {
          const internal = scenePassContext(frame as _InternalRenderPipelineContext, request);
          const selfSampling = new Map<number, Set<number>>();
          let nextIndex = 0;
          for (const row of internal.validatedOrdered) {
            const index = nextIndex++;
            for (const slot of internal.materialSlotIndices[index] ?? []) {
              const material = internal.materialSlots[slot];
              if (material === undefined) throw new Error('Capture has no submitted material');
              if (
                ![...(material.textureSources?.values() ?? [])].some(
                  (source) =>
                    !isCanvasTextureSource(source) &&
                    !isExternalTextureSource(source) &&
                    resolveRenderTargetMaterialSource(source)?.target === current().target,
                )
              )
                continue;
              let handles = selfSampling.get(row.renderableIndex);
              if (handles === undefined) {
                handles = new Set();
                selfSampling.set(row.renderableIndex, handles);
              }
              handles.add(material.materialHandle ?? 0);
            }
          }
          const resolveShadow = (
            target: import('../render-pipeline').RenderPipelineTarget | undefined,
          ) => {
            if (target === undefined) return undefined;
            const view = resources.textureView(target.view);
            if (!view.ok) throw view.error;
            return view.value;
          };
          const groups =
            lighting === undefined
              ? undefined
              : buildPerFrameBindGroups(
                  internal.runtime as RenderSystemInternals,
                  internal.frameState,
                  internal.pipelineState,
                  internal.validatedOrdered.length > 0,
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
          const captureContext = {
            ...internal,
            ...(groups === undefined ? {} : groups),
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
            dispatch: internal.dispatch.filter(
              (entry) => !selfSampling.get(entry.renderableIndex)?.has(entry.materialHandle),
            ),
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
          delete captureContext.gpuDrivenSelection;
          delete captureContext.gpuDrivenStandardPbrFrameResources;
          // Each prepared lane uses the capture camera's own sorted draw roster.
          encodeMainPass(captureContext, pass, FORWARD_PASS_SELECTOR, {
            colorFormats: [initial.physical.descriptor.format as GPUTextureFormat],
            passKind: 'forward',
            ...(request.recordMode === undefined ? {} : { recordMode: request.recordMode }),
          });
        }
      },
    });
    if (!added.ok) return added;
  }
  const retained = state.planar?.current();
  if (planarView === undefined && retained !== undefined) {
    const texture = builder.importTexture(
      'planar-reflection.retained',
      {
        format: retained.physical.descriptor.format,
        size: {
          width: retained.physical.descriptor.width,
          height: retained.physical.descriptor.height,
        },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        usage: 0x10 | 0x04 | 0x01,
      },
      () =>
        (state.planar?.current() ?? retained).physical.resolveTexture ??
        (state.planar?.current() ?? retained).physical.texture,
    );
    if (!texture.ok) return texture;
    const view = builder.importView(
      texture.value,
      { dimension: '2d' },
      () => (state.planar?.current() ?? retained).physical.resolveView,
    );
    if (!view.ok) return view;
    planarView = view.value;
  }
  return ok(planarView);
}
