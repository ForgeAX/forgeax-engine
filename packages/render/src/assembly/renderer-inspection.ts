import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type { RhiCanvasSurfacePresentationProof, TextureFormat } from '@forgeax/engine-rhi';
import { dofInspection } from '../features/depth-of-field/depth-of-field-assembly';
import { emptyBloomInspection } from '../inspection-types';
import type { OutputColorSpaceReport } from '../output-color-space';
import type { AutoExposureInspection } from '../pipeline/standard-output/auto-exposure/inspection';
import type { StandardLutState } from '../pipeline/standard-output/lut-state';
import type { PipelineState } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import {
  type RenderInspection,
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
  viewRenderScene,
  viewSsr,
  viewSsrDependencies,
  viewTemporal,
  viewTemporalTarget,
  viewTransmission,
  viewVolumetricFog,
} from '../view-inspection';
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
 * Project output facts from the committed graph and physical surface only.
 * Profile fields are deliberately not consulted: a transform pass, a real
 * intermediate target, and the final endpoint/domain are graph facts.
 */
function projectRendererOutputInspection(
  input: RendererOutputInspectionInput,
): RenderOutputInspection {
  const graph = input.graph;
  const outputTransformPass = graph?.passes.find(
    (pass) => pass.name === 'output-transform' || pass.name === 'present',
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
      resource.label === 'standard-output-color' &&
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

/** Detached facts from the active view owner; no renderer assembly state. */
export function projectRenderViewInspection(
  inspected: ViewSettlementOwner,
  deviceLost: boolean,
  fields?: readonly (keyof RenderInspection)[],
) {
  const graph = deviceLost ? undefined : viewGraphInfo(inspected);
  const graphResourceAllocation = graph?.resourceAllocation;
  const graphGenerationAllocation = deviceLost ? undefined : viewGraphAllocation(inspected);
  const standardLighting = deviceLost
    ? undefined
    : inspected.frameState.submittedInspection?.standardLighting;
  const bloom = deviceLost ? emptyBloomInspection() : viewBloom(inspected);
  const volumetricFog = viewVolumetricFog(inspected);
  const directionalShadow = viewDirectionalShadow(inspected);
  const shadowRaster = inspected.frameState.shadowRaster.inspect();
  const submitted = inspected.frameState.submittedInspection;
  const probePlacement = viewProbePlacement(inspected);
  const diffuseGi = viewDiffuseGi(inspected);
  const dynamicResolution = inspected.frameState.dynamicResolution?.inspect();
  const temporalTarget = viewTemporalTarget(inspected);
  const motionBlur = viewMotionBlur(inspected);
  const transmission = viewTransmission(inspected);
  return {
    featureGraph: viewFeatureGraph(inspected),
    materialTextureSources: inspected.recorded.materialTextureSources,
    ...projectViewCounterInspection(inspected, fields),
    ...projectInstanceCollectionInspection(inspected, fields),
    ...(fields !== undefined && !fields.includes('renderScene')
      ? {}
      : { renderScene: viewRenderScene(inspected) }),
    ...(graphResourceAllocation === undefined
      ? {}
      : { renderGraphResourceAllocation: graphResourceAllocation }),
    ...(graphGenerationAllocation === undefined
      ? {}
      : { renderGraphGenerationAllocation: graphGenerationAllocation }),
    ...(inspected.frameState.iblBindingInspection === undefined
      ? {}
      : { iblBinding: inspected.frameState.iblBindingInspection }),
    reflectionProbes: inspected.reflectionProbes.inspect(),
    ssrDependencies: viewSsrDependencies(inspected),
    ssr: viewSsr(inspected),
    ...(probePlacement === undefined ? {} : { probePlacement }),
    ...(diffuseGi === undefined ? {} : { diffuseGi }),
    volumetricFog,
    environment: inspected.frameState.environmentLifecycle.inspect(),
    temporal: viewTemporal(inspected),
    ...(dynamicResolution === undefined ? {} : { dynamicResolution }),
    bloom,
    directionalShadow,
    shadowRaster,
    ...(temporalTarget === undefined ? {} : { temporalTarget: Object.freeze(temporalTarget) }),
    ...(motionBlur === undefined ? {} : { motionBlur: Object.freeze(motionBlur) }),
    ...dofInspection(viewDepthOfField(inspected)),
    ...projectLodInspection(inspected, fields),
    ...(transmission === undefined ? {} : { transmission }),
    ...(standardLighting === undefined
      ? {}
      : { standardLighting: Object.freeze({ ...standardLighting }) }),
    ...(submitted?.capsuleShadow === undefined ? {} : { capsuleShadow: submitted.capsuleShadow }),
    ...(submitted?.transparency === undefined ? {} : { transparency: submitted.transparency }),
    ...projectMaterialBindingInspection(inspected, fields),
    bindGroupCounts: Object.freeze({
      createBindGroup: inspected.recorded.bindGroups.createBindGroup,
      keys: Object.freeze([...inspected.recorded.bindGroups.keys]),
    }),
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
