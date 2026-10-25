import type {
  CompiledRenderGraphInfo,
  GraphAccess,
  GraphTextureDescriptor,
  GraphTextureView,
} from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, mipDimension, ok, type Result, textureFormatBlock } from '@forgeax/engine-types';
import { standardBloomAdmitted } from '../bloom-admission';
import { addTypedDebugOverlayPass } from '../debug-draw-glue';
import { addGradientSkyDisplayPass } from '../environment/gradient-sky';
import type { GraphAtmosphere } from '../environment/luts';
import { RenderFeatureCapabilityMissingError, SceneDataUnavailableError } from '../errors/render';
import {
  BARREL_DISTORTION_FEATURE_IDENTITY,
  BARREL_DISTORTION_POST_PROCESS_ID,
} from '../features/barrel-distortion';
import { addDepthOfFieldPasses } from '../features/depth-of-field/depth-of-field-feature';
import { LENS_EFFECTS_POST_PROCESS_ID } from '../features/lens-effects';
import { isLensFlarePostProcess, LENS_FLARE_POST_PROCESS_ID } from '../features/lens-flare';
import { addLensFlarePasses } from '../features/lens-flare-graph';
import { addMotionBlurPass } from '../features/motion-blur/motion-blur-feature';
import { addOutlinePasses } from '../features/outline/graph';
import { isOutlinePostProcess } from '../features/outline/shaders';
import { addSmaaPasses } from '../features/smaa/graph';
import { isSmaaPostProcess } from '../features/smaa/shaders';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import type {
  RenderPipelineBuildContext,
  RenderPipelineBuildError,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';
import {
  createRenderPipelineTarget,
  type RenderPipelineTarget,
  resolveOutputDither,
} from '../render-pipeline';
import {
  addObservationCapturePass,
  addTypedBloomPasses,
  addTypedCompositePostEffects,
  addTypedFullscreenPass,
  addTypedOutputTransformPass,
  addTypedTemporalResolvePass,
  type TemporalSecondaryReactivity,
  TYPED_BLOOM_PASS_NAMES,
  type TypedTemporalResolveTargets,
} from '../typed-render-graph-primitives';
import { renderExtentSize } from './render-extent';
import {
  addAutoExposureExposurePass,
  addAutoExposureGraphPasses,
} from './standard-output/auto-exposure/gpu';
import { createStandardOutputPlan } from './standard-output/graph';
import { addStandardColorLutPass } from './standard-output/lut-gpu';
import { addStandardToneLutPass } from './standard-output/tone-lut';
import type { StandardOutputPlan } from './standard-output/types';

export interface StandardPostSurface {
  readonly display?: RenderPipelineTarget;
  readonly storage: RenderPipelineTarget;
}

const STANDARD_BLOOM_MAX_LEVELS = 5;

/** One authored Bloom contract drives declaration and compiled-graph validation. */
const STANDARD_BLOOM_TARGET_SPEC = {
  composited: { label: 'bloom-composited', format: 'rgba16float' },
  horizontalPrefix: 'bloom-horizontal-',
  verticalPrefix: 'bloom-vertical-',
} as const;

interface StandardBloomLevelDimensions {
  readonly width: number;
  readonly height: number;
}

/** Derive the bounded ceil-halving output pyramid, including D0. */
function deriveStandardBloomLevels(
  outputWidth: number,
  outputHeight: number,
): readonly StandardBloomLevelDimensions[] {
  const levels: StandardBloomLevelDimensions[] = [];
  let width = Math.max(1, Math.ceil(outputWidth / 2));
  let height = Math.max(1, Math.ceil(outputHeight / 2));
  for (let level = 0; level < STANDARD_BLOOM_MAX_LEVELS; level += 1) {
    levels.push({ width, height });
    width = Math.max(1, Math.ceil(width / 2));
    height = Math.max(1, Math.ceil(height / 2));
  }
  return levels;
}

interface StandardBloomTargetSpecs {
  readonly composited: GraphTextureDescriptor & { readonly label: string };
  readonly horizontal: readonly (GraphTextureDescriptor & { readonly label: string })[];
  readonly vertical: readonly (GraphTextureDescriptor & { readonly label: string })[];
  readonly levels: readonly StandardBloomLevelDimensions[];
}

function standardBloomTargetSpecs(
  outputWidth: number,
  outputHeight: number,
): StandardBloomTargetSpecs {
  const levels = deriveStandardBloomLevels(outputWidth, outputHeight);
  return {
    composited: {
      label: STANDARD_BLOOM_TARGET_SPEC.composited.label,
      format: STANDARD_BLOOM_TARGET_SPEC.composited.format,
      size: { width: outputWidth, height: outputHeight },
      domain: 'linear-hdr',
    },
    horizontal: levels.map((size, level) => ({
      label: `${STANDARD_BLOOM_TARGET_SPEC.horizontalPrefix}${level}`,
      format: 'rgba16float' as const,
      size,
      domain: 'linear-hdr' as const,
    })),
    vertical: levels.map((size, level) => ({
      label: `${STANDARD_BLOOM_TARGET_SPEC.verticalPrefix}${level}`,
      format: 'rgba16float' as const,
      size,
      domain: 'linear-hdr' as const,
    })),
    levels,
  };
}

interface StandardBloomGraphInspection {
  readonly status: 'empty' | 'valid' | 'invalid';
  readonly targetCount: number;
  readonly targetBytes: number;
  readonly passCount: number;
  readonly levelCount: number;
  readonly levelDimensions: readonly StandardBloomLevelDimensions[];
  readonly horizontalPassCount: number;
  readonly verticalPassCount: number;
}

const emptyBloomGraphInspection = (): StandardBloomGraphInspection => ({
  status: 'empty',
  targetCount: 0,
  targetBytes: 0,
  passCount: 0,
  levelCount: 0,
  levelDimensions: [],
  horizontalPassCount: 0,
  verticalPassCount: 0,
});

const invalidBloomGraphInspection = (): StandardBloomGraphInspection => ({
  status: 'invalid',
  targetCount: 0,
  targetBytes: 0,
  passCount: 0,
  levelCount: 0,
  levelDimensions: [],
  horizontalPassCount: 0,
  verticalPassCount: 0,
});

type CompiledBloomResource = CompiledRenderGraphInfo['resources'][number];

function textureBytes(resource: CompiledBloomResource): number | undefined {
  const descriptor = resource.descriptor;
  if (
    resource.kind !== 'texture' ||
    descriptor === undefined ||
    descriptor.kind !== 'texture' ||
    descriptor.format !== 'rgba16float'
  )
    return undefined;
  const texelBytes = textureFormatBlock(descriptor.format).bytesPerBlock;
  let bytes = 0;
  for (let level = 0; level < descriptor.mipLevelCount; level += 1) {
    bytes +=
      mipDimension(descriptor.width, level) *
      mipDimension(descriptor.height, level) *
      descriptor.depthOrArrayLayers *
      texelBytes;
  }
  const descriptorBytes = bytes * descriptor.sampleCount;
  return resource.byteSize === descriptorBytes && descriptorBytes > 0 ? descriptorBytes : undefined;
}

function resourceSize(
  resource: CompiledBloomResource,
): { readonly width: number; readonly height: number } | undefined {
  const descriptor = resource.descriptor;
  if (resource.kind !== 'texture' || descriptor.kind !== 'texture') return undefined;
  if (typeof descriptor.size === 'string') return undefined;
  if (
    resource.extent === undefined ||
    resource.extent.width !== descriptor.width ||
    resource.extent.height !== descriptor.height ||
    resource.extent.depthOrArrayLayers !== descriptor.depthOrArrayLayers
  ) {
    return undefined;
  }
  if (
    descriptor.format !== 'rgba16float' ||
    descriptor.domain !== 'linear-hdr' ||
    descriptor.width <= 0 ||
    descriptor.height <= 0 ||
    descriptor.depthOrArrayLayers !== 1 ||
    descriptor.mipLevelCount !== 1 ||
    descriptor.sampleCount !== 1 ||
    resource.dimension !== '2d' ||
    descriptor.size.width !== descriptor.width ||
    descriptor.size.height !== descriptor.height ||
    textureBytes(resource) === undefined
  ) {
    return undefined;
  }
  return { width: descriptor.width, height: descriptor.height };
}

function hasPassAccesses(
  pass: CompiledRenderGraphInfo['passes'][number] | undefined,
  accesses: readonly { readonly resource: string; readonly usage: string }[],
): boolean {
  return (
    pass !== undefined &&
    pass.kind === 'raster' &&
    pass.accesses.length === accesses.length &&
    accesses.every(
      (access, index) =>
        pass.accesses[index]?.resource === access.resource &&
        pass.accesses[index]?.usage === access.usage,
    )
  );
}

/** Derive Bloom target/pass facts solely from the compiled Standard graph. */
export function inspectStandardBloomGraph(
  graph: CompiledRenderGraphInfo | undefined,
): StandardBloomGraphInspection {
  if (graph === undefined) return emptyBloomGraphInspection();
  const composited = graph.resources.filter(
    (resource) => resource.label === STANDARD_BLOOM_TARGET_SPEC.composited.label,
  );
  const horizontal = graph.resources
    .filter((resource) => resource.label.startsWith(STANDARD_BLOOM_TARGET_SPEC.horizontalPrefix))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const vertical = graph.resources
    .filter((resource) => resource.label.startsWith(STANDARD_BLOOM_TARGET_SPEC.verticalPrefix))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const targets = [...composited, ...horizontal, ...vertical];
  const passes = graph.passes
    .filter(
      (pass) =>
        pass.name === TYPED_BLOOM_PASS_NAMES.composite ||
        pass.name.startsWith(`${TYPED_BLOOM_PASS_NAMES.horizontal}-`) ||
        pass.name.startsWith(`${TYPED_BLOOM_PASS_NAMES.vertical}-`),
    )
    .sort((left, right) => left.executionIndex - right.executionIndex);
  if (targets.length === 0 && passes.length === 0) return emptyBloomGraphInspection();
  if (composited.length !== 1) return invalidBloomGraphInspection();
  const compositedResource = composited[0];
  if (compositedResource === undefined) return invalidBloomGraphInspection();
  const compositedSize = resourceSize(compositedResource);
  if (compositedSize === undefined) return invalidBloomGraphInspection();

  const expected = standardBloomTargetSpecs(compositedSize.width, compositedSize.height);
  const expectedHorizontalLabels = expected.horizontal.map((entry) => entry.label);
  const expectedVerticalLabels = expected.vertical.map((entry) => entry.label);
  const orderedHorizontal = horizontal.sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { numeric: true }),
  );
  const orderedVertical = vertical.sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { numeric: true }),
  );
  const completeTargetSet =
    targets.length === 1 + expectedHorizontalLabels.length + expectedVerticalLabels.length &&
    orderedHorizontal.length === expectedHorizontalLabels.length &&
    orderedVertical.length === expectedVerticalLabels.length &&
    orderedHorizontal.every(
      (resource, level) => resource.label === expectedHorizontalLabels[level],
    ) &&
    orderedVertical.every((resource, level) => resource.label === expectedVerticalLabels[level]) &&
    orderedHorizontal.every(
      (resource, level) =>
        resourceSize(resource)?.width === expected.levels[level]?.width &&
        resourceSize(resource)?.height === expected.levels[level]?.height,
    ) &&
    orderedVertical.every(
      (resource, level) =>
        resourceSize(resource)?.width === expected.levels[level]?.width &&
        resourceSize(resource)?.height === expected.levels[level]?.height,
    );
  const expectedPassNames = expectedHorizontalLabels.flatMap((label, level) => [
    label,
    expectedVerticalLabels[level],
  ]);
  expectedPassNames.push(TYPED_BLOOM_PASS_NAMES.composite);
  const completePassSet =
    passes.length === expectedPassNames.length &&
    passes.every((pass, index) => pass.name === expectedPassNames[index]);
  const sceneLabel = passes[0]?.accesses[0]?.resource;
  const passTopology =
    completePassSet &&
    sceneLabel !== undefined &&
    !sceneLabel.startsWith('bloom-') &&
    graph.resources.some((resource) => resource.label === sceneLabel) &&
    orderedHorizontal.every(
      (_, level) =>
        hasPassAccesses(passes[level * 2], [
          {
            resource: level === 0 ? sceneLabel : `bloom-vertical-${level - 1}`,
            usage: 'sampled-read',
          },
          { resource: `bloom-horizontal-${level}`, usage: 'color-attachment' },
        ]) &&
        hasPassAccesses(passes[level * 2 + 1], [
          { resource: `bloom-horizontal-${level}`, usage: 'sampled-read' },
          { resource: `bloom-vertical-${level}`, usage: 'color-attachment' },
        ]),
    ) &&
    hasPassAccesses(passes.at(-1), [
      { resource: sceneLabel, usage: 'sampled-read' },
      ...expectedVerticalLabels.map((resource) => ({ resource, usage: 'sampled-read' })),
      { resource: STANDARD_BLOOM_TARGET_SPEC.composited.label, usage: 'color-attachment' },
    ]);
  if (!completeTargetSet || !passTopology) {
    return invalidBloomGraphInspection();
  }
  const levelDimensions = orderedHorizontal.flatMap((resource) => {
    const size = resourceSize(resource);
    return size === undefined ? [] : [size];
  });
  if (levelDimensions.length !== orderedHorizontal.length) {
    return invalidBloomGraphInspection();
  }
  const targetBytes = targets.reduce((bytes, resource) => bytes + (textureBytes(resource) ?? 0), 0);
  return {
    status: 'valid',
    targetCount: targets.length,
    targetBytes,
    passCount: passes.length,
    levelCount: orderedHorizontal.length,
    levelDimensions,
    horizontalPassCount: orderedHorizontal.length,
    verticalPassCount: orderedVertical.length,
  };
}

function target(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(context.graph, label, descriptor);
}

function missingTemporalContributor(
  topology: RenderPipelineTopology,
  contributorId: string,
): SceneDataUnavailableError {
  return new SceneDataUnavailableError({
    featureIdentity: 'forgeax::standard',
    schema: 'forgeax::scene-data::temporal-v1',
    lane: topology.lane.compute ? 'clustered' : 'cpu-webgl2',
    reason: 'producer-missing',
    missingContributorIds: [contributorId],
    omittedMissingContributorCount: 0,
    recovery: 'renderer-recover',
  });
}

/**
 * Project the generic scene-stage features over a lane's final scene target,
 * with the same receiver reads the Standard lighting passes expose. Barrel
 * distortion is withheld here and projected last by `addStandardPost`.
 */
export function contributeStandardSceneFeatures(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  targets: {
    readonly color: RenderPipelineTarget;
    readonly colorResolve: GraphTextureView | undefined;
    readonly depth: RenderPipelineTarget;
  },
  receiverAccesses: readonly GraphAccess[],
  atmosphere?: GraphAtmosphere,
): Result<void, RenderPipelineBuildError> {
  const { color, colorResolve, depth } = targets;
  return context.contributeFeatures({
    targets: [
      {
        name: 'linear-hdr',
        kind: 'scene-color',
        texture: color.texture,
        view: color.view,
        ...(colorResolve === undefined ? {} : { resolveTarget: colorResolve }),
        format: color.format,
        sampleCount: color.sampleCount,
      },
      {
        kind: 'scene-depth',
        texture: depth.texture,
        view: depth.view,
        format: depth.format,
        sampleCount: depth.sampleCount,
      },
    ],
    semanticTargets: [],
    namedTargets: {},
    standardSurfaceAccesses: receiverAccesses,
    exclude: [BARREL_DISTORTION_FEATURE_IDENTITY],
    passNames: [],
    atmosphere: atmosphere,
  });
}

/** Output-route decisions derived once from the topology; every post stage reads the same facts. */
interface StandardPostRoute {
  readonly clearOnly: boolean;
  readonly features: StandardOutputPlan['features'];
  /** Linear HDR intermediates are live: tone mapping, TAA or Bloom. */
  readonly hdr: boolean;
  /** Non-HDR frames still keep the graph-owned output transform. */
  readonly linearLdr: boolean;
  readonly rawOnly: boolean;
  readonly motionBlur: boolean;
  readonly outputDither: boolean;
  readonly preTemporalEffects: readonly string[];
  readonly postEffects: readonly string[];
  /** Tone mapping and output encoding run as separate entry points. */
  readonly splitOutput: boolean;
  /** Tone mapping and LUT fuse into one final writer. */
  readonly fusedToneLut: boolean;
  /** Debug geometry is inserted before a spatial warp so it bends with the world. */
  readonly debugOverlayBeforePost: boolean;
}

type StandardFeatureTargets = Parameters<
  RenderPipelineBuildContext<RenderPipelineFrame>['contributeFeatures']
>[0]['targets'];

function standardPostRoute(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): StandardPostRoute {
  const clearOnly = topology.clearOnly === true;
  const camera = topology.camera;
  const features = standardOutputFeatures(topology, clearOnly);
  const hdr =
    !clearOnly && (camera.tonemap !== 'none' || camera.antialias === 'taa' || features.bloom);
  const rawOnly = !clearOnly && topology.surface.profile?.kind === 'raw-only';
  // The barrel declaration is supplied by the ordinary feature host so its
  // shader stays prepared and recoverable, but Standard owns its one explicit
  // linear-LDR stage below. Do not send that identity through the generic
  // encoded tail, or storage-buffer lanes would sample the image twice.
  const preTemporalEffects = clearOnly ? [] : (topology.preTemporalEffects ?? []);
  const postEffects = clearOnly ? [] : encodedPostEffects(topology, preTemporalEffects);
  return {
    clearOnly,
    features,
    hdr,
    linearLdr: !clearOnly && !hdr,
    rawOnly,
    motionBlur: !clearOnly && topology.temporal?.motionBlur === true,
    outputDither: resolveOutputDither(topology.config),
    preTemporalEffects,
    postEffects,
    splitOutput: !clearOnly && standardOutputSplits(features),
    fusedToneLut:
      !clearOnly &&
      !rawOnly &&
      standardToneLutFuses(context, topology, features, postEffects.length),
    debugOverlayBeforePost: (features.barrelDistortion || features.lensEffects) === true,
  };
}

/** Which Standard output stages this camera and output configuration request. */
function standardOutputFeatures(
  topology: RenderPipelineTopology,
  clearOnly: boolean,
): StandardOutputPlan['features'] {
  const camera = topology.camera;
  return createStandardOutputPlan({
    temporal: !clearOnly && camera.antialias === 'taa',
    meter: topology.output?.autoExposure === true,
    bloom: !clearOnly && standardBloomAdmitted(topology.camera),
    dof: !clearOnly && camera.depthOfField !== undefined,
    lensFlare: !clearOnly && camera.lensFlare === true,
    exposure: topology.output?.autoExposure === true,
    whiteBalance: topology.output?.whiteBalance === true,
    lut: topology.output?.colorLut === true,
    outline: !clearOnly && camera.outline === true,
    barrelDistortion: camera.barrelDistortion === true,
    lensEffects: !clearOnly && camera.lensEffects === true,
    fxaa: !clearOnly && camera.antialias === 'fxaa',
    smaa: !clearOnly && camera.antialias === 'smaa',
  }).features;
}

/** Post effects for the generic encoded tail; Standard-owned stages are excluded. */
function encodedPostEffects(
  topology: RenderPipelineTopology,
  preTemporalEffects: readonly string[],
): readonly string[] {
  return (topology.config?.postEffects ?? []).filter(
    (identity) =>
      !preTemporalEffects.includes(identity) &&
      identity !== BARREL_DISTORTION_POST_PROCESS_ID &&
      identity !== LENS_EFFECTS_POST_PROCESS_ID &&
      !isOutlinePostProcess(identity) &&
      !isLensFlarePostProcess(identity) &&
      !isSmaaPostProcess(identity),
  );
}

/**
 * Auto exposure changes the HDR source before tone mapping, so it needs the
 * same explicit linear-LDR boundary as the LUT route even when no LUT is
 * bound. Keep the manual/LUT0 route combined so disabling auto exposure
 * remains exact-zero.
 */
function standardOutputSplits(features: StandardOutputPlan['features']): boolean {
  return (
    (features.lut ||
      features.exposure ||
      features.whiteBalance ||
      features.barrelDistortion ||
      features.lensEffects ||
      features.outline ||
      features.smaa) === true
  );
}

/**
 * Only adjacent pointwise stages may fuse. Intermediate observers, spatial
 * effects and raw-only overlays retain their original attachment boundaries.
 */
function standardToneLutFuses(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  features: StandardOutputPlan['features'],
  postEffectCount: number,
): boolean {
  const extent = topology.extent;
  const antialiasAllowsFusion =
    topology.camera.antialias === 'none' ||
    (topology.camera.antialias === 'taa' &&
      (extent === undefined ||
        (extent.internalWidth === extent.outputWidth &&
          extent.internalHeight === extent.outputHeight)));
  return (
    features.lut &&
    antialiasAllowsFusion &&
    !features.outline &&
    !features.barrelDistortion &&
    !features.lensEffects &&
    postEffectCount === 0 &&
    (context.observationCaptureDomains?.length ?? 0) === 0
  );
}

/** Spatial lens stages render through float intermediates the device must support. */
function lensCapabilityFailure(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  features: StandardOutputPlan['features'],
): RenderFeatureCapabilityMissingError | undefined {
  if (!(features.barrelDistortion || features.lensEffects || features.lensFlare)) return undefined;
  if (context.capabilities?.rgba16floatRenderable === true) return undefined;
  return new RenderFeatureCapabilityMissingError(
    features.barrelDistortion
      ? BARREL_DISTORTION_FEATURE_IDENTITY
      : features.lensEffects
        ? LENS_EFFECTS_POST_PROCESS_ID
        : LENS_FLARE_POST_PROCESS_ID,
    0,
    'rgba16floatRenderable',
  );
}

/**
 * Raw-only surfaces are attachment-only. The clear already landed in the
 * graph-owned encoded scene target; observe it and present without encoding again.
 */
function addClearOnlyPresent(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  scene: RenderPipelineTarget,
  surface: StandardPostSurface,
): Result<void, RenderPipelineBuildError> {
  const overlay = addTypedDebugOverlayPass(context.graph, scene);
  if (!overlay.ok) return overlay;
  if (context.observationCaptureDomains?.includes('final-display') === true) {
    const captured = addObservationCapturePass(context.graph, scene, 'final-display');
    if (!captured.ok) return captured;
  }
  return addTypedOutputTransformPass(context.graph, scene, surface.storage, {
    name: 'standard-clear-present',
    fragmentEntryPoint: 'fs_present',
  });
}

/**
 * Every Standard route terminates at the same encoded raw storage endpoint.
 * The raw-only profile has no alternate display view, so optional post
 * effects are kept in a graph-owned float target until the single Output
 * Transform performs the first 8-bit quantization.
 */
function declareRawOnlyPostInput(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (!route.rawOnly || route.postEffects.length === 0) return ok(undefined);
  return target(context, 'standard-post-effects-input', {
    format: 'rgba16float',
    size: 'surface',
    usage: GPU_TEXTURE_USAGE_COPY_SRC,
    domain: 'display-encoded',
  });
}

/** A raw-only surface cannot be copied, so final-display observation needs its own target. */
function declareObservedOutput(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (!route.rawOnly || context.observationCaptureDomains?.includes('final-display') !== true)
    return ok(undefined);
  return target(context, 'standard-observed-output', {
    format: topology.surface.storageFormat,
    size: 'surface',
    domain: 'display-encoded',
  });
}

function addPreTemporalEffects(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  effects: readonly string[],
  scene: RenderPipelineTarget,
  depth: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  let postInput = scene;
  for (const [index, shader] of effects.entries()) {
    const output = target(context, `scene-effect-output-${index}`, {
      format: scene.format as GPUTextureFormat,
      size:
        topology.extent === undefined ? 'surface' : renderExtentSize(topology.extent, 'internal'),
      domain: 'linear-hdr',
    });
    if (!output.ok) return output;
    const added = addTypedFullscreenPass(context.graph, {
      name: `scene-effect-${index}`,
      shader,
      input: postInput,
      outputs: [output.value],
      depth,
    });
    if (!added.ok) return added;
    postInput = output.value;
  }
  return ok(postInput);
}

type StandardAutoExposure = NonNullable<
  NonNullable<RenderPipelineBuildContext<RenderPipelineFrame>['standardOutput']>['autoExposure']
>;

/** Auto exposure needs its prepared same-frame producer projection. */
function requireAutoExposure(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
): Result<StandardAutoExposure | undefined, RenderGraphError> {
  const autoExposure = context.standardOutput?.autoExposure;
  if (route.features.exposure && autoExposure === undefined) {
    return err(
      new RenderGraphError({
        code: 'resource-resolution-failed',
        expected: 'a prepared same-frame auto-exposure producer projection',
        hint: 'prepare device-scoped auto-exposure resources before compiling Standard output',
        detail: { resourceLabel: 'standard-auto-exposure' },
      }),
    );
  }
  return ok(autoExposure);
}

/** Resolve TAA into the frame's history targets, which later stages then consume. */
function addStandardTemporalResolve(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  sceneTemporal: RenderPipelineTarget | undefined,
  secondaryReactivity: TemporalSecondaryReactivity | undefined,
  coverage: RenderPipelineTarget | undefined,
  coverageDepth: RenderPipelineTarget | undefined,
): Result<
  NonNullable<RenderPipelineBuildContext<RenderPipelineFrame>['taaHistory']>,
  RenderPipelineBuildError
> {
  if (sceneTemporal === undefined) {
    return err(missingTemporalContributor(topology, 'forgeax::standard::scene-data'));
  }
  const history = context.taaHistory;
  if (history === undefined) {
    return err(missingTemporalContributor(topology, 'forgeax::standard::taa-history'));
  }
  const resolveTargets: TypedTemporalResolveTargets = {
    scene,
    depth,
    currentTemporal: sceneTemporal,
    ...(coverage === undefined ? {} : { coverage }),
    ...(coverageDepth === undefined ? {} : { coverageDepth }),
    ...(secondaryReactivity === undefined ? {} : { secondaryReactivity }),
    historyColor: history.previousColor,
    historyTemporal: history.previousTemporal,
    historyStability: history.previousStability,
    writeColor: history.currentColor,
    writeTemporal: history.currentTemporal,
    writeStability: history.currentStability,
  };
  const resolve = addTypedTemporalResolvePass(context.graph, resolveTargets);
  if (!resolve.ok) return resolve;
  return ok(history);
}

/**
 * Meter the temporally resolved color before lens-domain filters. Motion
 * Blur and Bloom must consume a single exposure decision for this frame;
 * running the meter after either filter makes the measured luminance depend
 * on the authored streak radius and changes the exposure feedback loop.
 */
function addExposureMeter(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  source: RenderPipelineTarget,
  autoExposure: StandardAutoExposure | undefined,
): Result<void, RenderPipelineBuildError> {
  if (!route.features.exposure || autoExposure === undefined) return ok(undefined);
  return addAutoExposureGraphPasses(context, {
    source,
    resources: autoExposure,
    width: topology.surface.width,
    height: topology.surface.height,
  });
}

function standardFeatureTargets(
  scene: RenderPipelineTarget,
  depth: RenderPipelineTarget,
): StandardFeatureTargets {
  return [
    {
      kind: 'scene-color' as const,
      texture: scene.texture,
      view: scene.view,
      format: scene.format,
      sampleCount: scene.sampleCount,
    },
    {
      kind: 'scene-depth' as const,
      texture: depth.texture,
      view: depth.view,
      format: depth.format,
      sampleCount: depth.sampleCount,
    },
  ];
}

/**
 * Feature projection and the built-in fallback share one target contract.
 * The projection runs after TAA so Motion Blur consumes the resolved color,
 * then both paths feed the same linear float target into Bloom/Output.
 */
function addSceneFeatureStages(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  featureTargets: StandardFeatureTargets,
  postInput: RenderPipelineTarget,
  postTemporal: RenderPipelineTarget | undefined,
  sceneTemporal: RenderPipelineTarget | undefined,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  if (route.clearOnly) return ok(postInput);
  if (route.motionBlur) {
    return addMotionBlurStage(context, route, featureTargets, postInput, postTemporal);
  }
  const features = context.contributeFeatures({
    targets: featureTargets,
    semanticTargets: sceneTemporal === undefined ? [] : [sceneTemporal],
    namedTargets: {},
    standardSurfaceAccesses: [],
    exclude: [BARREL_DISTORTION_FEATURE_IDENTITY],
  });
  if (!features.ok) return features;
  return ok(postInput);
}

function addMotionBlurStage(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  featureTargets: StandardFeatureTargets,
  postInput: RenderPipelineTarget,
  postTemporal: RenderPipelineTarget | undefined,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  if (postTemporal === undefined) {
    return err(
      new Error('Motion Blur requires the Standard scene-data producer') as RenderGraphError,
    );
  }
  const blurred = target(context, 'motion-blurred-color', {
    format: 'rgba16float',
    size: 'surface',
    domain: route.hdr ? 'linear-hdr' : 'linear-ldr',
  });
  if (!blurred.ok) return blurred;
  const features = context.contributeFeatures({
    targets: featureTargets,
    semanticTargets: [postTemporal],
    namedTargets: {
      'motion-input': postInput,
      'motion-output': blurred.value,
    },
    standardSurfaceAccesses: [],
    exclude: [BARREL_DISTORTION_FEATURE_IDENTITY],
  });
  if (!features.ok) return features;
  if (context.hasFeature?.('forgeax.motion-blur') !== true) {
    const fallback = addMotionBlurPass(context.graph, postInput, postTemporal, blurred.value);
    if (!fallback.ok) return fallback;
  }
  return ok(blurred.value);
}

/** Depth of field, Bloom and the lens flare filter the linear HDR image in order. */
function addHdrLensStages(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  depth: RenderPipelineTarget,
  input: RenderPipelineTarget,
  postTemporal: RenderPipelineTarget | undefined,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  let postInput = input;
  if (route.features.dof) {
    const taa = topology.temporal?.taa === true;
    const dof = addDepthOfFieldPasses(
      {
        graph: context.graph,
        camera: context.camera ?? {},
        temporalTaa: taa,
        msaaActive: depth.sampleCount === 4,
        ...(topology.extent === undefined ? {} : { extent: topology.extent }),
      },
      postInput,
      depth,
      taa ? postTemporal : undefined,
    );
    if (!dof.ok) return dof;
    postInput = dof.value;
  }
  // Bloom requires linear HDR intermediates independently of the selected output curve.
  if (route.hdr && route.features.bloom) {
    const bloom = addStandardBloom(context, topology, postInput);
    if (!bloom.ok) return bloom;
    postInput = bloom.value;
  }
  // The threshold is authored in scene HDR units, so the flare shares Bloom's
  // HDR-only admission and reads the Bloom-composited color.
  if (route.hdr && route.features.lensFlare) {
    const flare = addLensFlarePasses(context.graph, postInput, {
      width: topology.extent?.outputWidth ?? topology.surface.width,
      height: topology.extent?.outputHeight ?? topology.surface.height,
    });
    if (!flare.ok) return flare;
    postInput = flare.value;
  }
  return ok(postInput);
}

function addStandardBloom(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const outputWidth = topology.extent?.outputWidth ?? topology.surface.width;
  const outputHeight = topology.extent?.outputHeight ?? topology.surface.height;
  const bloomSpecs = standardBloomTargetSpecs(outputWidth, outputHeight);
  const composited = target(context, bloomSpecs.composited.label, bloomSpecs.composited);
  if (!composited.ok) return composited;
  const horizontal = declareBloomLevels(context, bloomSpecs.horizontal);
  if (!horizontal.ok) return horizontal;
  const vertical = declareBloomLevels(context, bloomSpecs.vertical);
  if (!vertical.ok) return vertical;
  const bloom = addTypedBloomPasses(context.graph, {
    scene,
    composited: composited.value,
    horizontal: horizontal.value,
    vertical: vertical.value,
    levelDimensions: bloomSpecs.levels,
  });
  if (!bloom.ok) return bloom;
  return ok(composited.value);
}

function declareBloomLevels(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  specs: ReturnType<typeof standardBloomTargetSpecs>['horizontal'],
): Result<RenderPipelineTarget[], RenderGraphError> {
  const levels: RenderPipelineTarget[] = [];
  for (const spec of specs) {
    const level = target(context, spec.label, spec);
    if (!level.ok) return level;
    levels.push(level.value);
  }
  return ok(levels);
}

function addExposureWhiteBalance(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  postInput: RenderPipelineTarget,
  autoExposure: StandardAutoExposure | undefined,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  if (!route.features.exposure && !route.features.whiteBalance) return ok(postInput);
  const exposureOutput = target(context, 'standard-exposure-white-balance', {
    format: 'rgba16float',
    size: 'surface',
    domain: 'linear-hdr',
  });
  if (!exposureOutput.ok) return exposureOutput;
  const exposurePass = addAutoExposureExposurePass(
    context,
    postInput,
    exposureOutput.value,
    route.features.exposure ? autoExposure : undefined,
    {
      temperature: topology.output?.temperature ?? 6504,
      tint: topology.output?.tint ?? 0,
    },
  );
  if (!exposurePass.ok) return exposurePass;
  return ok(exposureOutput.value);
}

/** Tone mapping, color LUT and the linear-LDR spatial effects before output encoding. */
function addLinearLdrStages(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  depth: RenderPipelineTarget,
  featureTargets: StandardFeatureTargets,
  input: RenderPipelineTarget,
  finalPresent: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const toned = addToneStage(context, route, input);
  if (!toned.ok) return toned;
  let postInput = toned.value;
  if (route.features.lut) {
    const lut = addColorLutStage(context, route, postInput, finalPresent);
    if (!lut.ok) return lut;
    postInput = lut.value;
  }
  if (route.features.outline) {
    const outlined = addOutlinePasses(context.graph, postInput, depth);
    if (!outlined.ok) return outlined;
    postInput = outlined.value;
  }
  // Debug geometry is world-space scene content. Insert it before the spatial
  // warp so its lines and markers bend with the rendered world. Screen-space
  // diagnostics remain on the final surface when no warp is active.
  if (route.rawOnly || route.debugOverlayBeforePost) {
    const overlay = addTypedDebugOverlayPass(context.graph, postInput);
    if (!overlay.ok) return overlay;
  }
  if (route.features.barrelDistortion) {
    const barrel = addBarrelDistortionStage(context, featureTargets, postInput);
    if (!barrel.ok) return barrel;
    postInput = barrel.value;
  }
  if (route.features.smaa) {
    const antialiased = addSmaaPasses(context.graph, postInput);
    if (!antialiased.ok) return antialiased;
    postInput = antialiased.value;
  }
  return ok(postInput);
}

/**
 * Tone mapping and output encoding are separate entry points when a LUT is
 * enabled or auto exposure is active: the LUT must sample linear LDR, and
 * the single OETF writer runs only after LUT and optional FXAA.
 * A missing linear-LDR observation needs its own tone-only producer. It must
 * not move the ordinary FXAA pass across the output encoding boundary.
 */
function addToneStage(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  postInput: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const observesLinearLdr = context.observationCaptureDomains?.includes('linear-ldr') === true;
  if (route.fusedToneLut || !(route.splitOutput || observesLinearLdr)) return ok(postInput);
  const toneOutput = target(context, 'standard-tone-output', {
    format: 'rgba16float',
    size: 'surface',
    domain: 'linear-ldr',
  });
  if (!toneOutput.ok) return toneOutput;
  const transformed = addTypedOutputTransformPass(context.graph, postInput, toneOutput.value, {
    dither: false,
    name: 'standard-tone',
    fragmentEntryPoint: 'fs_tone_only',
  });
  if (!transformed.ok) return transformed;
  if (route.splitOutput) return ok(toneOutput.value);
  const captured = addObservationCapturePass(context.graph, toneOutput.value, 'linear-ldr');
  if (!captured.ok) return captured;
  return ok(postInput);
}

function addColorLutStage(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  postInput: RenderPipelineTarget,
  finalPresent: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const colorLut = context.standardOutput?.colorLut;
  if (colorLut === undefined) {
    return err(
      new RenderGraphError({
        code: 'resource-resolution-failed',
        expected: 'a prepared resident Standard color LUT projection',
        hint: 'resolve and admit the TextureAsset LUT before compiling Standard output',
        detail: { resourceLabel: 'standard-color-lut' },
      }),
    );
  }
  if (route.fusedToneLut) {
    const fused = addStandardToneLutPass(
      context.graph,
      postInput,
      finalPresent,
      colorLut,
      route.outputDither,
    );
    if (!fused.ok) return fused;
    return ok(finalPresent);
  }
  const lutOutput = target(context, 'standard-color-lut', {
    format: 'rgba16float',
    size: 'surface',
    domain: 'linear-ldr',
  });
  if (!lutOutput.ok) return lutOutput;
  const lutPass = addStandardColorLutPass(context.graph, postInput, lutOutput.value, colorLut);
  if (!lutPass.ok) return lutPass;
  return ok(lutOutput.value);
}

function addBarrelDistortionStage(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  featureTargets: StandardFeatureTargets,
  postInput: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const barrelOutput = target(context, 'standard-barrel-distortion', {
    format: 'rgba16float',
    size: 'surface',
    domain: 'linear-ldr',
  });
  if (!barrelOutput.ok) return barrelOutput;
  const barrel = context.contributeFeatures({
    targets: featureTargets,
    semanticTargets: [],
    namedTargets: { 'barrel-input': postInput, 'barrel-output': barrelOutput.value },
    standardSurfaceAccesses: [],
    include: [BARREL_DISTORTION_FEATURE_IDENTITY],
  });
  if (!barrel.ok) return barrel;
  if (context.hasFeature?.(BARREL_DISTORTION_FEATURE_IDENTITY) !== true) {
    return err(
      new RenderFeatureCapabilityMissingError(
        BARREL_DISTORTION_FEATURE_IDENTITY,
        0,
        'rgba16floatRenderable',
      ),
    );
  }
  return ok(barrelOutput.value);
}

/**
 * Split output keeps FXAA in linear LDR; the combined route encodes first and
 * lets FXAA write the encoded endpoint.
 */
function addFxaaStage(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  postInput: RenderPipelineTarget,
  encodedOutput: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const output = route.splitOutput
    ? target(context, 'standard-fxaa-output', {
        format: 'rgba16float',
        size: 'surface',
        domain: 'linear-ldr',
      })
    : target(context, 'standard-output-color', {
        format: 'rgba16float',
        size: 'surface',
        usage: GPU_TEXTURE_USAGE_COPY_SRC,
        domain: 'display-encoded',
      });
  if (!output.ok) return output;
  if (!route.splitOutput) {
    // FXAA samples this display-encoded intermediate; leave dither to the
    // final FXAA writer so the same pixel is not dithered twice.
    const outputTransform = addTypedOutputTransformPass(context.graph, postInput, output.value, {
      dither: false,
    });
    if (!outputTransform.ok) return outputTransform;
  }
  const aa = addTypedFullscreenPass(context.graph, {
    name: 'fxaa',
    shader: 'fxaa',
    input: route.splitOutput ? postInput : output.value,
    outputs: [route.splitOutput ? output.value : encodedOutput],
    ...(route.splitOutput
      ? {
          paramsTransform: (): Uint8Array => new Uint8Array(16),
        }
      : {}),
  });
  if (!aa.ok) return aa;
  return ok(route.splitOutput ? output.value : postInput);
}

/** Without FXAA the combined route encodes once, unless split encoding runs later. */
function addCombinedOutputTransform(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  postInput: RenderPipelineTarget,
  finalPresent: RenderPipelineTarget,
  rawOnlyPostInput: RenderPipelineTarget | undefined,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  if (route.splitOutput) return ok(postInput);
  const outputDither = route.outputDither;
  const transformed =
    rawOnlyPostInput !== undefined
      ? addTypedOutputTransformPass(context.graph, postInput, rawOnlyPostInput, {
          dither: outputDither && route.postEffects.length === 0,
        })
      : addTypedOutputTransformPass(context.graph, postInput, finalPresent, {
          dither: outputDither,
        });
  if (!transformed.ok) return transformed;
  return ok(postInput);
}

function addLensEffectsStage(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  postInput: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const lensOutput = target(context, 'standard-lens-effects', {
    format: 'rgba16float',
    size: 'surface',
    domain: 'linear-ldr',
  });
  if (!lensOutput.ok) return lensOutput;
  const lens = addTypedFullscreenPass(context.graph, {
    name: 'lens-effects',
    shader: LENS_EFFECTS_POST_PROCESS_ID,
    input: postInput,
    outputs: [lensOutput.value],
  });
  if (!lens.ok) return lens;
  return ok(lensOutput.value);
}

/** FXAA or the combined output transform, then lens effects and split output encoding. */
function addOutputEncodingStages(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  input: RenderPipelineTarget,
  finalPresent: RenderPipelineTarget,
  rawOnlyPostInput: RenderPipelineTarget | undefined,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  let postInput = input;
  if (route.hdr || route.linearLdr || route.features.fxaa || route.rawOnly || route.motionBlur) {
    const transformed = route.features.fxaa
      ? addFxaaStage(context, route, postInput, rawOnlyPostInput ?? finalPresent)
      : addCombinedOutputTransform(context, route, postInput, finalPresent, rawOnlyPostInput);
    if (!transformed.ok) return transformed;
    postInput = transformed.value;
  }
  if (route.features.lensEffects) {
    const lens = addLensEffectsStage(context, postInput);
    if (!lens.ok) return lens;
    postInput = lens.value;
  }
  if (route.splitOutput && !route.fusedToneLut) {
    const encodedOutput = rawOnlyPostInput ?? finalPresent;
    const outputTransform = addTypedOutputTransformPass(context.graph, postInput, encodedOutput, {
      dither: route.outputDither,
      name: 'standard-output-encoding',
      fragmentEntryPoint: 'fs_encode_only',
      observationCaptureDomains: context.observationCaptureDomains?.filter(
        (domain) => domain !== 'final-display',
      ),
    });
    if (!outputTransform.ok) return outputTransform;
    postInput = encodedOutput;
  }
  return ok(postInput);
}

/**
 * Effects sample display-encoded values unchanged, so the copy source is the
 * raw storage view rather than the sRGB-decoding display view.
 */
function addEncodedPostEffects(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  depth: RenderPipelineTarget,
  postInputTarget: RenderPipelineTarget | undefined,
  finalPresent: RenderPipelineTarget,
): Result<void, RenderPipelineBuildError> {
  if (route.postEffects.length === 0) return ok(undefined);
  if (postInputTarget === undefined) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'raw-only post effects have a graph-owned encoded input target',
        hint: 'retain the candidate LKG when the post-effect input target cannot be declared',
        detail: {
          resourceLabel: 'standard-post-effects-input',
          field: 'descriptor',
          expected: 'rgba16float display-encoded target',
          actual: 'absent',
        },
      }),
    );
  }
  const effects = addTypedCompositePostEffects(
    context.graph,
    route.postEffects,
    postInputTarget,
    finalPresent,
    depth,
    topology.surface,
  );
  if (!effects.ok) return effects;
  return ok(undefined);
}

/** Screen-space overlay, final-display observation and the raw-only observed present. */
function addStandardPresentStages(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  surface: StandardPostSurface,
  finalPresent: RenderPipelineTarget,
  observedOutput: RenderPipelineTarget | undefined,
): Result<void, RenderPipelineBuildError> {
  if (!route.rawOnly && !route.debugOverlayBeforePost) {
    const overlay = addTypedDebugOverlayPass(context.graph, surface.display ?? surface.storage);
    if (!overlay.ok) return overlay;
  }
  if (context.observationCaptureDomains?.includes('final-display') === true) {
    const captured = addObservationCapturePass(context.graph, finalPresent, 'final-display');
    if (!captured.ok) return captured;
  }
  if (observedOutput !== undefined) {
    // A raw-only surface cannot be copied. Capture the same encoded 8-bit
    // output that is presented, then transfer it without another color transform.
    const presented = addTypedOutputTransformPass(context.graph, finalPresent, surface.storage, {
      name: 'standard-observed-present',
      fragmentEntryPoint: 'fs_present',
    });
    if (!presented.ok) return presented;
  }
  return ok(undefined);
}

/**
 * Build the one Standard post chain shared by direct and clustered lighting.
 * Bloom is admitted before any Bloom target is declared, keeping the disabled
 * path exact-zero while building one bounded five-level HDR
 * horizontal/vertical Gaussian pyramid for the enabled path.
 */
export function addStandardPost(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  surface: StandardPostSurface,
  sceneTemporal?: RenderPipelineTarget,
  secondaryReactivity?: TemporalSecondaryReactivity,
  coverage?: RenderPipelineTarget,
  coverageDepth?: RenderPipelineTarget,
): Result<void, RenderPipelineBuildError> {
  if (topology.clearOnly === true && surface.display === undefined) {
    return addClearOnlyPresent(context, scene, surface);
  }
  const route = standardPostRoute(context, topology);
  const capabilityFailure = lensCapabilityFailure(context, route.features);
  if (capabilityFailure !== undefined) return err(capabilityFailure);
  const rawOnlyPostInput = declareRawOnlyPostInput(context, route);
  if (!rawOnlyPostInput.ok) return rawOnlyPostInput;
  const observedOutput = declareObservedOutput(context, topology, route);
  if (!observedOutput.ok) return observedOutput;
  const finalPresent = observedOutput.value ?? surface.storage;
  const preTemporal = addPreTemporalEffects(
    context,
    topology,
    route.preTemporalEffects,
    scene,
    depth,
  );
  if (!preTemporal.ok) return preTemporal;
  let postInput = preTemporal.value;
  let postTemporal = sceneTemporal;
  const autoExposure = requireAutoExposure(context, route);
  if (!autoExposure.ok) return autoExposure;
  if (topology.camera.antialias === 'taa') {
    const history = addStandardTemporalResolve(
      context,
      topology,
      postInput,
      depth,
      sceneTemporal,
      secondaryReactivity,
      coverage,
      coverageDepth,
    );
    if (!history.ok) return history;
    postInput = history.value.currentColor;
    // TAA resolves both outputs to the unjittered lattice. Later effects must
    // consume its matching temporal attachment, not raw jittered coverage.
    postTemporal = history.value.currentTemporal;
  }
  const metered = addExposureMeter(context, topology, route, postInput, autoExposure.value);
  if (!metered.ok) return metered;
  const featureTargets = standardFeatureTargets(scene, depth);
  const featured = addSceneFeatureStages(
    context,
    route,
    featureTargets,
    postInput,
    postTemporal,
    sceneTemporal,
  );
  if (!featured.ok) return featured;
  const lensed = addHdrLensStages(context, topology, route, depth, featured.value, postTemporal);
  if (!lensed.ok) return lensed;
  const exposed = addExposureWhiteBalance(
    context,
    topology,
    route,
    lensed.value,
    autoExposure.value,
  );
  if (!exposed.ok) return exposed;
  const ldr = addLinearLdrStages(
    context,
    route,
    depth,
    featureTargets,
    exposed.value,
    finalPresent,
  );
  if (!ldr.ok) return ldr;
  const encoded = addOutputEncodingStages(
    context,
    route,
    ldr.value,
    finalPresent,
    rawOnlyPostInput.value,
  );
  if (!encoded.ok) return encoded;
  const effects = addEncodedPostEffects(
    context,
    topology,
    route,
    depth,
    route.rawOnly ? rawOnlyPostInput.value : surface.storage,
    finalPresent,
  );
  if (!effects.ok) return effects;
  const sky = addGradientSkyDisplayPass(context.graph, finalPresent);
  if (!sky.ok) return sky;
  return addStandardPresentStages(context, route, surface, finalPresent, observedOutput.value);
}
