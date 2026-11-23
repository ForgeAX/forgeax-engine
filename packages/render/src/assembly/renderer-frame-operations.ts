import type { World } from '@forgeax/engine-ecs';
import { ok, RhiError } from '@forgeax/engine-rhi';
import { isStripTopology } from '@forgeax/engine-types';
import { type RenderError, RendererContractFailureError } from '../errors/render';
import { materialVertexConstants } from '../material-stage-constants';
import { buildPipelineForMaterialShader } from '../pipeline-builder';
import { type PublishedRenderFrameInput, RenderPublicationError } from '../publication/contract';
import type { RenderFrameInput } from '../render-contract';
import { retireAfterSubmission } from '../world/submission-systems';
import { sceneFreeFrameInputError, unattachedFrameLeaseError } from './draw-frame-input';
import { buildPipelineColorFormats } from './material-shader-policy';
import { completeFrameFailure } from './renderer-frame-transaction';
import { HDR_COLOR_ATTACHMENT_FORMAT } from './webgpu-ready-contract';
import { derivedPhysicsFrameError, dynamicGeometryFrameError } from './webgpu-renderer-guards';
import { projectReceiptColorObservations } from './webgpu-renderer-observation';

export function runCompileMaterialPipeline(
  cacheKey: string,
  entry: import('@forgeax/engine-shader').MaterialShaderEntry,
  prepared: import('./material/prepared-pipeline-owner').PreparedRenderPipelineOwner | undefined,
  preparedSource: import('@forgeax/engine-types').ShaderSource,
  isHdr: boolean,
  ldrColorFormat: GPUTextureFormat,
  attachments: {
    readonly colorFormats: readonly GPUTextureFormat[];
    readonly depthFormat: GPUTextureFormat | undefined;
    readonly sampleCount: 1 | 4;
  },
  renderState: import('@forgeax/engine-types').MaterialRenderState | undefined,
  coverageOnly: boolean,
  constants: Readonly<Record<string, number>> | undefined,
  label: string,
  moduleLabel: string,
  topology: GPUPrimitiveTopology | undefined,
  stripIndexFormat: 'uint16' | 'uint32' | undefined,
  resolvedVertexEntry: string | undefined,
  fragmentEntry: string | null | undefined,
  passKind: string,
  ctx: {
    stockStandardVertexProgram?: boolean;
    layoutKind?: 'pbr-skin' | 'gpu-driven-skin' | 'gpu-driven-cluster-skin';
    vertexBuffers: readonly GPUVertexBufferLayout[];
    waterGroup2Layout?: import('@forgeax/engine-rhi').BindGroupLayout;
    device: import('@forgeax/engine-rhi').RhiDevice;
    shaderModuleFactory: import('./material-shader-policy').ShaderDeviceAdapterInternal;
    pipelineLayout: import('@forgeax/engine-rhi').PipelineLayout;
  },
) {
  const built = buildPipelineForMaterialShader(
    cacheKey,
    // The catalog entry is projected into the material-shader entry shape.
    entry,
    {
      ...ctx,
      ...(prepared === undefined
        ? {}
        : {
            createRenderPipelineRecipeState: (state, dependencies, materialize) =>
              prepared.requestState(cacheKey, preparedSource, state, dependencies, materialize),
          }),
      createRenderPipeline:
        prepared === undefined
          ? undefined
          : (descriptor) => prepared.request(cacheKey, preparedSource, descriptor),
      colorFormat: isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat,
      colorFormats: buildPipelineColorFormats(
        attachments.colorFormats.length === 0,
        attachments.colorFormats.slice(1),
        renderState?.outputs?.[0]?.format ?? (isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat),
      ),
      depthFormat: attachments.depthFormat,
      coverageOnly,
      ...(constants === undefined
        ? {}
        : { constants, vertexConstants: materialVertexConstants(constants) }),
      label,
      // feat-20260604 w16-b: the shader-MODULE cache identity. Stable across
      // per variant. See PipelineBuilderContext.moduleLabel.
      moduleLabel,
    },
    renderState,
    // w8/w15: pack topology (+ stripIndexFormat) into the builder's geometry
    // param. Strip topologies bake stripIndexFormat into the immutable PSO
    // (WebGPU spec: only valid for line-strip / triangle-strip). The record
    // stage (w9 + w15) threads each mesh's topology + indexFormat here; when
    // the caller omits stripIndexFormat we fall back to 'uint32' (the engine
    // procedural index width: createBoxGeometry etc. emit Uint32 indices).
    topology !== undefined
      ? {
          topology,
          ...(isStripTopology(topology)
            ? { stripIndexFormat: stripIndexFormat ?? ('uint32' as const) }
            : {}),
        }
      : undefined,
    resolvedVertexEntry,
    fragmentEntry,
    undefined, // defines — none
    passKind,
    attachments.sampleCount,
  );
  return built;
}

export function runRetirePreviousWaterFrames(
  key: string,
  input: {
    readonly waterInfoTextureViews: ReadonlyMap<string, import('@forgeax/engine-rhi').TextureView>;
    readonly waterInfoPublication?: import('../water/water-info-publication-work').WaterInfoFramePublication;
    readonly viewIdentity: string;
    readonly frameGeneration: number;
    readonly deviceGeneration: number;
    readonly viewOriginM: readonly [number, number, number];
    readonly waterMeshDraws: readonly import('../water/wave-material').WaterMeshInstanceDrawUpload[];
    readonly waterMeshDrawsOwned?: boolean;
  },
  renderWorld: import('@forgeax/engine-ecs').World,
  device: import('@forgeax/engine-rhi').RhiDevice,
  internals: import('./webgpu-renderer-contract').WebGPURendererInternals,
  destroyWaterMaterialFrameEntry: (
    device: import('@forgeax/engine-rhi').RhiDevice,
    entry: {
      lifetime: 'active' | 'retiring' | 'destroyed';
      readonly deviceGeneration: number;
      readonly bindings: ReadonlyMap<
        string,
        import('../water/wave-material').WaterMaterialFrameBindings
      >;
      readonly retiredBuffers: readonly (readonly import('@forgeax/engine-rhi').Buffer[])[];
    },
  ) => void,
  entries: Map<
    string,
    {
      lifetime: 'active' | 'retiring' | 'destroyed';
      readonly viewIdentity: string;
      readonly frameGeneration: number;
      readonly deviceGeneration: number;
      readonly publication: import('../water/water-info-publication-work').WaterInfoFramePublication;
      readonly bindings: ReadonlyMap<
        string,
        import('../water/wave-material').WaterMaterialFrameBindings
      >;
      readonly waterMeshDraws: ReadonlyMap<
        string,
        import('../water/wave-material').WaterMeshInstanceDrawUpload
      >;
      readonly waterMeshDrawUploads: readonly import('../water/wave-material').WaterMeshInstanceDrawUpload[];
      readonly viewOriginM: readonly [number, number, number];
      readonly pipelineState: import('../record/render-context').PipelineState;
      readonly retiredBuffers: readonly (readonly import('@forgeax/engine-rhi').Buffer[])[];
    }
  >,
) {
  for (const [previousKey, previous] of entries) {
    if (
      previousKey === key ||
      previous.frameGeneration === input.frameGeneration ||
      previous.lifetime !== 'active'
    )
      continue;
    previous.lifetime = 'retiring';
    retireAfterSubmission(renderWorld, {
      generation: previous.deviceGeneration,
      queue: device.queue,
      onFailure: (cause) =>
        internals.errorRegistry.fire(
          completeFrameFailure(previous.frameGeneration, previous.deviceGeneration, cause),
        ),
      release: () => {
        destroyWaterMaterialFrameEntry(device, previous);
        if (entries.get(previousKey) === previous) entries.delete(previousKey);
      },
    });
  }
}

export function runMeshBodyPublished(
  publication: import('../water/water-info-publication-work').WaterInfoFramePublication,
  publishedBodyKeys: Set<string>,
  waterInfoTextureViews: Map<string, import('@forgeax/engine-rhi').TextureView>,
  bodyKey: string,
): boolean {
  const row = publication.rows.get(bodyKey);
  return (
    publishedBodyKeys.has(bodyKey) &&
    row !== undefined &&
    waterInfoTextureViews.has(row.targetName) &&
    publication.targets.some(
      (target) => target.targetName === row.targetName && target.targetFormat === row.targetFormat,
    )
  );
}

export function runDrawRequestError(
  ui: import('../world/surface-ui').SurfaceUiState | undefined,
  publicationReceiver: import('../publication/receiver').RenderPublicationReceiver | undefined,
  frameRequest: RenderFrameInput | undefined,
  publicationRequest: PublishedRenderFrameInput | undefined,
): RenderError | undefined {
  const sceneAbsent = frameRequest?.source === null;
  if (sceneAbsent && (frameRequest.camera !== undefined || ui === undefined)) {
    return sceneFreeFrameInputError();
  }
  if (publicationRequest !== undefined) {
    if (publicationReceiver === undefined)
      return new RenderPublicationError({
        reason: 'identity',
        subject: 'RendererOptions.publicationSource',
      });
  } else if (publicationReceiver !== undefined && !sceneAbsent) {
    return new RenderPublicationError({
      reason: 'identity',
      subject: 'a publication-bound renderer cannot consume local World leases',
    });
  }
  return undefined;
}

export function runDrawWorldError(
  dynamicGeometryHost: import('./dynamic-geometry-host').DynamicGeometryHostImplementation,
  world: World | undefined,
  request: RenderFrameInput | undefined,
): RenderError | undefined {
  if (request !== undefined && request.source !== null && world === undefined)
    return unattachedFrameLeaseError();
  if (world === undefined) return undefined;
  return (
    derivedPhysicsFrameError(world) ??
    dynamicGeometryFrameError(world, dynamicGeometryHost.dynamicGeometryFault)
  );
}

export function runDrawHealthError(
  internals: import('./webgpu-renderer-contract').WebGPURendererInternals,
): RhiError | undefined {
  const health = internals.healthRegistry.getLastSnapshot();
  if (health.reason === 'alive') return undefined;
  return new RhiError({
    code: 'rhi-not-available',
    expected: 'renderer generation is healthy before submitting another frame',
    hint:
      health.reason === 'device-lost'
        ? 'call renderer.recover() after a host-chosen delay; camera holds previous frame'
        : 'dispose and recreate the faulted Renderer; submitted GPU completion is unknown',
  });
}

export function runDeliverFeatureSourceCompletion(
  onFeatureSourceCompleted: import('../publication/contract').PublishedRenderFrameInput['onFeatureSourceCompleted'],
  observationCaptureOwner: import('../render-contract').RenderPipelineObservationCaptureOwner,
  receipt: Readonly<{
    shadowWorkload?: import('../inspection-types').ShadowWorkloadObservation;
    creditCompleted?: Promise<
      import('../render-contract').RenderResult<void, import('../errors/render').RenderError>
    >;
    preparationCompleted?: Promise<
      import('../render-contract').RenderResult<void, import('../errors/render').RenderError>
    >;
    completed: Promise<
      import('../render-contract').RenderResult<void, import('../errors/render').RenderError>
    >;
    barrelDistortion?: import('../barrel-distortion').BarrelDistortionMapping;
    backendId: 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null';
    graphGeneration: number;
    observationDomains?: readonly import('../render-contract').FrameObservationDomain[];
    presentationPendingReason?:
      | Readonly<{ code: 'ui-only' }>
      | import('../render-contract').FramePresentationPendingReason;
    deviceGeneration: number;
    presentation: import('../render-contract').FramePresentation;
    renderPassCpuIdentities?: readonly import('../render-contract').RenderPassCpuIdentity[];
    renderPassCpuIdentitiesComplete?: boolean;
    profileFrame?: import('@forgeax/engine-profiler').ProfileFrameToken;
    frameId: number;
    editorAssistance?: import('../features/editor-assistance/picking').SubmittedEditorAssistanceFrame;
  }>,
  completed: Promise<
    import('../render-contract').RenderResult<void, import('../errors/render').RenderError>
  >,
  readCaptures: import('./webgpu-renderer-observation-owner').ObservationCaptureRead | undefined,
  internals: import('./webgpu-renderer-contract').WebGPURendererInternals,
) {
  if (onFeatureSourceCompleted !== undefined) {
    const settleReadbackFlight =
      observationCaptureOwner.retainFeatureTextureReadbacks?.(receipt.frameId) ?? (() => {});
    const featureTextureObservations = async () => {
      try {
        const completionResult = await completed;
        if (!completionResult.ok) return completionResult;
        if (readCaptures === undefined) return ok([]);
        const read = await readCaptures();
        if (!read.ok) return read;
        const featureCaptures = read.value.captures.filter(
          ({ capture }) => capture.featureTexture !== undefined,
        );
        if (featureCaptures.length === 0) return ok([]);
        return projectReceiptColorObservations(
          receipt,
          featureCaptures,
          ['feature-texture'],
          internals.device.caps.backendKind,
          read.value.graphGenerations,
        );
      } finally {
        observationCaptureOwner.completeFeatureTextureReadbackObservation?.(receipt.frameId);
      }
    };
    try {
      onFeatureSourceCompleted(
        {
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          ...(receipt.graphGeneration === undefined
            ? {}
            : { graphGeneration: receipt.graphGeneration }),
        },
        featureTextureObservations(),
        settleReadbackFlight,
      );
    } catch (cause) {
      settleReadbackFlight();
      internals.errorRegistry.fire(
        new RendererContractFailureError(
          'observe',
          `the source-frame feature-texture completion callback threw: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      );
    }
  } else if (readCaptures === undefined) {
    observationCaptureOwner.completeFeatureTextureReadbackObservation?.(receipt.frameId);
  }
}
