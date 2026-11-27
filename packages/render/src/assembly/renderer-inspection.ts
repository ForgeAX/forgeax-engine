import {
  type CompiledRenderGraphInfo,
  compiledRenderGraphAllocation,
} from '@forgeax/engine-render-graph';
import {
  PIPELINE_LIBRARY_LIMITS,
  type RenderPipeline,
  type RhiCanvasSurfacePresentationProof,
  type RhiDevice,
  RhiError,
  type TextureFormat,
} from '@forgeax/engine-rhi';
import type { DeviceScope } from '../device/device-scope';
import { inspectPipelineViewTextures } from '../environment/bindings';
import { dofInspection } from '../features/depth-of-field/depth-of-field-assembly';
import { emptyBloomInspection } from '../inspection-types';
import type { IblBindingInspection } from '../mesh-material-bindings';
import type { OutputColorSpaceReport } from '../output-color-space';
import type { AutoExposureInspection } from '../pipeline/standard-output/auto-exposure/inspection';
import type { StandardLutState } from '../pipeline/standard-output/lut-state';
import type { PipelineState } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import {
  type RasterPassRequestInspection,
  type RenderInspection,
  type RenderInspectionOptions,
  type RenderOutputInspection,
  type RenderStandardOutputColorInspection,
  STANDARD_OUTPUT_TRANSFORM_FEATURE_ID,
} from '../render-contract';
import {
  viewBloom,
  viewDepthOfField,
  viewDiffuseGi,
  viewDirectionalShadow,
  viewFeatureGraph,
  viewGraphAllocation,
  viewGraphInfo,
  viewInstanceCollections,
  viewMeshMaterialBindings,
  viewMotionBlur,
  viewProbePlacement,
  viewRecoveryEvidence,
  viewRenderScene,
  viewSsr,
  viewSsrDependencies,
  viewTemporal,
  viewTemporalTarget,
  viewTransmission,
  viewVolumetricFog,
} from '../view-inspection';
import { inspectWaterRenderGraph } from '../water/capabilities';
import {
  inspectWaterInfoPublications,
  WATER_INFO_FEATURE_IDENTITY,
} from '../water/water-info-feature';
import { sharedFeatureGraphInspection } from '../world/feature-graph-systems';
import type { ViewSettlementOwner } from '../world/view-settlement';

/** Inputs owned by the renderer assembly for one detached output projection. */
interface RendererOutputInspectionInput {
  readonly graph: CompiledRenderGraphInfo | undefined;
  readonly surfaceAvailable: boolean;
  readonly surfaceStorage: TextureFormat;
  readonly surfaceDisplay: TextureFormat;
  readonly surfaceProfile?: 'dual-view' | 'raw-only';
  readonly rgba16floatRenderable: boolean;
  readonly colorSpace: OutputColorSpaceReport;
  readonly presentationProof?: RhiCanvasSurfacePresentationProof | undefined;
  readonly autoExposure?: AutoExposureInspection | undefined;
  readonly standardLut?: StandardLutState | undefined;
}

function isSrgbFormat(format: TextureFormat): boolean {
  return format === 'rgba8unorm-srgb' || format === 'bgra8unorm-srgb';
}

function writesSurface(pass: CompiledRenderGraphInfo['passes'][number]): boolean {
  return pass.accesses.some(
    (access) =>
      (access.resource === 'surface' || access.resource.startsWith('surface.')) &&
      access.usage === 'color-attachment',
  );
}

/**
 * Preparation can record a partial IBL resource baseline for any material
 * draw. Publish it only after a Standard draw records its final pipeline fact.
 */
export function projectIblBindingInspection(
  receipt: IblBindingInspection | undefined,
): IblBindingInspection | undefined {
  if (receipt?.pipeline === undefined || receipt.pipeline.drawFrameId !== receipt.frameId)
    return undefined;
  return receipt;
}

/**
 * Project output facts from the committed graph and physical surface only.
 * Profile fields are deliberately not consulted: a transform pass, a real
 * intermediate target, and the final endpoint/domain are graph facts.
 */
function projectRendererOutputInspection(
  input: RendererOutputInspectionInput,
): RenderOutputInspection {
  const graph = input.graph;
  const outputTransformPass = graph?.passes.find(
    (pass) =>
      pass.name === 'output-transform' ||
      pass.name === 'present' ||
      pass.name === 'standard-encode' ||
      pass.name === 'standard-final' ||
      (pass.name === 'standard-grade' && writesSurface(pass)),
  );
  const surfaceResource = graph?.resources.find(
    (resource) => resource.kind === 'texture' && resource.label === 'surface',
  );
  const writesFinalSurface = graph?.passes.some(writesSurface) === true;
  const surfaceDomain =
    surfaceResource?.descriptor?.kind === 'texture' ? surfaceResource.descriptor.domain : undefined;
  const directEncodedSurface =
    writesFinalSurface && surfaceDomain === 'display-encoded' && isSrgbFormat(input.surfaceDisplay);
  const displayEncoded =
    input.surfaceAvailable &&
    writesFinalSurface &&
    (outputTransformPass !== undefined || directEncodedSurface);
  const intermediate = graph?.resources.find(
    (resource) =>
      resource.kind === 'texture' &&
      (resource.label === 'standard-output-color' || resource.label === 'standard-grade-output') &&
      resource.descriptor?.kind === 'texture',
  );
  const standardOutputColor: RenderStandardOutputColorInspection | undefined =
    intermediate?.descriptor?.kind === 'texture'
      ? {
          format: intermediate.descriptor.format,
          ...(intermediate.descriptor.domain === undefined
            ? {}
            : { domain: intermediate.descriptor.domain }),
          width: intermediate.descriptor.width,
          height: intermediate.descriptor.height,
          sampleCount: intermediate.descriptor.sampleCount,
          usage: intermediate.derivedUsage,
        }
      : undefined;
  const outputReady = input.surfaceAvailable && displayEncoded;

  return {
    ...(input.autoExposure === undefined ? {} : { autoExposure: input.autoExposure }),
    ...(input.standardLut === undefined ? {} : { standardLut: input.standardLut }),
    ...(outputTransformPass === undefined
      ? {}
      : { outputTransform: STANDARD_OUTPUT_TRANSFORM_FEATURE_ID }),
    displayEncoded,
    ...(intermediate?.descriptor?.kind === 'texture'
      ? { intermediateFormat: intermediate.descriptor.format }
      : {}),
    ...(input.surfaceProfile === undefined ? {} : { surfaceProfile: input.surfaceProfile }),
    colorSpace: input.colorSpace,
    graphPassNames: graph?.passes.map((pass) => pass.name) ?? [],
    ...(standardOutputColor === undefined ? {} : { standardOutputColor }),
    surfaceStorage: input.surfaceStorage,
    surfaceDisplay: input.surfaceDisplay,
    endpoint: 'surface.storage.raw',
    capability: outputReady
      ? input.rgba16floatRenderable
        ? 'rgba16float-renderable'
        : 'surface-raw-endpoint'
      : 'unavailable',
    ...(input.presentationProof === undefined
      ? {}
      : { presentationProof: input.presentationProof }),
    error: outputReady
      ? undefined
      : {
          code: 'inspection-facts-unavailable',
          expected: 'a committed graph writes an encoded surface endpoint',
          hint: 'draw a frame before consuming output inspection facts',
        },
  };
}

/** Assemble output inspection inputs from the live surface owner. */
export function projectRendererOutputInspectionFromSurface(input: {
  readonly graph: CompiledRenderGraphInfo | undefined;
  readonly surfaceReleased: boolean;
  readonly pipelineState: PipelineState | null;
  readonly rgba16floatRenderable: boolean;
  readonly colorSpace: OutputColorSpaceReport;
  readonly presentationProof?: RhiCanvasSurfacePresentationProof | undefined;
  readonly autoExposure?: AutoExposureInspection | undefined;
  readonly standardLut?: StandardLutState | undefined;
}): RenderOutputInspection {
  return projectRendererOutputInspection({
    graph: input.graph,
    surfaceAvailable: !input.surfaceReleased && input.pipelineState !== null,
    surfaceStorage: input.pipelineState?.format ?? 'rgba8unorm',
    surfaceDisplay: input.pipelineState?.colorAttachmentFormat ?? 'rgba8unorm',
    ...(input.pipelineState?.surfaceProfile === undefined
      ? {}
      : { surfaceProfile: input.pipelineState.surfaceProfile }),
    rgba16floatRenderable: input.rgba16floatRenderable,
    colorSpace: input.colorSpace,
    autoExposure: input.autoExposure,
    standardLut: input.standardLut,
    ...(input.presentationProof === undefined
      ? {}
      : { presentationProof: input.presentationProof }),
  });
}

/** Whether an inspect() call selected a field; omission selects the full snapshot. */
export function inspectionSelects(
  fields: readonly (keyof RenderInspection)[] | undefined,
  ...names: readonly (keyof RenderInspection)[]
): boolean {
  return fields === undefined || names.some((name) => fields.includes(name));
}

/** Detached facts from the active view owner; no renderer assembly state. */
type ViewInspectionWant = (...names: readonly (keyof RenderInspection)[]) => boolean;

export function projectRenderViewInspection(
  inspected: ViewSettlementOwner,
  deviceLost: boolean,
  fields?: readonly (keyof RenderInspection)[],
) {
  const want: ViewInspectionWant = (...names) => inspectionSelects(fields, ...names);
  return {
    ...projectViewGraphInspection(inspected, deviceLost, fields, want),
    ...projectViewLightingInspection(inspected, deviceLost, want),
    ...projectViewShadowInspection(inspected, deviceLost, fields, want),
    ...projectViewBindingInspection(inspected, fields, want),
  };
}

function projectViewGraphInspection(
  inspected: ViewSettlementOwner,
  deviceLost: boolean,
  fields: readonly (keyof RenderInspection)[] | undefined,
  want: ViewInspectionWant,
) {
  const viewTargets = want('viewTargetAllocation')
    ? inspected.frameState.viewTargetAllocation?.inspect()
    : undefined;
  const installed = inspected.frameState.compiledFrameGraph?.graph;
  const graphResourceAllocation =
    deviceLost || installed === undefined || !want('renderGraphResourceAllocation')
      ? undefined
      : compiledRenderGraphAllocation(installed);
  const graphGenerationAllocation =
    deviceLost || !want('renderGraphGenerationAllocation')
      ? undefined
      : viewGraphAllocation(inspected);
  const graph = deviceLost || !want('waterGraph') ? undefined : viewGraphInfo(inspected);
  const projectWaterGraphInspection = (
    graph: ReturnType<typeof viewGraphInfo>,
    inspected: ViewSettlementOwner,
    fields: readonly (keyof RenderInspection)[] | undefined,
  ) =>
    graph === undefined || fields?.includes('waterGraph') === false
      ? {}
      : {
          waterGraph: inspectWaterRenderGraph(
            graph,
            inspected.internals.renderWorld === undefined
              ? undefined
              : sharedFeatureGraphInspection(inspected.internals.renderWorld),
            inspectWaterInfoPublications(
              inspected.internals.featureHost?.features.find(
                (feature) => feature.identity === WATER_INFO_FEATURE_IDENTITY,
              ),
              inspected.internals.deviceGeneration ?? 0,
            ),
          ),
        };
  return {
    ...projectWaterGraphInspection(graph, inspected, fields),
    ...(want('featureGraph') ? { featureGraph: viewFeatureGraph(inspected) } : {}),
    ...(want('materialTextureSources')
      ? { materialTextureSources: inspected.recorded.materialTextureSources }
      : {}),
    ...projectViewCounterInspection(inspected, fields),
    ...projectInstanceCollectionInspection(inspected, fields),
    ...(want('renderScene') ? { renderScene: viewRenderScene(inspected) } : {}),
    ...(viewTargets === undefined ? {} : { viewTargetAllocation: viewTargets }),
    ...(graphResourceAllocation === undefined
      ? {}
      : { renderGraphResourceAllocation: graphResourceAllocation }),
    ...(graphGenerationAllocation === undefined
      ? {}
      : { renderGraphGenerationAllocation: graphGenerationAllocation }),
  };
}

function projectViewLightingInspection(
  inspected: ViewSettlementOwner,
  deviceLost: boolean,
  want: ViewInspectionWant,
) {
  const probePlacement = want('probePlacement') ? viewProbePlacement(inspected) : undefined;
  const diffuseGi = want('diffuseGi') ? viewDiffuseGi(inspected) : undefined;
  const iblBinding = want('iblBinding')
    ? projectIblBindingInspection(inspected.frameState.iblBindings?.inspect())
    : undefined;
  const dynamicResolution = want('dynamicResolution')
    ? inspected.frameState.dynamicResolution?.inspect()
    : undefined;
  return {
    ...(iblBinding === undefined ? {} : { iblBinding }),
    ...(want('reflectionProbes') ? { reflectionProbes: inspected.reflectionProbes.inspect() } : {}),
    ...(want('ssrDependencies') ? { ssrDependencies: viewSsrDependencies(inspected) } : {}),
    ...(want('ssr') ? { ssr: viewSsr(inspected) } : {}),
    ...(probePlacement === undefined ? {} : { probePlacement }),
    ...(diffuseGi === undefined ? {} : { diffuseGi }),
    ...(want('volumetricFog') ? { volumetricFog: viewVolumetricFog(inspected) } : {}),
    ...(want('environment')
      ? {
          environment: Object.freeze({
            ...inspected.frameState.environmentLifecycle.inspect(),
            transport: inspected.frameState.compiledFrameGraph?.atmosphereTransport,
          }),
        }
      : {}),
    ...(want('temporal') ? { temporal: viewTemporal(inspected) } : {}),
    ...(dynamicResolution === undefined ? {} : { dynamicResolution }),
    ...(want('bloom') ? { bloom: deviceLost ? emptyBloomInspection() : viewBloom(inspected) } : {}),
  };
}

function projectViewShadowInspection(
  inspected: ViewSettlementOwner,
  deviceLost: boolean,
  fields: readonly (keyof RenderInspection)[] | undefined,
  want: ViewInspectionWant,
) {
  const submitted = inspected.frameState.submittedInspection;
  const standardLighting =
    !deviceLost && want('standardLighting') ? submitted?.standardLighting : undefined;
  const temporalTarget = want('temporalTarget') ? viewTemporalTarget(inspected) : undefined;
  const motionBlur = want('motionBlur') ? viewMotionBlur(inspected) : undefined;
  const transmission = want('transmission') ? viewTransmission(inspected) : undefined;
  return {
    ...(want('directionalShadow')
      ? { directionalShadow: projectDirectionalReceiver(inspected) }
      : {}),
    ...(!deviceLost && want('viewConfiguration') && submitted?.viewConfiguration !== undefined
      ? {
          viewConfiguration: {
            requested: { ...submitted.viewConfiguration.requested },
            effective: { ...submitted.viewConfiguration.effective },
          },
        }
      : {}),
    ...(want('shadowRaster') ? { shadowRaster: inspected.frameState.shadowRaster.inspect() } : {}),
    ...(temporalTarget === undefined ? {} : { temporalTarget: Object.freeze(temporalTarget) }),
    ...(motionBlur === undefined ? {} : { motionBlur: Object.freeze(motionBlur) }),
    ...(want('depthOfField') ? dofInspection(viewDepthOfField(inspected)) : {}),
    ...projectLodInspection(inspected, fields),
    ...(transmission === undefined ? {} : { transmission }),
    ...(standardLighting === undefined ? {} : { standardLighting }),
    ...(submitted?.capsuleShadow === undefined ? {} : { capsuleShadow: submitted.capsuleShadow }),
    ...(submitted?.transparency === undefined ? {} : { transparency: submitted.transparency }),
  };
}

function projectDirectionalReceiver(inspected: ViewSettlementOwner) {
  const shadow = viewDirectionalShadow(inspected);
  const receiver = inspected.frameState.submittedInspection?.forwardShadow;
  return receiver === undefined ? shadow : { ...shadow, forwardReceiver: receiver };
}

function projectViewBindingInspection(
  inspected: ViewSettlementOwner,
  fields: readonly (keyof RenderInspection)[] | undefined,
  want: ViewInspectionWant,
) {
  return {
    ...projectMaterialBindingInspection(inspected, fields),
    ...(want('bindGroupCounts')
      ? {
          bindGroupCounts: Object.freeze({
            createBindGroup: inspected.recorded.bindGroups.createBindGroup,
            keys: Object.freeze([...inspected.recorded.bindGroups.keys]),
          }),
        }
      : {}),
  };
}

function projectViewCounterInspection(
  inspected: ViewSettlementOwner,
  fields: readonly (keyof RenderInspection)[] | undefined,
) {
  return {
    ...(fields?.includes('frustumStats') === false
      ? {}
      : { frustumStats: Object.freeze({ ...inspected.recorded.frustum }) }),
    ...(fields?.includes('visibilityStats') === false
      ? {}
      : { visibilityStats: Object.freeze({ ...inspected.recorded.visibility }) }),
  };
}

function projectInstanceCollectionInspection(
  inspected: ViewSettlementOwner,
  fields: readonly (keyof RenderInspection)[] | undefined,
) {
  return {
    ...(fields !== undefined && !fields.includes('instanceCollections')
      ? {}
      : {
          instanceCollections: Object.freeze(
            viewInstanceCollections(inspected).map((collection) =>
              Object.freeze({
                ...collection,
                uploadRanges: Object.freeze(
                  collection.uploadRanges.map((range) => Object.freeze({ ...range })),
                ),
                ...(collection.error === undefined
                  ? {}
                  : {
                      error: Object.freeze({
                        ...collection.error,
                        detail: Object.freeze({ ...collection.error.detail }),
                      }),
                    }),
              }),
            ),
          ),
        }),
  };
}

function projectLodInspection(
  inspected: ViewSettlementOwner,
  fields: readonly (keyof RenderInspection)[] | undefined,
) {
  return {
    ...(inspected.lod.cell === undefined ||
    (fields !== undefined && !fields.includes('lodOcclusion'))
      ? {}
      : { lodOcclusion: Object.freeze(inspected.lod.cell.value()) }),
  };
}

function projectMaterialBindingInspection(
  inspected: ViewSettlementOwner,
  fields: readonly (keyof RenderInspection)[] | undefined,
) {
  return {
    ...(fields !== undefined && !fields.includes('meshMaterialBindings')
      ? {}
      : {
          meshMaterialBindings: Object.freeze(
            viewMeshMaterialBindings(inspected).map((observation) =>
              Object.freeze({
                ...observation,
                bindings: Object.freeze(
                  observation.bindings.map((binding) => Object.freeze({ ...binding })),
                ),
                diagnostics: Object.freeze(
                  observation.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
                ),
              }),
            ),
          ),
        }),
  };
}

/** Share the same detached output facts between inspection and observation. */
export function projectRendererOutputObservationInspection(input: {
  readonly observationId: string;
  readonly frameId: number;
  readonly antialias: CameraSnapshot['antialias'] | undefined;
  readonly outputInspection: RenderOutputInspection;
  readonly rgba16floatRenderable: boolean;
  readonly resourceStats: NonNullable<RenderInspection['observation']['resourceStats']>;
}) {
  const { observationId, frameId, outputInspection } = input;
  return {
    output: Object.freeze({
      ...outputInspection,
      graphPassNames: Object.freeze([...outputInspection.graphPassNames]),
      ...(outputInspection.standardOutputColor === undefined
        ? {}
        : { standardOutputColor: Object.freeze({ ...outputInspection.standardOutputColor }) }),
    }),
    observation: Object.freeze({
      observationId,
      frameId,
      ...(input.antialias === undefined ? {} : { antialias: input.antialias }),
      ...(outputInspection.surfaceProfile === undefined
        ? {}
        : { surfaceProfile: outputInspection.surfaceProfile }),
      rgba16floatRenderable: input.rgba16floatRenderable,
      passNames: Object.freeze([...outputInspection.graphPassNames]),
      ...(outputInspection.standardOutputColor === undefined
        ? {}
        : { standardOutputColor: Object.freeze({ ...outputInspection.standardOutputColor }) }),
      resourceStats: Object.freeze({
        allocationCount: input.resourceStats.allocationCount,
        liveCount: input.resourceStats.liveCount,
        peakLiveCount: input.resourceStats.peakLiveCount,
        mapCount: input.resourceStats.mapCount,
        readbackCount: input.resourceStats.readbackCount,
        liveByteLength: input.resourceStats.liveByteLength,
      }),
    }),
  };
}

export function projectRendererInspectionState(
  disposed: boolean,
  deviceLost: boolean,
  faulted: boolean,
): RenderInspection['state'] {
  if (disposed) return 'disposed';
  if (deviceLost) return 'device-lost';
  return faulted ? 'faulted' : 'alive';
}

/** Output and observation fields for one frame, projected from the surface and graph state. */
export function projectRendererOutputFields(
  input: Omit<Parameters<typeof projectRendererOutputObservationInspection>[0], 'observationId'>,
) {
  return projectRendererOutputObservationInspection({
    observationId: `${STANDARD_OUTPUT_TRANSFORM_FEATURE_ID}:frame-${input.frameId}`,
    frameId: input.frameId,
    antialias: input.antialias,
    outputInspection: input.outputInspection,
    rgba16floatRenderable: input.rgba16floatRenderable,
    resourceStats: input.resourceStats,
  });
}

/** Detached recovery evidence; a lost device reports an unready graph. */
export function projectRecoveryEvidenceInspection(
  inspected: ViewSettlementOwner,
  deviceLost: boolean,
  frameId: number,
  lastGeneration: number | undefined,
): RenderInspection['recoveryEvidence'] {
  const recoveryEvidence = viewRecoveryEvidence(inspected);
  return Object.freeze({
    ...recoveryEvidence,
    graph: deviceLost
      ? { ready: false, generation: 0, passCount: 0, resourceCount: 0 }
      : recoveryEvidence.graph,
    producerRoots: Object.freeze([...recoveryEvidence.producerRoots]),
    receipts: Object.freeze({ count: frameId, lastGeneration }),
  });
}

/** Retain bounded pass requests only for the device with an active route collection. */
export function createPipelineLibraryCollection(buildDevice: () => RhiDevice) {
  let collection:
    | {
        readonly device: RhiDevice;
        readonly dispose: () => void;
        readonly requests: RasterPassRequestInspection[];
        overwritten: number;
      }
    | undefined;
  const active = (device: RhiDevice) => collection?.device === device;
  const record = (request: RasterPassRequestInspection, pipeline: RenderPipeline | null) => {
    if (collection?.device !== buildDevice()) return;
    if (collection.requests.length === 128) {
      collection.requests.shift();
      collection.overwritten++;
    }
    const nativeRecipe =
      pipeline === null
        ? undefined
        : collection.device.pipelineLibrary?.inspectRenderPipelineIdentity?.(pipeline);
    const viewTextures = pipeline === null ? undefined : inspectPipelineViewTextures(pipeline);
    collection.requests.push({
      ...request,
      ...(nativeRecipe === undefined ? {} : { nativeRecipe }),
      ...(viewTextures === undefined ? {} : { viewTextures }),
    });
  };
  return {
    active,
    update(requested: boolean | undefined, device: RhiDevice, deviceScope: DeviceScope) {
      if (requested === false) {
        collection?.dispose();
        collection = undefined;
      } else if (requested === true && !active(device)) {
        if (device.pipelineLibrary?.collect === undefined)
          throw new RhiError({
            code: 'feature-not-enabled',
            expected: 'pipeline library route collection',
            hint: 'Use a backend supporting explicit route retention.',
          });
        collection?.dispose();
        const retention = device.pipelineLibrary.collect();
        const child = deviceScope.createChild('pipeline-library-route');
        const scope = {
          device,
          dispose: () => child.dispose(),
          requests: [] as RasterPassRequestInspection[],
          overwritten: 0,
        };
        collection = scope;
        child._adopt('pipeline', retention, (value) => {
          value.dispose();
          if (collection === scope) collection = undefined;
        });
      }
    },
    recordForCurrentDevice() {
      return collection === undefined ? undefined : record;
    },
    inspect(
      fields: RenderInspectionOptions['fields'],
      device: RhiDevice,
      generation: number,
    ): Pick<RenderInspection, 'rasterPassRequests'> {
      if (collection?.device !== device || !fields?.includes('rasterPassRequests')) return {};
      return {
        rasterPassRequests: {
          deviceGeneration: generation,
          overwritten: collection.overwritten,
          requests: collection.requests.slice(),
        },
      };
    },
  };
}

/** Exports the requested pipeline library, or throws when the backend has none. */
export function exportPipelineLibraryForInspection(
  library: RhiDevice['pipelineLibrary'],
  options: RenderInspectionOptions | undefined,
) {
  if (options?.pipelineLibrary !== true) return undefined;
  const exported = library?.export(
    options.pipelineLibraryLimits,
    options.pipelineLibraryRequestedOnly === true ? { requestedOnly: true } : undefined,
  );
  if (exported === undefined)
    throw new RhiError({
      code: 'feature-not-enabled',
      expected: 'backend pipeline library support',
      hint: 'select WebGPU for pipeline recipe collection',
    });
  if (exported.ok === false) throw exported.error;
  return exported;
}

export function projectRendererPipelineLibraryInspection(
  library: RhiDevice['pipelineLibrary'],
  options: RenderInspectionOptions | undefined,
  collecting: () => boolean,
  backgroundPipelineLibraryState: RenderInspection['backgroundPipelineLibraryState'],
  exported: ReturnType<typeof exportPipelineLibraryForInspection>,
) {
  return {
    ...(library === undefined ||
    !inspectionSelects(options?.fields, 'pipelineLibrary', 'pipelineLibraryCollecting')
      ? {}
      : {
          pipelineLibrary: library.inspect(options),
          pipelineLibraryCollecting: collecting(),
        }),
    ...(backgroundPipelineLibraryState === undefined ? {} : { backgroundPipelineLibraryState }),
    ...(exported?.ok === true
      ? {
          pipelineLibraryManifest: exported.value,
          pipelineLibraryPolicy: {
            ...PIPELINE_LIBRARY_LIMITS,
            ...options?.pipelineLibraryLimits,
          },
        }
      : {}),
  };
}
