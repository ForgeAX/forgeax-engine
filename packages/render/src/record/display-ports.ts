import { standardBloomAdmitted } from '../bloom-admission';
import { isFxaaAntialias, isMultisampleAntialias, isTemporalAntialias } from '../components/camera';
import type { PremultipliedForwardOutput } from '../pipeline/standard-forward-output';
import type { StandardClusterTextureExtent } from '../pipeline/standard-lighting/texture';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import {
  nativeGradeOverlaysLinearImage,
  usesNativeGrade,
} from '../pipeline/standard-output/layout';
import type { FrameObservationDomain } from '../render-contract';
import {
  type RenderPipelineFrame,
  type RenderPipelineTopology,
  resolveOutputDither,
} from '../render-pipeline';
import type { ShadowDepthLayers } from '../shadow-depth-layers';
import {
  type AmbientOcclusionSettings,
  DEFAULT_AMBIENT_OCCLUSION_METHOD,
  ssaoUsesLighting,
} from '../ssao-config';
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
  readonly bloom: boolean;
  readonly fxaa: boolean;
  readonly nativeGrade: boolean;
  readonly whiteBalance: boolean;
  readonly overlayLinear: boolean;
  readonly contract: NonNullable<RenderPipelineTopology['config']>['outputContract'];

  constructor(topology: RenderPipelineTopology, observeLinear: boolean) {
    this.bloom = standardBloomAdmitted(topology.camera);
    this.hdr = topology.camera.tonemap !== 'none' || this.bloom;
    this.fxaa =
      topology.camera.postProcessing !== false && isFxaaAntialias(topology.camera.antialias);
    const native = usesNativeGrade(topology);
    this.nativeGrade = native;
    this.whiteBalance =
      !native && topology.camera.postProcessing !== false && topology.output?.whiteBalance === true;
    this.overlayLinear = native && nativeGradeOverlaysLinearImage(topology.camera, observeLinear);
    this.contract = topology.config?.outputContract;
  }

  accepts(topology: RenderPipelineTopology, observeLinear: boolean): boolean {
    const { camera } = topology;
    const native = usesNativeGrade(topology);
    const bloom = standardBloomAdmitted(camera);
    return (
      this.bloom === bloom &&
      this.hdr === (camera.tonemap !== 'none' || bloom) &&
      this.fxaa === (camera.postProcessing !== false && isFxaaAntialias(camera.antialias)) &&
      this.whiteBalance ===
        (!native && camera.postProcessing !== false && topology.output?.whiteBalance === true) &&
      this.overlayLinear === (native && nativeGradeOverlaysLinearImage(camera, observeLinear)) &&
      this.contract === topology.config?.outputContract
    );
  }
}

/** The Deferred shaders, GBuffer attachments and imported light table used by this view.
 * Published light entries, material draws and per-frame channel values stay with the issuing frame. */
class DeferredDisplayPorts {
  readonly gbuffer: RenderPipelineTopology['compactGbuffer'];
  readonly receiver: RenderPipelineTopology['compactReceiver'];
  readonly projected: boolean;
  readonly pcf: boolean;
  readonly lighting: string | undefined;
  readonly perPixelAtmosphere: boolean | undefined;
  readonly lightProbes: boolean;

  constructor(topology: RenderPipelineTopology) {
    this.gbuffer = topology.compactGbuffer;
    this.receiver = topology.compactReceiver;
    this.projected = topology.standardProfile?.deferredDirectionalShadowReceiver === 'projected';
    this.pcf = topology.deferredPcfLighting === true;
    this.lighting = topology.standardLightingTopologySignature;
    this.perPixelAtmosphere = topology.perPixelAtmosphereTransmittance;
    this.lightProbes = topology.deferredLightProbes === true;
  }

  accepts(topology: RenderPipelineTopology): boolean {
    return (
      this.gbuffer === topology.compactGbuffer &&
      this.receiver === topology.compactReceiver &&
      this.projected ===
        (topology.standardProfile?.deferredDirectionalShadowReceiver === 'projected') &&
      this.pcf === (topology.deferredPcfLighting === true) &&
      this.lighting === topology.standardLightingTopologySignature &&
      this.perPixelAtmosphere === topology.perPixelAtmosphereTransmittance &&
      this.lightProbes === (topology.deferredLightProbes === true)
    );
  }
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

/** Attachments and resource reads owned by the installed display passes. */
export class DisplayPorts {
  readonly forwardShadow: ReturnType<typeof projectedShadow>;
  readonly aoMethod: AmbientOcclusionSettings['method'];
  readonly aoQuality: AmbientOcclusionSettings['quality'];
  readonly aoMaxQuality: number | undefined;
  readonly aoLevels: AmbientOcclusionSettings['levels'];
  readonly lane: 'forward' | 'deferred';
  readonly deferred: DeferredDisplayPorts | undefined;
  readonly width: number;
  readonly height: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly storage: string;
  readonly view: string;
  readonly surfaceKind: string | undefined;

  readonly color: PremultipliedForwardOutput['format'];
  readonly compute: boolean;
  readonly directional: boolean;
  readonly pointFaceSize: number;
  readonly spotMapSize: number;
  readonly #depthLayers: ShadowDepthLayers | undefined;
  readonly standardPost: StandardDisplayStages | undefined;
  readonly observedTarget: string | undefined;

  constructor(
    topology: RenderPipelineTopology,
    output: DisplayOutput,
    readonly weighted: boolean,
    readonly geometry: CameraGeometry,
    readonly cullShadowReceivers: boolean,
    depthLayers: ShadowDepthLayers,
    observeDisplay: boolean,
    readonly observeLinear: boolean,
    readonly textureLighting: string | undefined,
    readonly clusterTextureExtent: StandardClusterTextureExtent | undefined,
    readonly shadowLightBytes: number,
  ) {
    this.forwardShadow = projectedShadow(topology);
    const { surface, extent } = topology;
    const ao = topology.config?.ambientOcclusion ?? topology.standardProfile?.ambientOcclusion;
    const active = ssaoUsesLighting(ao) ? ao : undefined;
    this.aoMethod =
      active === undefined ? undefined : (active.method ?? DEFAULT_AMBIENT_OCCLUSION_METHOD);
    this.aoQuality = active?.quality;
    this.aoMaxQuality = active?.maxQuality;
    this.aoLevels = active?.levels;
    this.lane = output === 'deferred' ? 'deferred' : 'forward';
    this.deferred = output === 'deferred' ? new DeferredDisplayPorts(topology) : undefined;
    const shadow = topology.shadow;
    this.directional = shadow.directional !== 'disabled';
    this.spotMapSize = shadow.spotCount > 0 ? shadow.spotMapSize : 0;
    this.pointFaceSize = shadow.pointCount > 0 ? shadow.pointFaceSize : 0;
    this.#depthLayers = this.directional || this.spotMapSize > 0 ? depthLayers : undefined;
    this.color = typeof output === 'string' ? 'rgba16float' : output.format;
    this.compute = topology.lane.compute;
    this.standardPost =
      typeof output === 'string' ? new StandardDisplayStages(topology, observeLinear) : undefined;
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
    depthLayers: ShadowDepthLayers,
    observeDisplay: boolean,
    observeLinear: boolean,
    textureLighting: string | undefined,
    shadowLightBytes: number,
  ): boolean {
    return (
      this.acceptsAmbientOcclusion(topology) &&
      this.acceptsSurface(topology) &&
      this.compute === topology.lane.compute &&
      this.textureLighting === textureLighting &&
      this.acceptsShadows(topology, shadowLightBytes, depthLayers) &&
      this.acceptsOutput(topology, output, observeLinear) &&
      this.weighted === weighted &&
      this.geometry === geometry &&
      this.cullShadowReceivers === cullShadowReceivers &&
      this.observeLinear === observeLinear &&
      this.observedTarget === observedTarget(output, observeDisplay)
    );
  }

  private acceptsAmbientOcclusion(topology: RenderPipelineTopology): boolean {
    const ao = topology.config?.ambientOcclusion ?? topology.standardProfile?.ambientOcclusion;
    const active = ssaoUsesLighting(ao) ? ao : undefined;
    return (
      this.aoMethod ===
        (active === undefined ? undefined : (active.method ?? DEFAULT_AMBIENT_OCCLUSION_METHOD)) &&
      this.aoQuality === active?.quality &&
      this.aoMaxQuality === active?.maxQuality &&
      this.aoLevels === active?.levels
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
  ): boolean {
    if (output === 'deferred') {
      if (this.deferred?.accepts(topology) !== true) return false;
    } else if (this.lane !== 'forward') {
      return false;
    }
    return typeof output === 'string'
      ? this.standardPost?.accepts(topology, observeLinear) === true
      : this.standardPost === undefined && this.color === output.format;
  }

  private acceptsShadows(
    topology: RenderPipelineTopology,
    lightBytes: number,
    depthLayers: ShadowDepthLayers,
  ): boolean {
    return (
      this.shadowLightBytes === lightBytes &&
      sameShadowAttachments(this.forwardShadow, projectedShadow(topology)) &&
      this.directional === (topology.shadow.directional !== 'disabled') &&
      this.spotMapSize === (topology.shadow.spotCount > 0 ? topology.shadow.spotMapSize : 0) &&
      this.pointFaceSize === (topology.shadow.pointCount > 0 ? topology.shadow.pointFaceSize : 0) &&
      (this.#depthLayers === undefined || this.#depthLayers === depthLayers)
    );
  }
}

function admitsOrderedLane(topology: RenderPipelineTopology, output: DisplayOutput): boolean {
  if (output === 'deferred') {
    const ao = topology.config?.ambientOcclusion;
    return (
      // The general graph owns GTAO history and its optional velocity input.
      !(ssaoUsesLighting(ao) && ao?.method === 'gtao') &&
      topology.opaque.lane === 'deferred' &&
      topology.standardProfile?.renderPath === 'deferred' &&
      !isMultisampleAntialias(topology.camera.antialias) &&
      !topology.standardProfile.visibleSurface &&
      topology.standardProfile.diffuseGi === undefined &&
      !topology.reflectionFallback?.localProbes
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
): boolean {
  const { camera } = topology;
  if (typeof output !== 'string') return !standardBloomAdmitted(camera);
  return (
    camera.antialias !== 'smaa' &&
    !camera.editorOutline &&
    !camera.depthOfField &&
    ((!camera.chromaticAberration && !camera.lensEffects) ||
      (rgba16floatRenderable && usesNativeGrade(topology))) &&
    !camera.lensFlare &&
    !camera.outline &&
    !camera.barrelDistortion &&
    !topology.preTemporalEffects?.length
  );
}

function admitsOrderedScene(topology: RenderPipelineTopology, output: DisplayOutput): boolean {
  return (
    !topology.forwardContactShadows &&
    !topology.forwardCapsuleShadows &&
    !topology.projectedDecals?.length &&
    !topology.sceneDataBindings?.length &&
    !topology.reflectionFallback?.enabled &&
    (output === 'deferred' || !topology.deferredLightProbes) &&
    topology.ssr?.status !== 'admitted' &&
    !topology.subsurface &&
    (output === 'deferred' || !topology.compactGbuffer) &&
    !topology.atmosphere &&
    !topology.analyticFog &&
    !topology.volumetricFog?.enabled &&
    !topology.water &&
    !topology.singleLayerMedium
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

/** The output owns tone mapping and display encoding. Other physical products
 * keep their declared inputs and outputs with the Standard stage that issues them. */
export function admitsOrderedDisplay(
  topology: RenderPipelineTopology,
  output: DisplayOutput,
  rgba16floatRenderable: boolean,
): boolean {
  const { camera, surface } = topology;
  return (
    (surface.storageFormat === 'rgba8unorm' || surface.storageFormat === 'bgra8unorm') &&
    admitsOrderedLane(topology, output) &&
    !topology.clearOnly &&
    !(isMultisampleAntialias(camera.antialias) && topology.lane.multisample) &&
    !isTemporalAntialias(camera.antialias) &&
    camera.dynamicResolution === undefined &&
    !topology.temporal?.motionBlur &&
    admitsOrderedPost(topology, output, rgba16floatRenderable) &&
    admitsOrderedScene(topology, output) &&
    !topology.output?.autoExposure &&
    !topology.output?.colorLut &&
    admitsOrderedShadows(topology) &&
    !topology.config?.postEffects?.length &&
    !camera.editorAssistance
  );
}
