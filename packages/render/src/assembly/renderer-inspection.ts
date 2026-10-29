import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type { RhiCanvasSurfacePresentationProof, TextureFormat } from '@forgeax/engine-rhi';
import { dofInspection } from '../features/depth-of-field/depth-of-field-assembly';
import { emptyBloomInspection } from '../inspection-types';
import type { OutputColorSpaceReport } from '../output-color-space';
import type { AutoExposureInspection } from '../pipeline/standard-output/auto-exposure/inspection';
import type { StandardLutState } from '../pipeline/standard-output/lut-state';
import type { PipelineState } from '../record/render-context';
import {
  type RenderInspection,
  type RenderOutputInspection,
  type RenderStandardOutputColorInspection,
  STANDARD_OUTPUT_TRANSFORM_FEATURE_ID,
} from '../render-contract';
import type { RenderSystem } from '../render-system';

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

/** Detached facts from the active render system; no renderer assembly state. */
export function projectRenderSystemInspection(system: RenderSystem, deviceLost: boolean) {
  const graph = deviceLost ? undefined : system.perFrameGraphInfo;
  const graphResourceAllocation = graph?.resourceAllocation;
  const graphGenerationAllocation = deviceLost ? undefined : system.renderGraphGenerationAllocation;
  const standardLighting = deviceLost ? undefined : system.standardLightingInspection;
  const bloom = deviceLost ? emptyBloomInspection() : system.bloom;
  const volumetricFog = system.volumetricFog;
  const directionalShadow = system.directionalShadow;
  const shadowRaster = system.shadowRaster;
  return {
    featureGraph: system.featureGraphInspection,
    materialTextureSources: system.materialTextureSources,
    frustumStats: Object.freeze({ ...system.frustumStats }),
    visibilityStats: Object.freeze({ ...system.visibilityStats }),
    instanceCollections: Object.freeze(
      system.instanceCollectionsInspection.map((collection) =>
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
    renderScene: system.renderScene,
    ...(graphResourceAllocation === undefined
      ? {}
      : { renderGraphResourceAllocation: graphResourceAllocation }),
    ...(graphGenerationAllocation === undefined
      ? {}
      : { renderGraphGenerationAllocation: graphGenerationAllocation }),
    ...(system.iblBinding === undefined ? {} : { iblBinding: system.iblBinding }),
    reflectionProbes: system.reflectionProbes,
    ssrDependencies: system.ssrDependencies,
    ssr: system.ssr,
    ...(system.probePlacement === undefined ? {} : { probePlacement: system.probePlacement }),
    ...(system.diffuseGi === undefined ? {} : { diffuseGi: system.diffuseGi }),
    volumetricFog,
    environment: system.environment,
    temporal: system.temporal,
    ...(system.dynamicResolution === undefined
      ? {}
      : { dynamicResolution: system.dynamicResolution }),
    bloom,
    directionalShadow,
    shadowRaster,
    ...(system.temporalTargetInspection === undefined
      ? {}
      : { temporalTarget: Object.freeze(system.temporalTargetInspection) }),
    ...(system.motionBlurInspection === undefined
      ? {}
      : { motionBlur: Object.freeze(system.motionBlurInspection) }),
    ...dofInspection(system.depthOfFieldInspection),
    ...(system.lodOcclusion === undefined
      ? {}
      : { lodOcclusion: Object.freeze(system.lodOcclusion.value()) }),
    ...(system.transmission === undefined ? {} : { transmission: system.transmission }),
    ...(standardLighting === undefined
      ? {}
      : { standardLighting: Object.freeze({ ...standardLighting }) }),
    ...(system.capsuleShadowInspection === undefined
      ? {}
      : { capsuleShadow: system.capsuleShadowInspection }),
    ...(system.transparencyInspection === undefined
      ? {}
      : { transparency: system.transparencyInspection }),
    bindGroupCounts: Object.freeze({
      createBindGroup: system.bindGroupCounts.createBindGroup,
      keys: Object.freeze([...system.bindGroupCounts.keys]),
    }),
    meshMaterialBindings: Object.freeze(
      system.meshMaterialBindings.map((observation) =>
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
  };
}

/** Share the same detached output facts between inspection and observation. */
export function projectRendererOutputObservationInspection(input: {
  readonly observationId: string;
  readonly frameId: number;
  readonly antialias: RenderSystem['lastSuccessfulCameraAntialias'];
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
