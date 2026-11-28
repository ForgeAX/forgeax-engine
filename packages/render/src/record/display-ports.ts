import { standardBloomAdmitted } from '../bloom-admission';
import type { CloudShadowFormat } from '../cloud/lighting/shadow-format';
import type { CloudShadowSpatialLayout } from '../cloud/lighting/shadow-spatial-layout';
import type { CloudTransportFormat } from '../cloud/reconstruction/history';
import {
  BLOOM_QUALITY_HIGH,
  isMultisampleAntialias,
  isTemporalAntialias,
} from '../components/camera';
import { isLensFlarePostProcess } from '../features/lens-flare';
import { isSmaaPostProcess } from '../features/smaa/shaders';
import { forwardOpaqueFogSplit } from '../pipeline/analytic-fog-pass';
import type { PremultipliedForwardOutput } from '../pipeline/standard-forward-output';
import type { StandardClusterTextureExtent } from '../pipeline/standard-lighting/texture';
import type {
  StandardLightingDeclaration,
  StandardTopologyInputValue,
} from '../pipeline/standard-lighting/topology';
import {
  nativeGradeOverlaysLinearImage,
  premultipliedOutlineActive,
  StandardOutputStage,
  standardAutoExposureMode,
  standardOutputStages,
  usesNativeGrade,
} from '../pipeline/standard-output/layout';
import { standardAoHzbLevels } from '../pipeline/standard-view-hzb';
import type { FrameObservationDomain } from '../render-contract';
import {
  type RenderPipelineFrame,
  type RenderPipelineTopology,
  resolveOutputDither,
} from '../render-pipeline';
import {
  type AmbientOcclusionSettings,
  DEFAULT_AMBIENT_OCCLUSION_METHOD,
  ssaoUsesLighting,
} from '../ssao-config';
import { renderTargetMipCount } from '../targets/contracts';
import type { RenderTargetPhysical } from '../targets/physical';
import { usesTsrCompute } from '../tsr/capabilities';
import type { _InternalRenderPipelineContext } from './render-context';

export type ForwardOutput = 'standard' | PremultipliedForwardOutput;
export type DisplayOutput = ForwardOutput | 'deferred';
type CameraGeometry = 'direct' | 'selection' | 'occlusion';

export function currentOutputDither(frame: RenderPipelineFrame): boolean {
  return resolveOutputDither(
    (frame as _InternalRenderPipelineContext).frameState.installedPipelineConfig,
  );
}

/** Only these stages change the attachment or shader selected by ordinary Standard output. */
class StandardDisplayStages {
  readonly hdr: boolean;
  readonly nativeGrade: boolean;
  readonly stages: number;
  readonly overlayLinear: boolean;
  readonly contract: NonNullable<RenderPipelineTopology['config']>['outputContract'];
  readonly dofSide:
    | NonNullable<RenderPipelineTopology['camera']['depthOfField']>['blurSide']
    | undefined;
  readonly dofCompute: boolean;
  readonly exposureMode: 'compute' | 'fragment' | undefined;
  readonly exposureHalfResolution: boolean;
  readonly lutSize: number | undefined;
  readonly temporal: ReturnType<typeof temporalResolveLayout>;
  readonly motionBlur: boolean;
  readonly coverage: boolean;
  readonly tsrMaximumScale: number | undefined;
  readonly lateForwardVelocity: boolean;

  constructor(topology: RenderPipelineTopology, observeLinear: boolean, stages: number) {
    this.hdr = usesHdrOutput(topology.camera, stages);
    this.nativeGrade = usesNativeGrade(topology);
    this.stages = physicalOutputStages(stages, this.hdr, this.nativeGrade);
    this.overlayLinear =
      this.nativeGrade && nativeGradeOverlaysLinearImage(topology.camera, observeLinear);
    this.contract = topology.config?.outputContract;
    this.dofSide = activeDepthOfFieldSide(topology, stages);
    this.dofCompute = this.dofSide !== undefined && topology.lane.storageTexture === true;
    this.exposureMode = activeExposureMode(topology, stages);
    this.exposureHalfResolution =
      this.exposureMode !== undefined && topology.output?.autoExposureHalfRes === true;
    this.lutSize = activeLutSize(topology, stages);
    this.temporal = temporalResolveLayout(topology);
    this.motionBlur = topology.temporal?.motionBlur === true;
    this.coverage = displayCoverageExtent(topology) !== undefined;
    this.tsrMaximumScale = tsrMaximumScale(topology);
    this.lateForwardVelocity = lateForwardVelocity(topology, this.temporal, this.motionBlur);
  }

  accepts(topology: RenderPipelineTopology, observeLinear: boolean, stages: number): boolean {
    const { camera } = topology;
    const native = usesNativeGrade(topology);
    const hdr = usesHdrOutput(camera, stages);
    return (
      this.hdr === hdr &&
      this.nativeGrade === native &&
      this.stages === physicalOutputStages(stages, hdr, native) &&
      this.overlayLinear === (native && nativeGradeOverlaysLinearImage(camera, observeLinear)) &&
      this.contract === topology.config?.outputContract &&
      this.acceptsOutputResources(topology, stages)
    );
  }

  private acceptsOutputResources(topology: RenderPipelineTopology, stages: number): boolean {
    const dofSide = activeDepthOfFieldSide(topology, stages);
    const exposureMode = activeExposureMode(topology, stages);
    return (
      this.dofSide === dofSide &&
      this.dofCompute === (dofSide !== undefined && topology.lane.storageTexture === true) &&
      this.exposureMode === exposureMode &&
      this.exposureHalfResolution ===
        (exposureMode !== undefined && topology.output?.autoExposureHalfRes === true) &&
      this.lutSize === activeLutSize(topology, stages) &&
      this.acceptsTemporal(topology)
    );
  }

  private acceptsTemporal(topology: RenderPipelineTopology): boolean {
    const temporal = temporalResolveLayout(topology);
    const motionBlur = topology.temporal?.motionBlur === true;
    return (
      this.temporal === temporal &&
      this.motionBlur === motionBlur &&
      this.coverage === (displayCoverageExtent(topology) !== undefined) &&
      this.tsrMaximumScale === tsrMaximumScale(topology) &&
      this.lateForwardVelocity === lateForwardVelocity(topology, temporal, motionBlur)
    );
  }
}

export function displayCoverageExtent({ camera, extent }: RenderPipelineTopology) {
  return camera.dynamicResolution === undefined ? undefined : extent;
}

function tsrMaximumScale({ camera }: RenderPipelineTopology): number | undefined {
  return camera.antialias === 'tsr' ? camera.dynamicResolution?.maxScale : undefined;
}

function lateForwardVelocity(
  topology: RenderPipelineTopology,
  temporal: StandardDisplayStages['temporal'],
  motionBlur: boolean,
): boolean {
  return (
    (temporal !== undefined || motionBlur) &&
    topology.opaque.lane === 'forward' &&
    topology.materialSceneDepth === true
  );
}

function usesHdrOutput(camera: RenderPipelineTopology['camera'], stages: number): boolean {
  return (
    camera.tonemap !== 'none' ||
    (stages & (StandardOutputStage.temporal | StandardOutputStage.bloom)) !== 0
  );
}

function temporalResolveLayout({ camera, lane }: RenderPipelineTopology) {
  if (camera.antialias === 'tsr') return usesTsrCompute(lane) ? 'tsr-compute' : 'tsr-raster';
  return isTemporalAntialias(camera.antialias) ? 'taa' : undefined;
}

function activeDepthOfFieldSide(topology: RenderPipelineTopology, stages: number) {
  return (stages & StandardOutputStage.depthOfField) === 0
    ? undefined
    : topology.camera.depthOfField?.blurSide;
}

function activeExposureMode(topology: RenderPipelineTopology, stages: number) {
  return (stages & StandardOutputStage.autoExposure) === 0
    ? undefined
    : standardAutoExposureMode(topology.lane);
}

function activeLutSize(topology: RenderPipelineTopology, stages: number): number | undefined {
  return (stages & StandardOutputStage.colorLut) === 0 ? undefined : topology.output?.lutSize;
}

function physicalOutputStages(stages: number, hdr: boolean, nativeGrade: boolean): number {
  const stage = StandardOutputStage;
  if (!hdr) stages &= ~stage.lensFlare;
  if (nativeGrade) stages &= ~(stage.whiteBalance | stage.chromaticAberration | stage.lensEffects);
  return stages;
}

function bloomLevels(camera: RenderPipelineTopology['camera']): number {
  return standardBloomAdmitted(camera) ? (camera.bloomQuality ?? BLOOM_QUALITY_HIGH) : 0;
}

/** The Deferred shaders, GBuffer attachments and imported light table used by this view.
 * Published light entries, material draws and per-frame channel values stay with the issuing frame. */
class DeferredDisplayPorts {
  readonly gbuffer: RenderPipelineTopology['compactGbuffer'];
  readonly receiver: RenderPipelineTopology['compactReceiver'];
  readonly subsurface: NonNullable<RenderPipelineTopology['subsurface']>['quality'] | undefined;
  readonly projected: boolean;
  readonly pcf: boolean;
  readonly perPixelAtmosphere: boolean | undefined;
  readonly lightProbes: boolean;
  readonly capsuleShadows: boolean;
  readonly localProbes: boolean;
  readonly gtao: number;

  constructor(topology: RenderPipelineTopology) {
    this.gbuffer = topology.compactGbuffer;
    this.receiver = topology.compactReceiver;
    this.subsurface = topology.subsurface?.quality;
    this.projected = topology.standardProfile?.deferredDirectionalShadowReceiver === 'projected';
    this.pcf = topology.deferredPcfLighting === true;
    this.perPixelAtmosphere = topology.perPixelAtmosphereTransmittance;
    this.lightProbes = topology.deferredLightProbes === true;
    this.capsuleShadows = topology.deferredCapsuleShadows === true;
    this.localProbes = topology.reflectionFallback?.localProbes === true;
    this.gtao = gtaoAttachments(topology);
  }

  accepts(topology: RenderPipelineTopology): boolean {
    return (
      this.gbuffer === topology.compactGbuffer &&
      this.receiver === topology.compactReceiver &&
      this.subsurface === topology.subsurface?.quality &&
      this.projected ===
        (topology.standardProfile?.deferredDirectionalShadowReceiver === 'projected') &&
      this.pcf === (topology.deferredPcfLighting === true) &&
      this.perPixelAtmosphere === topology.perPixelAtmosphereTransmittance &&
      this.lightProbes === (topology.deferredLightProbes === true) &&
      this.capsuleShadows === (topology.deferredCapsuleShadows === true) &&
      this.localProbes === (topology.reflectionFallback?.localProbes === true) &&
      this.gtao === gtaoAttachments(topology)
    );
  }
}

/** Zero represents no GTAO; the remaining values encode its depth pyramid and pass choices. */
function gtaoAttachments(topology: RenderPipelineTopology): number {
  const ao = topology.config?.ambientOcclusion;
  if (ao?.method !== 'gtao' || !ssaoUsesLighting(ao)) return 0;
  return (
    standardAoHzbLevels(topology) * 16 +
    Number(ao.gtao?.useNormals === true) * 8 +
    Number(ao.gtao?.downsample === true) * 4 +
    Number(ao.gtao?.spatialFilter !== false) * 2 +
    Number(ao.gtao?.temporalFilter !== false)
  );
}

type VolumeTopology = NonNullable<RenderPipelineTopology['volumetricFog']>;
type VolumeExtent = NonNullable<VolumeTopology['extent']>;

function lowVolumeQuality(topology: RenderPipelineTopology): boolean {
  return topology.standardProfile?.volumetricFog?.quality === 'low';
}

function sameVolumeExtent(a: VolumeExtent | undefined, b: VolumeExtent | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.width === b.width &&
      a.height === b.height &&
      a.depth === b.depth)
  );
}

function sameVolumeAttachments(
  bound: VolumeTopology | undefined,
  live: VolumeTopology | undefined,
): boolean {
  if (live?.enabled !== true) return bound === undefined;
  if (
    bound === undefined ||
    bound.format !== live.format ||
    (bound.projector !== undefined) !== (live.projector !== undefined) ||
    !sameVolumeExtent(bound.extent, live.extent) ||
    !sameVolumeExtent(bound.froxelExtent, live.froxelExtent) ||
    !sameVolumeExtent(bound.resolvedExtent, live.resolvedExtent)
  )
    return false;
  const before = bound.additional;
  const after = live.additional;
  if ((before?.length ?? 0) !== (after?.length ?? 0)) return false;
  if (before === undefined) return true;
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after?.[i];
    if (a?.format !== b?.format || !sameVolumeExtent(a?.extent, b?.extent)) return false;
  }
  return true;
}

function displayAtmosphere(topology: RenderPipelineTopology) {
  if (topology.atmosphere !== true) return 'none';
  if (topology.atmosphereBackgroundOnly === true) return 'sky';
  return topology.standardProfile?.atmosphere?.aerialPerspectiveQuality === 'fast' ? 'fast' : 'rgb';
}

function displayUsesPerPixelSolar(topology: RenderPipelineTopology): boolean {
  return (
    topology.atmosphere === true &&
    topology.atmosphereBackgroundOnly !== true &&
    topology.perPixelAtmosphereTransmittance !== false
  );
}

function observedTarget(output: DisplayOutput, observe: boolean) {
  return observe ? (typeof output === 'string' ? 'final-display' : output.targetName) : undefined;
}

const LINEAR_CAPTURE = ['linear-ldr'] as const;
const DISPLAY_CAPTURE = ['final-display'] as const;
const BOTH_CAPTURES = ['linear-ldr', 'final-display'] as const;

function projectedShadow(topology: RenderPipelineTopology) {
  const receiver = topology.forwardDirectionalShadow;
  return receiver?.mode === 'screen' ? receiver : undefined;
}

/** Only an admitted punctual projector imports the reflected native light-row buffer. */
export function shadowProjectionLightBytes(
  topology: RenderPipelineTopology,
  lights: StandardTopologyInputValue,
): number {
  return projectedShadow(topology)?.punctual !== undefined && lights.kind === 'clustered'
    ? lights.prepared.layout.lightDataSlotCount * lights.transport.lightDataSlotBytes
    : 0;
}

function sameShadowAttachments(
  first: ReturnType<typeof projectedShadow>,
  current: ReturnType<typeof projectedShadow>,
): boolean {
  if (first === undefined || current === undefined) return first === current;
  return (
    first.format === current.format &&
    first.width === current.width &&
    first.height === current.height &&
    first.directional === current.directional &&
    first.punctual?.point === current.punctual?.point &&
    first.punctual?.spot === current.punctual?.spot &&
    first.ambientOcclusion === current.ambientOcclusion
  );
}

/** Physical inputs of the validated built-in cloud producer. */
export interface CloudDisplayPorts {
  readonly format: CloudTransportFormat;
  readonly depthFormat: CloudTransportFormat;
  readonly shadowFormat: CloudShadowFormat;
  readonly shadowLayout: CloudShadowSpatialLayout | undefined;
  readonly planRevision: number;
  readonly preparedResourceKey: string | undefined;
}

/** Frame producers retain their GPU resources while each camera binds their exports. */
export interface WaterDisplayPorts {
  readonly viewIdentity: string;
  readonly immersion: 'underwater' | 'surface' | 'unavailable';
  readonly planRevision: number;
  readonly preparedResourceKey: string | undefined;
  readonly sharedTextures: string | undefined;
  readonly fluid: import('../water/fluid-graph').WaterFluidMaterialTopology | undefined;
}

export function cloudDisplayPorts(
  format: CloudTransportFormat | undefined,
  shadowLayout: CloudShadowSpatialLayout | undefined,
  planRevision: number,
  preparedResourceKey: string | undefined,
  depthFormat: CloudTransportFormat,
  shadowFormat: CloudShadowFormat,
): CloudDisplayPorts | undefined {
  return format === undefined
    ? undefined
    : { format, depthFormat, shadowFormat, shadowLayout, planRevision, preparedResourceKey };
}

export function matchesCloudDisplayPorts(
  ports: DisplayPorts,
  format: CloudTransportFormat | undefined,
  shadowLayout: CloudShadowSpatialLayout | undefined,
  planRevision: number,
  preparedResourceKey: string | undefined,
  depthFormat: CloudTransportFormat,
  shadowFormat: CloudShadowFormat,
): boolean {
  const cloud = ports.cloud;
  return format === undefined
    ? cloud === undefined
    : cloud !== undefined &&
        cloud.format === format &&
        cloud.depthFormat === depthFormat &&
        cloud.shadowFormat === shadowFormat &&
        sameCloudShadowLayout(cloud.shadowLayout, shadowLayout) &&
        cloud.planRevision === planRevision &&
        cloud.preparedResourceKey === preparedResourceKey;
}

function sameCloudShadowLayout(
  previous: CloudShadowSpatialLayout | undefined,
  current: CloudShadowSpatialLayout | undefined,
): boolean {
  if (previous === undefined || current === undefined) return previous === current;
  return (
    previous.rawResolution === current.rawResolution &&
    previous.filteredResolution === current.filteredResolution &&
    previous.traceTarget === current.traceTarget &&
    previous.passes.length === current.passes.length &&
    previous.passes.every((pass, index) => pass.resolution === current.passes[index]?.resolution)
  );
}

function orderedReflectionMode(topology: RenderPipelineTopology) {
  if (topology.inlineSsr === true) return 'forward-inline';
  if (topology.ssr?.status === 'admitted')
    return topology.opaque.lane === 'deferred' ? 'deferred-spatial' : 'forward-spatial';
  return topology.reflectionFallback?.enabled === true ? 'fallback' : 'off';
}

function spatialSsrBudget(topology: RenderPipelineTopology) {
  return topology.ssr?.status === 'admitted' && topology.inlineSsr !== true
    ? topology.standardProfile?.quality?.ssr
    : undefined;
}

function matchingSsrBudget(
  bound: import('../quality').RenderQualityBudgets['ssr'] | undefined,
  current: import('../quality').RenderQualityBudgets['ssr'] | undefined,
): boolean {
  return (
    bound?.resolutionScale === current?.resolutionScale &&
    bound?.hizIterations === current?.hizIterations &&
    bound?.linearIterations === current?.linearIterations &&
    bound?.refineSteps === current?.refineSteps
  );
}

/** The effect participates in stock view recording only when those stages own its surfaces. */
function admitsOrderedReflections(topology: RenderPipelineTopology, output: DisplayOutput) {
  const mode = orderedReflectionMode(topology);
  if (mode === 'off') return true;
  switch (output) {
    case 'deferred':
      return mode === 'deferred-spatial' || mode === 'fallback';
    case 'standard':
      return mode === 'forward-inline' || mode === 'forward-spatial' || mode === 'fallback';
    default:
      return false;
  }
}

/** Only the light features that change the Forward screen-data format or passes. */
function forwardScreenLighting(topology: RenderPipelineTopology): number {
  if (topology.opaque.lane !== 'forward') return 0;
  return (
    Number(topology.forwardContactShadows === true) +
    2 * Number(topology.forwardCapsuleShadows === true) +
    4 * Number((topology.projectedDecals?.length ?? 0) !== 0)
  );
}

function sameDecalLayout(
  bound: RenderPipelineTopology['projectedDecals'],
  current: RenderPipelineTopology['projectedDecals'],
): boolean {
  if (bound === current) return true;
  if (bound === undefined || current === undefined || bound.length !== current.length) return false;
  for (let index = 0; index < bound.length; index++) {
    const a = bound[index];
    const b = current[index];
    if (a === undefined || b === undefined || a.length !== b.length) return false;
    for (let slot = 0; slot < a.length; slot++) {
      const boundTexture = a[slot];
      const currentTexture = b[slot];
      if (boundTexture === currentTexture) continue;
      if (boundTexture === undefined || currentTexture === undefined) return false;
      if (
        boundTexture.format !== currentTexture.format ||
        boundTexture.mipLevelCount !== currentTexture.mipLevelCount ||
        boundTexture.usage !== currentTexture.usage ||
        boundTexture.size.width !== currentTexture.size.width ||
        boundTexture.size.height !== currentTexture.size.height
      )
        return false;
    }
  }
  return true;
}

// Material membership is live. Only the existence of a regular backdrop,
// its mip layout and the residual lane shape affect the medium declaration.
function mediumLayout(topology: RenderPipelineTopology): number {
  if (topology.singleLayerMedium !== true) return 0;
  const demand = topology.transmissionDemand;
  return (
    1 +
    2 * Number((demand?.activeCount ?? 0) !== 0) +
    4 * Number(demand?.needsRoughMips === true) +
    8 * Number(topology.transparency?.residual === true)
  );
}

type PlanarDescriptor = RenderTargetPhysical['descriptor'];

function matchesPlanarDescriptor(
  bound: PlanarDescriptor | undefined,
  current: PlanarDescriptor | undefined,
) {
  if (bound === current) return true;
  if (bound === undefined || current === undefined) return false;
  return (
    bound.width === current.width &&
    bound.height === current.height &&
    bound.format === current.format &&
    renderTargetMipCount(bound) === renderTargetMipCount(current)
  );
}

/** Attachments and resource reads owned by the installed display passes. */
export class DisplayPorts {
  readonly forwardShadow: ReturnType<typeof projectedShadow>;
  readonly forwardScreenLighting: number;
  readonly medium: number;
  readonly decals: RenderPipelineTopology['projectedDecals'];
  readonly aoMethod: AmbientOcclusionSettings['method'];
  readonly aoQuality: AmbientOcclusionSettings['quality'];
  readonly aoMaxQuality: number | undefined;
  readonly aoLevels: AmbientOcclusionSettings['levels'];
  readonly lane: 'forward' | 'deferred';
  readonly reflection: ReturnType<typeof orderedReflectionMode>;
  readonly ssrBudget: ReturnType<typeof spatialSsrBudget>;
  readonly volume: VolumeTopology | undefined;
  readonly lowVolumeQuality: boolean;
  readonly analyticFog: boolean;
  readonly atmosphere: ReturnType<typeof displayAtmosphere>;
  readonly perPixelSolar: boolean;
  readonly forwardUnfogged: boolean;
  readonly deferred: DeferredDisplayPorts | undefined;
  readonly width: number;
  readonly height: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly storage: string;
  readonly view: string;
  readonly surfaceKind: string | undefined;

  readonly samples: 1 | 4;
  readonly bloomLevels: number;
  readonly bloomPrefilter: boolean;
  readonly multisampledResidual: boolean | undefined;
  readonly color: PremultipliedForwardOutput['format'];
  readonly compute: boolean;
  readonly directional: boolean;
  readonly pointFaceSize: number;
  readonly spotMapSize: number;
  readonly standardPost: StandardDisplayStages | undefined;
  readonly premultipliedOutline: boolean;
  readonly observedTarget: string | undefined;

  constructor(
    topology: RenderPipelineTopology,
    output: DisplayOutput,
    readonly weighted: boolean,
    readonly geometry: CameraGeometry,
    readonly cullShadowReceivers: boolean,
    observeDisplay: boolean,
    readonly observeLinear: boolean,
    readonly textureLighting: boolean,
    readonly clusterTextureExtent: StandardClusterTextureExtent | undefined,
    readonly shadowLightBytes: number,
    readonly lighting: StandardLightingDeclaration | undefined,
    postStages: number,
    readonly cloud?: CloudDisplayPorts,
    readonly planar?: PlanarDescriptor,
    readonly water?: WaterDisplayPorts,
  ) {
    this.forwardShadow = projectedShadow(topology);
    this.forwardScreenLighting = forwardScreenLighting(topology);
    this.medium = mediumLayout(topology);
    this.decals = topology.projectedDecals;
    const { surface, extent } = topology;
    const ao = topology.config?.ambientOcclusion ?? topology.standardProfile?.ambientOcclusion;
    const active = ssaoUsesLighting(ao) ? ao : undefined;
    this.aoMethod =
      active === undefined ? undefined : (active.method ?? DEFAULT_AMBIENT_OCCLUSION_METHOD);
    const ssao = output === 'deferred' && this.aoMethod === 'gtao' ? undefined : active;
    this.aoQuality = ssao?.quality;
    this.aoMaxQuality = ssao?.maxQuality;
    this.aoLevels = ssao?.levels;
    this.lane = output === 'deferred' ? 'deferred' : 'forward';
    this.reflection = orderedReflectionMode(topology);
    this.ssrBudget = spatialSsrBudget(topology);
    this.atmosphere = displayAtmosphere(topology);
    this.perPixelSolar = displayUsesPerPixelSolar(topology);
    this.forwardUnfogged = forwardOpaqueFogSplit(topology);
    this.analyticFog = this.lane === 'deferred' && topology.analyticFog === true;
    this.volume = topology.volumetricFog?.enabled === true ? topology.volumetricFog : undefined;
    this.lowVolumeQuality = lowVolumeQuality(topology);
    this.deferred = output === 'deferred' ? new DeferredDisplayPorts(topology) : undefined;
    const shadow = topology.shadow;
    this.directional = shadow.directional !== 'disabled';
    this.spotMapSize = shadow.spotCount > 0 ? shadow.spotMapSize : 0;
    this.pointFaceSize = shadow.pointCount > 0 ? shadow.pointFaceSize : 0;
    this.samples = displaySampleCount(topology);
    this.multisampledResidual = this.samples === 4 ? topology.transparency?.residual : undefined;
    this.bloomLevels = bloomLevels(topology.camera);
    this.bloomPrefilter = this.bloomLevels !== 0 && topology.camera.bloomPrefilter === true;
    this.color = typeof output === 'string' ? 'rgba16float' : output.format;
    this.compute = topology.lane.compute;
    this.standardPost =
      typeof output === 'string'
        ? new StandardDisplayStages(topology, observeLinear, postStages)
        : undefined;
    this.premultipliedOutline =
      typeof output !== 'string' && (postStages & StandardOutputStage.outline) !== 0;
    this.observedTarget = observedTarget(output, observeDisplay);
    this.width = surface.width;
    this.height = surface.height;
    this.internalWidth = extent?.internalWidth ?? surface.width;
    this.internalHeight = extent?.internalHeight ?? surface.height;
    this.storage = surface.storageFormat;
    this.view = surface.viewFormat;
    this.surfaceKind = surface.profile?.kind;
  }

  get captureDomains(): readonly FrameObservationDomain[] | undefined {
    if (this.observeLinear)
      return this.observedTarget === undefined ? LINEAR_CAPTURE : BOTH_CAPTURES;
    return this.observedTarget === undefined ? undefined : DISPLAY_CAPTURE;
  }

  accepts(
    topology: RenderPipelineTopology,
    output: DisplayOutput,
    weighted: boolean,
    geometry: CameraGeometry,
    cullShadowReceivers: boolean,
    observeDisplay: boolean,
    observeLinear: boolean,
    textureLighting: boolean,
    shadowLightBytes: number,
    postStages: number,
    planar?: PlanarDescriptor,
  ): boolean {
    return (
      this.acceptsAmbientOcclusion(topology) &&
      this.acceptsFog(topology) &&
      this.acceptsScreenLighting(topology) &&
      this.medium === mediumLayout(topology) &&
      matchesPlanarDescriptor(this.planar, planar) &&
      this.reflection === orderedReflectionMode(topology) &&
      matchingSsrBudget(this.ssrBudget, spatialSsrBudget(topology)) &&
      this.acceptsSurface(topology) &&
      this.samples === displaySampleCount(topology) &&
      (this.samples === 1 || this.multisampledResidual === topology.transparency?.residual) &&
      this.compute === topology.lane.compute &&
      this.textureLighting === textureLighting &&
      this.acceptsShadows(topology, shadowLightBytes) &&
      this.acceptsOutput(topology, output, observeLinear, postStages) &&
      this.weighted === weighted &&
      this.geometry === geometry &&
      this.cullShadowReceivers === cullShadowReceivers &&
      this.observeLinear === observeLinear &&
      this.observedTarget === observedTarget(output, observeDisplay)
    );
  }

  private acceptsScreenLighting(topology: RenderPipelineTopology): boolean {
    return (
      this.forwardScreenLighting === forwardScreenLighting(topology) &&
      sameDecalLayout(this.decals, topology.projectedDecals)
    );
  }

  private acceptsAmbientOcclusion(topology: RenderPipelineTopology): boolean {
    const ao = topology.config?.ambientOcclusion ?? topology.standardProfile?.ambientOcclusion;
    const active = ssaoUsesLighting(ao) ? ao : undefined;
    const ssao = this.lane === 'deferred' && active?.method === 'gtao' ? undefined : active;
    return (
      this.aoMethod ===
        (active === undefined ? undefined : (active.method ?? DEFAULT_AMBIENT_OCCLUSION_METHOD)) &&
      this.aoQuality === ssao?.quality &&
      this.aoMaxQuality === ssao?.maxQuality &&
      this.aoLevels === ssao?.levels
    );
  }

  private acceptsFog(topology: RenderPipelineTopology): boolean {
    return (
      this.analyticFog === (this.lane === 'deferred' && topology.analyticFog === true) &&
      this.atmosphere === displayAtmosphere(topology) &&
      this.perPixelSolar === displayUsesPerPixelSolar(topology) &&
      this.forwardUnfogged === forwardOpaqueFogSplit(topology) &&
      sameVolumeAttachments(this.volume, topology.volumetricFog) &&
      (this.volume === undefined || this.lowVolumeQuality === lowVolumeQuality(topology))
    );
  }

  private acceptsSurface({ surface, extent }: RenderPipelineTopology): boolean {
    return (
      this.width === surface.width &&
      this.height === surface.height &&
      this.internalWidth === (extent?.internalWidth ?? surface.width) &&
      this.internalHeight === (extent?.internalHeight ?? surface.height) &&
      this.storage === surface.storageFormat &&
      this.view === surface.viewFormat &&
      this.surfaceKind === surface.profile?.kind
    );
  }

  private acceptsOutput(
    topology: RenderPipelineTopology,
    output: DisplayOutput,
    observeLinear: boolean,
    postStages: number,
  ): boolean {
    const levels = bloomLevels(topology.camera);
    if (
      this.bloomLevels !== levels ||
      this.bloomPrefilter !== (levels !== 0 && topology.camera.bloomPrefilter === true)
    )
      return false;
    if (output === 'deferred') {
      if (this.deferred?.accepts(topology) !== true) return false;
    } else if (this.lane !== 'forward') {
      return false;
    }
    return typeof output === 'string'
      ? this.standardPost?.accepts(topology, observeLinear, postStages) === true
      : this.standardPost === undefined &&
          this.color === output.format &&
          this.premultipliedOutline === ((postStages & StandardOutputStage.outline) !== 0);
  }

  private acceptsShadows(topology: RenderPipelineTopology, lightBytes: number): boolean {
    return (
      this.shadowLightBytes === lightBytes &&
      sameShadowAttachments(this.forwardShadow, projectedShadow(topology)) &&
      this.directional === (topology.shadow.directional !== 'disabled') &&
      this.spotMapSize === (topology.shadow.spotCount > 0 ? topology.shadow.spotMapSize : 0) &&
      this.pointFaceSize === (topology.shadow.pointCount > 0 ? topology.shadow.pointFaceSize : 0)
    );
  }
}

function admitsOrderedLane(topology: RenderPipelineTopology, output: DisplayOutput): boolean {
  if (output === 'deferred') {
    const profile = topology.standardProfile;
    return (
      topology.opaque.lane === 'deferred' &&
      !isMultisampleAntialias(topology.camera.antialias) &&
      !profile?.visibleSurface &&
      profile?.diffuseGi === undefined
    );
  }
  return (
    output !== 'standard' ||
    (topology.opaque.lane === 'forward' && topology.standardProfile?.renderPath !== 'deferred')
  );
}

function admitsOrderedPost(
  topology: RenderPipelineTopology,
  output: DisplayOutput,
  rgba16floatRenderable: boolean,
  stages: number,
): boolean {
  const { camera } = topology;
  const effects = topology.config?.postEffects;
  if (typeof output !== 'string')
    return !effects?.length && !topology.output?.autoExposure && !topology.output?.colorLut;
  return (
    !camera.editorOutline &&
    ((stages & StandardOutputStage.depthOfField) === 0 ||
      !topology.transmissionDemand?.activeCount) &&
    ((!camera.chromaticAberration && !camera.lensEffects) ||
      (rgba16floatRenderable && usesNativeGrade(topology))) &&
    typeof camera.outline !== 'object' &&
    !topology.preTemporalEffects?.length &&
    !topology.hdrOutputEffects?.length &&
    !effects?.some((effect) => !isSmaaPostProcess(effect) && !isLensFlarePostProcess(effect))
  );
}

function admitsOrderedScreenLighting(topology: RenderPipelineTopology, output: DisplayOutput) {
  return typeof output === 'string' || forwardScreenLighting(topology) === 0;
}

function admitsOrderedScene(topology: RenderPipelineTopology, output: DisplayOutput): boolean {
  return (
    admitsOrderedScreenLighting(topology, output) &&
    !topology.sceneDataBindings?.length &&
    admitsOrderedReflections(topology, output) &&
    (output === 'deferred' || !topology.deferredLightProbes) &&
    (output === 'deferred' || !topology.subsurface) &&
    (output === 'deferred' || !topology.compactGbuffer) &&
    (typeof output === 'string' || (!topology.water && !topology.singleLayerMedium))
  );
}

function admitsOrderedShadows({ shadow }: RenderPipelineTopology): boolean {
  return (
    (shadow.directional === 'disabled' ||
      (shadow.directional.staticLayer === false && !shadow.directional.terrainReceivers?.length)) &&
    !shadow.pointStaticMask &&
    !shadow.spotStaticMask
  );
}

function displaySampleCount(topology: RenderPipelineTopology): 1 | 4 {
  return isMultisampleAntialias(topology.camera.antialias) && topology.lane.multisample ? 4 : 1;
}

/** Multisampled transmission and material depth need independent resolved copies. */
function admitsDisplaySamples(topology: RenderPipelineTopology, output: DisplayOutput): boolean {
  return (
    displaySampleCount(topology) === 1 ||
    (output !== 'deferred' &&
      !topology.materialSceneDepth &&
      (!topology.transmissionDemand?.activeCount || topology.singleLayerMedium === true))
  );
}

function admitsOrderedTemporal(topology: RenderPipelineTopology, output: DisplayOutput): boolean {
  if (
    !isTemporalAntialias(topology.camera.antialias) &&
    !topology.temporal?.motionBlur &&
    topology.camera.dynamicResolution === undefined
  )
    return true;
  return (
    typeof output === 'string' &&
    (!topology.transmissionDemand?.activeCount || topology.singleLayerMedium === true)
  );
}

/** The output owns tone mapping and display encoding. Other physical products
 * keep their declared inputs and outputs with the Standard stage that issues them. */
export function admitOrderedDisplay(
  topology: RenderPipelineTopology,
  output: DisplayOutput | undefined,
  rgba16floatRenderable: boolean,
): number | undefined {
  if (output === undefined) return undefined;
  const { camera, surface } = topology;
  const postStages =
    typeof output === 'string'
      ? standardOutputStages(topology)
      : premultipliedOutlineActive(camera)
        ? StandardOutputStage.outline
        : 0;
  const admitted =
    (surface.storageFormat === 'rgba8unorm' || surface.storageFormat === 'bgra8unorm') &&
    admitsOrderedLane(topology, output) &&
    !topology.clearOnly &&
    admitsDisplaySamples(topology, output) &&
    admitsOrderedTemporal(topology, output) &&
    admitsOrderedPost(topology, output, rgba16floatRenderable, postStages) &&
    admitsOrderedScene(topology, output) &&
    admitsOrderedShadows(topology) &&
    !camera.editorAssistance;
  return admitted ? postStages : undefined;
}
