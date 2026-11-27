import type {
  CompiledRenderGraphInfo,
  GraphAccess,
  GraphTextureDescriptor,
  GraphTextureView,
} from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, mipDimension, ok, type Result, textureFormatBlock } from '@forgeax/engine-types';
import { standardBloomAdmitted } from '../bloom-admission';
import {
  BLOOM_QUALITY_HIGH,
  BLOOM_QUALITY_LOW,
  isFxaaAntialias,
  isTemporalAntialias,
} from '../components/camera';
import { addTypedDebugOverlayPass } from '../debug-draw-glue';
import type { GraphAtmosphere } from '../environment/luts';
import { RenderFeatureCapabilityMissingError, SceneDataUnavailableError } from '../errors/render';
import {
  BARREL_DISTORTION_FEATURE_IDENTITY,
  BARREL_DISTORTION_POST_PROCESS_ID,
} from '../features/barrel-distortion';
import { addDepthOfFieldPasses } from '../features/depth-of-field/depth-of-field-feature';
import { EDITOR_ASSISTANCE_FEATURE_IDENTITY } from '../features/editor-assistance/feature';
import {
  CHROMATIC_ABERRATION_POST_PROCESS_ID,
  LENS_EFFECTS_POST_PROCESS_ID,
} from '../features/lens-effects';
import { isLensFlarePostProcess, LENS_FLARE_POST_PROCESS_ID } from '../features/lens-flare';
import {
  addLensFlarePasses,
  LENS_FLARE_BOKEH,
  LENS_FLARE_COMBINED,
  LENS_FLARE_PREFILTER,
} from '../features/lens-flare-graph';
import {
  addMotionBlurPass,
  MOTION_BLUR_FEATURE_IDENTITY,
} from '../features/motion-blur/motion-blur-feature';
import { addSceneVelocityMotionBlur } from '../features/motion-blur/scene-velocity-motion-blur';
import { addDistanceOutlinePasses } from '../features/outline/distance-graph';
import { addOutlinePasses } from '../features/outline/graph';
import { isOutlinePostProcess } from '../features/outline/shaders';
import { addSmaaBlend, addSmaaWeights } from '../features/smaa/graph';
import { isSmaaPostProcess } from '../features/smaa/shaders';
import { POST_PROCESS_OUTPUT_DEPTH } from '../features/targets';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import type {
  OutputDither,
  RenderPipelineBuildContext,
  RenderPipelineBuildError,
  RenderPipelineFrame,
  RenderPipelineGpuDrivenProjection,
  RenderPipelineTopology,
} from '../render-pipeline';
import {
  createRenderPipelineTarget,
  type RenderPipelineTarget,
  resolveOutputDither,
} from '../render-pipeline';
import { SSR_SCENE_COLOR_HISTORY_PROGRAM } from '../ssr/scene-color-input';
import type { SceneVelocityInputs } from '../temporal/default-gbuffer-velocity';
import { SCENE_DATA_TEMPORAL_V1_SCHEMA } from '../temporal/scene-data';
import { bindStandardSceneDataTarget } from '../temporal/standard-scene-data';
import { usesTsrCompute } from '../tsr/capabilities';
import { addTsrPasses } from '../tsr/graph';
import {
  addObservationCapturePass,
  addTypedBloomPasses,
  addTypedCompositePostEffects,
  addTypedFrameObservationPass,
  addTypedFullscreenPass,
  addTypedOutputTransformPass,
  addTypedTemporalResolvePass,
  type TemporalSecondaryReactivity,
  TYPED_BLOOM_PASS_NAMES,
  type TypedTemporalResolveTargets,
} from '../typed-render-graph-primitives';
import { addBloomDownsampleChain } from './bloom-downsample';
import { type BloomFilterFormat, bloomFilterFormat } from './bloom-filter-format';
import { addBloomPrefilter } from './bloom-prefilter';
import { addHdrOutputEffects } from './hdr-output-effects';
import { addPostSceneColorHalf, declarePostSceneColorHalf } from './post-scene-color';
import {
  renderExtentSize,
  renderInternalCopySize,
  renderInternalSize,
  temporalAnalysisCapacity,
} from './render-extent';
import type { WaterInfoGraphTargets } from './standard-build-context';
import {
  addAutoExposureExposurePass,
  addAutoExposureGraphPasses,
} from './standard-output/auto-exposure/gpu';
import {
  nativeGradeNeedsLinearImage,
  nativeGradeOverlaysLinearImage,
  usesNativeGrade,
} from './standard-output/layout';
import { addStandardColorLutPass } from './standard-output/lut-gpu';
import { addNativeOutputParameters, addNativeOutputPass } from './standard-output/native-gpu';
import { addStandardToneLutPass } from './standard-output/tone-lut';
import type { StandardOutputPlan } from './standard-output/types';
import { addStandardPostProcessDepth } from './standard-post-depth';

export interface StandardPostSurface {
  readonly display?: RenderPipelineTarget;
  readonly storage: RenderPipelineTarget;
}

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
  levelCount: number,
): readonly StandardBloomLevelDimensions[] {
  const levels: StandardBloomLevelDimensions[] = [];
  let width = Math.max(1, Math.ceil(outputWidth / 2));
  let height = Math.max(1, Math.ceil(outputHeight / 2));
  for (let level = 0; level < levelCount; level += 1) {
    levels.push({ width, height });
    width = Math.max(1, Math.ceil(width / 2));
    height = Math.max(1, Math.ceil(height / 2));
  }
  return levels;
}

interface StandardBloomTargetSpecs {
  readonly horizontal: readonly (GraphTextureDescriptor & { readonly label: string })[];
  readonly vertical: readonly (GraphTextureDescriptor & { readonly label: string })[];
  readonly levels: readonly StandardBloomLevelDimensions[];
}

function standardBloomTargetSpecs(
  outputWidth: number,
  outputHeight: number,
  levelCount: number,
  filterFormat: BloomFilterFormat,
): StandardBloomTargetSpecs {
  const levels = deriveStandardBloomLevels(outputWidth, outputHeight, levelCount);
  return {
    horizontal: levels.map((size, level) => ({
      label: `${STANDARD_BLOOM_TARGET_SPEC.horizontalPrefix}${level}`,
      format: filterFormat,
      size,
      domain: 'linear-hdr' as const,
    })),
    vertical: levels.map((size, level) => ({
      label: `${STANDARD_BLOOM_TARGET_SPEC.verticalPrefix}${level}`,
      format: filterFormat,
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
    (descriptor.format !== 'rgba16float' && descriptor.format !== 'rg11b10ufloat')
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

function compiledBloomPyramid(targets: readonly CompiledBloomResource[]) {
  const levelCount = targets.filter(({ label }) => label.startsWith('bloom-horizontal-')).length;
  if (levelCount < BLOOM_QUALITY_LOW || levelCount > BLOOM_QUALITY_HIGH) return undefined;
  const descriptor = targets.find(({ label }) => label === 'bloom-horizontal-0')?.descriptor;
  if (descriptor?.kind !== 'texture') return undefined;
  const format = descriptor.format;
  return format === 'rgba16float' || format === 'rg11b10ufloat'
    ? { levelCount, filterFormat: format }
    : undefined;
}

function resourceSize(
  resource: CompiledBloomResource,
  format: BloomFilterFormat = 'rgba16float',
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
    descriptor.format !== format ||
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
  kind: 'raster' | 'compute' = 'raster',
): boolean {
  return (
    pass !== undefined &&
    pass.kind === kind &&
    pass.accesses.length === accesses.length &&
    accesses.every(
      (access, index) =>
        pass.accesses[index]?.resource === access.resource &&
        pass.accesses[index]?.usage === access.usage,
    )
  );
}

function bloomOutputSize(
  graph: CompiledRenderGraphInfo,
  compositedResource: CompiledRenderGraphInfo['resources'][number] | undefined,
  outputPass: CompiledRenderGraphInfo['passes'][number] | undefined,
): StandardBloomLevelDimensions | undefined {
  const gradeOutput = graph.resources.find(
    (resource) =>
      resource.label ===
      outputPass?.accesses.find((access) => access.usage === 'color-attachment')?.resource,
  )?.descriptor;
  return compositedResource === undefined
    ? gradeOutput?.kind === 'texture' &&
      gradeOutput.sampleCount === 1 &&
      (gradeOutput.domain === 'display-encoded' ||
        gradeOutput.domain === 'linear-ldr' ||
        gradeOutput.domain === 'linear-hdr')
      ? { width: gradeOutput.width, height: gradeOutput.height }
      : undefined
    : resourceSize(compositedResource);
}

function inspectBloomGraphOutput(
  graph: CompiledRenderGraphInfo,
  composited: CompiledRenderGraphInfo['resources'][number] | undefined,
  glare: CompiledRenderGraphInfo['passes'][number] | undefined,
): { extent: StandardBloomLevelDimensions; bloomScene: string } | undefined {
  const grade = graph.passes.find(({ name }) => name === 'standard-grade');
  const glareConsumer =
    glare === undefined
      ? undefined
      : graph.passes.find((pass) =>
          pass.accesses.some(
            ({ resource, usage }) => resource === LENS_FLARE_COMBINED && usage === 'sampled-read',
          ),
        );
  const terminal =
    composited === undefined
      ? (glareConsumer ?? grade)
      : graph.passes.find(({ name }) => name === TYPED_BLOOM_PASS_NAMES.composite);
  const sampled = terminal?.accesses.filter(({ usage }) => usage === 'sampled-read');
  const scene = sampled?.[0]?.resource;
  const bloomScene =
    glare === undefined
      ? scene
      : (graph.passes.find(({ name }) => name === 'chromatic-aberration')?.accesses[0]?.resource ??
        scene);
  const extent = bloomOutputSize(graph, composited, terminal);
  if (
    !extent ||
    scene === undefined ||
    sampled?.[1]?.resource !== (glare === undefined ? 'bloom-vertical-0' : LENS_FLARE_COMBINED) ||
    (composited === undefined
      ? (sampled?.length ?? 0) > 3
      : !hasPassAccesses(terminal, [
          { resource: scene, usage: 'sampled-read' },
          { resource: 'bloom-vertical-0', usage: 'sampled-read' },
          { resource: composited.label, usage: 'color-attachment' },
        ]))
  )
    return undefined;

  return { extent, bloomScene: bloomScene ?? scene };
}

/** Derive Bloom target/pass facts solely from the compiled Standard graph. */
export function inspectStandardBloomGraph(
  graph: CompiledRenderGraphInfo | undefined,
): StandardBloomGraphInspection {
  if (graph === undefined) return emptyBloomGraphInspection();
  const targets = graph.resources.filter(
    ({ label }) =>
      label === STANDARD_BLOOM_TARGET_SPEC.composited.label ||
      label === 'bloom-prefilter' ||
      label.startsWith('bloom-downsample-') ||
      label.startsWith(STANDARD_BLOOM_TARGET_SPEC.horizontalPrefix) ||
      label.startsWith(STANDARD_BLOOM_TARGET_SPEC.verticalPrefix),
  );
  const passes = graph.passes.filter(({ name }) => name.startsWith('bloom-'));
  if (targets.length === 0 && passes.length === 0) return emptyBloomGraphInspection();
  const find = (name: string) => passes.find((pass) => pass.name === name);
  const pyramid = compiledBloomPyramid(targets);
  if (pyramid === undefined) return invalidBloomGraphInspection();
  const { levelCount, filterFormat } = pyramid;
  const composited = targets.find(({ label }) => label === 'bloom-composited');
  const glare = graph.passes.find(({ name }) => name === LENS_FLARE_COMBINED);
  const output = inspectBloomGraphOutput(graph, composited, glare);
  if (output === undefined) return invalidBloomGraphInspection();
  const { extent, bloomScene } = output;

  const levelDimensions = deriveStandardBloomLevels(extent.width, extent.height, levelCount);
  const prefilter = find('bloom-prefilter');
  const firstSource = find('bloom-horizontal-0')?.accesses[0]?.resource;
  const sharedSeed = prefilter === undefined ? firstSource : prefilter.accesses[0]?.resource;
  const matchesSize = (
    name: string,
    size: StandardBloomLevelDimensions,
    format?: BloomFilterFormat,
  ) => {
    const texture = graph.resources.find(({ label }) => label === name);
    if (!texture) return false;
    const actual = resourceSize(texture, format);
    return actual?.width === size.width && actual?.height === size.height;
  };
  const seedMatches = (
    halfSize: StandardBloomLevelDimensions,
    firstSource: string,
    sharedSeed: string,
  ) => {
    if (
      !matchesSize(sharedSeed, halfSize) ||
      (glare !== undefined &&
        (!matchesSize(LENS_FLARE_COMBINED, halfSize) ||
          !hasPassAccesses(glare, [
            { resource: LENS_FLARE_BOKEH, usage: 'sampled-read' },
            { resource: LENS_FLARE_COMBINED, usage: 'color-attachment' },
            { resource: 'bloom-vertical-0', usage: 'sampled-read' },
          ]) ||
          graph.passes.find(({ name }) => name === LENS_FLARE_PREFILTER)?.accesses[0]?.resource !==
            sharedSeed)) ||
      !graph.passes.some(
        (pass) =>
          pass.accesses.some(
            ({ resource, usage }) =>
              resource === sharedSeed &&
              (usage === 'storage-write' || usage === 'color-attachment'),
          ) &&
          pass.accesses.some(
            ({ resource, usage }) =>
              resource === bloomScene && (usage === 'storage-write' || usage === 'sampled-read'),
          ),
      ) ||
      (prefilter !== undefined &&
        (firstSource !== 'bloom-prefilter' ||
          !matchesSize(firstSource, halfSize) ||
          !hasPassAccesses(prefilter, [
            { resource: sharedSeed, usage: 'sampled-read' },
            { resource: firstSource, usage: 'color-attachment' },
          ])))
    )
      return false;
    return true;
  };
  const halfSize = levelDimensions[0];
  if (
    halfSize === undefined ||
    firstSource === undefined ||
    sharedSeed === undefined ||
    !seedMatches(halfSize, firstSource, sharedSeed)
  )
    return invalidBloomGraphInspection();

  const reducer = find('bloom-downsample');
  const levelsMatch = (firstSource: string) => {
    if (
      reducer !== undefined &&
      !hasPassAccesses(
        reducer,
        [
          { resource: firstSource, usage: 'sampled-read' },
          ...levelDimensions.slice(1).map((_, index) => ({
            resource: `bloom-downsample-${index + 1}`,
            usage: 'storage-write',
          })),
        ],
        'compute',
      )
    )
      return false;
    const pair = (input: string, output: string) => [
      { resource: input, usage: 'sampled-read' },
      { resource: output, usage: 'color-attachment' },
    ];
    for (const [level, size] of levelDimensions.entries()) {
      const source = level === 0 ? firstSource : `bloom-downsample-${level}`;
      const horizontal = `bloom-horizontal-${level}`;
      const vertical = `bloom-vertical-${level}`;
      const coarser =
        level + 1 < levelCount
          ? [{ resource: `bloom-vertical-${level + 1}`, usage: 'sampled-read' }]
          : [];
      const prior = level === 1 ? firstSource : `bloom-downsample-${level - 1}`;
      if (
        !matchesSize(horizontal, size, filterFormat) ||
        !matchesSize(vertical, size, filterFormat) ||
        (level > 0 &&
          (!matchesSize(source, size) ||
            (reducer === undefined && !hasPassAccesses(find(source), pair(prior, source))))) ||
        !hasPassAccesses(find(horizontal), pair(source, horizontal)) ||
        !hasPassAccesses(find(vertical), [
          { resource: horizontal, usage: 'sampled-read' },
          ...coarser,
          { resource: vertical, usage: 'color-attachment' },
        ])
      )
        return false;
    }
    return true;
  };
  if (!levelsMatch(firstSource)) return invalidBloomGraphInspection();
  const count =
    3 * levelCount - 1 + Number(prefilter !== undefined) + Number(composited !== undefined);
  if (
    passes.length !== count - (reducer === undefined ? 0 : levelCount - 2) ||
    targets.length !== count
  )
    return invalidBloomGraphInspection();
  return {
    status: 'valid',
    targetCount: targets.length,
    targetBytes: targets.reduce((bytes, resource) => bytes + (textureBytes(resource) ?? 0), 0),
    passCount: passes.length,
    levelCount,
    levelDimensions,
    horizontalPassCount: levelCount,
    verticalPassCount: levelCount,
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
  semanticTargets: readonly RenderPipelineTarget[] = [],
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
    semanticTargets,
    namedTargets: {},
    standardSurfaceAccesses: receiverAccesses,
    placement: 'scene',
    exclude: [BARREL_DISTORTION_FEATURE_IDENTITY, EDITOR_ASSISTANCE_FEATURE_IDENTITY],
    passNames: [],
    atmosphere: atmosphere,
  });
}

/** Output-route decisions derived once from the topology; every post stage reads the same facts. */
type StandardPostContext = RenderPipelineBuildContext<RenderPipelineFrame> & {
  readonly readOutputDither?: (frame: RenderPipelineFrame) => boolean;
};

interface StandardPostRoute {
  readonly clearOnly: boolean;
  readonly features: StandardOutputPlan['features'];
  /** Linear HDR intermediates are live: tone mapping, TAA or Bloom. */
  readonly hdr: boolean;
  /** Non-HDR frames still keep the graph-owned output transform. */
  readonly linearLdr: boolean;
  readonly rawOnly: boolean;
  readonly motionBlur: boolean;
  readonly outputDither: OutputDither;
  readonly distanceOutlineFirstStep: number | undefined;
  readonly editorAssistance: boolean;
  readonly editorOutline: boolean;
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
  context: StandardPostContext,
  topology: RenderPipelineTopology,
): StandardPostRoute {
  const clearOnly = topology.clearOnly === true;
  const camera = topology.camera;
  const postProcessing = !clearOnly && camera.postProcessing !== false;
  const features = standardOutputFeatures(topology, clearOnly);
  const hdr =
    !clearOnly &&
    (camera.tonemap !== 'none' || isTemporalAntialias(camera.antialias) || features.bloom);
  const rawOnly = !clearOnly && topology.surface.profile?.kind === 'raw-only';
  // The barrel declaration is supplied by the ordinary feature host so its
  // shader stays prepared and recoverable, but Standard owns its one explicit
  // linear-LDR stage below. Do not send that identity through the generic
  // encoded tail, or storage-buffer lanes would sample the image twice.
  const preTemporalEffects = postProcessing ? (topology.preTemporalEffects ?? []) : [];
  const postEffects = postProcessing ? encodedPostEffects(topology, preTemporalEffects) : [];
  return {
    clearOnly,
    features,
    hdr,
    linearLdr: !clearOnly && !hdr,
    rawOnly,
    motionBlur: postProcessing && topology.temporal?.motionBlur === true,
    outputDither: context.readOutputDither ?? resolveOutputDither(topology.config),
    distanceOutlineFirstStep:
      postProcessing && typeof camera.outline === 'object' ? camera.outline.firstStep : undefined,
    editorAssistance: !clearOnly && camera.editorAssistance === true,
    editorOutline: !clearOnly && camera.editorOutline === true,
    preTemporalEffects,
    postEffects,
    splitOutput: !clearOnly && (standardOutputSplits(features) || camera.editorAssistance === true),
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
  const postProcessing = !clearOnly && camera.postProcessing !== false;
  return {
    temporal: postProcessing && isTemporalAntialias(camera.antialias),
    meter: postProcessing && topology.output?.autoExposure === true,
    bloom: postProcessing && standardBloomAdmitted(topology.camera),
    dof: postProcessing && camera.depthOfField !== undefined,
    chromaticAberration: postProcessing && camera.chromaticAberration === true,
    lensFlare: postProcessing && camera.lensFlare === true,
    exposure: postProcessing && topology.output?.autoExposure === true,
    whiteBalance: postProcessing && topology.output?.whiteBalance === true,
    lut: postProcessing && topology.output?.colorLut === true,
    outline: postProcessing && (camera.outline === true || typeof camera.outline === 'object'),
    barrelDistortion: postProcessing && camera.barrelDistortion === true,
    lensEffects: postProcessing && camera.lensEffects === true,
    fxaa: postProcessing && isFxaaAntialias(camera.antialias),
    smaa: postProcessing && camera.antialias === 'smaa',
  };
}

/** Standard stages whose feature plans consume named post-chain targets. */
export function isStandardNamedPostProcess(identity: string): boolean {
  return (
    identity === BARREL_DISTORTION_POST_PROCESS_ID ||
    identity === LENS_EFFECTS_POST_PROCESS_ID ||
    isOutlinePostProcess(identity) ||
    isLensFlarePostProcess(identity) ||
    isSmaaPostProcess(identity)
  );
}

/** Post effects for the generic encoded tail; Standard-owned stages are excluded. */
function encodedPostEffects(
  topology: RenderPipelineTopology,
  preTemporalEffects: readonly string[],
): readonly string[] {
  return (topology.config?.postEffects ?? []).filter(
    (identity) =>
      !preTemporalEffects.includes(identity) &&
      !topology.hdrOutputEffects?.includes(identity) &&
      !isStandardNamedPostProcess(identity),
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
    (isTemporalAntialias(topology.camera.antialias) &&
      (extent === undefined ||
        (extent.internalWidth === extent.outputWidth &&
          extent.internalHeight === extent.outputHeight)));
  return (
    features.lut &&
    antialiasAllowsFusion &&
    topology.camera.editorAssistance !== true &&
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
  if (
    !(
      features.barrelDistortion ||
      features.lensEffects ||
      features.chromaticAberration ||
      features.lensFlare
    )
  )
    return undefined;
  if (context.capabilities?.rgba16floatRenderable === true) return undefined;
  return new RenderFeatureCapabilityMissingError(
    features.barrelDistortion
      ? BARREL_DISTORTION_FEATURE_IDENTITY
      : features.lensEffects
        ? LENS_EFFECTS_POST_PROCESS_ID
        : features.chromaticAberration
          ? CHROMATIC_ABERRATION_POST_PROCESS_ID
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

/** Only bounded, display-encoded 8-bit destinations can quantize before FXAA. */
function isUnorm8DisplayTarget(output: RenderPipelineTarget): boolean {
  return output.format === 'rgba8unorm' || output.format === 'bgra8unorm';
}

/** Preserve the encoded color format at the first effect's sampling boundary. */
function declareEncodedPostInput(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  output: RenderPipelineTarget,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (route.postEffects.length === 0) return ok(undefined);
  return target(context, 'standard-post-effects-input', {
    format: output.format as GPUTextureFormat,
    size: 'surface',
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

/** The final color writer feeds the view endpoint unless a consumer owns another boundary. */
function declareStandardColorOutput(
  context: StandardPostContext,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  surface: StandardPostSurface,
) {
  const observed = declareObservedOutput(context, topology, route);
  if (!observed.ok) return observed;
  const endpoint = observed.value ?? surface.storage;
  const requirements = context.afterTonemapOutput;
  const afterTonemap =
    !route.clearOnly &&
    topology.camera.postProcessing !== false &&
    (requirements === undefined
      ? context.hasFeatureWork?.(undefined, 'after-tonemap') === true
      : requirements !== null);
  const current =
    afterTonemap && requirements?.needsIntermediate !== false
      ? target(context, 'standard-current-output', {
          format: 'rgba16float',
          size: 'surface',
          domain: 'display-encoded',
        })
      : ok(endpoint);
  if (!current.ok) return current;
  const effectsInput = declareEncodedPostInput(context, route, current.value);
  if (!effectsInput.ok) return effectsInput;
  return ok({
    endpoint,
    color: current.value,
    effectInput: effectsInput.value,
    observed: observed.value,
    endpointFeatures: afterTonemap ? (requirements?.endpointFeatures ?? []) : undefined,
    needsOutputDepth: afterTonemap && requirements?.needsOutputDepth === true,
  });
}

function addAfterTonemapFeatures(
  context: StandardPostContext,
  color: RenderPipelineTarget,
  endpoint: RenderPipelineTarget,
  endpointFeatures: readonly string[],
  depth: RenderPipelineTarget,
  postProcessDepth: RenderPipelineTarget | undefined,
  waterInfoTargets: WaterInfoGraphTargets | undefined,
): Result<void, RenderPipelineBuildError> {
  const request = {
    placement: 'after-tonemap' as const,
    waterInfoTargets,
    targets: [
      ...standardFeatureTargets(color, depth),
      {
        ...(postProcessDepth ?? depth),
        kind: 'scene-depth' as const,
        name: POST_PROCESS_OUTPUT_DEPTH,
      },
    ],
    unjitteredDepth: postProcessDepth?.view,
  };
  const features = context.contributeFeatures({ ...request, exclude: endpointFeatures });
  if (!features.ok) return features;
  if (color !== endpoint) {
    const copied = addTypedOutputTransformPass(context.graph, color, endpoint, {
      name: 'standard-current-output-present',
      fragmentEntryPoint: 'fs_present',
    });
    if (!copied.ok) return copied;
  }
  if (endpointFeatures.length === 0) return ok(undefined);
  return context.contributeFeatures({
    ...request,
    targets: [...request.targets, { ...endpoint, kind: 'scene-color', name: 'swapchain' }],
    include: endpointFeatures,
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
      additionalReads: [{ key: 'chain-source', target: scene }],
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
  opaqueGuide: RenderPipelineTarget | undefined,
  sceneVelocity: SceneVelocityInputs | undefined,
  writeHalf?: RenderPipelineTarget,
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
    ...(sceneVelocity === undefined ? {} : { sceneVelocity }),
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
  if (topology.camera.antialias === 'tsr' && opaqueGuide === undefined)
    return err(missingTemporalContributor(topology, 'forgeax::standard::opaque-guide'));
  const upper = temporalAnalysisCapacity(
    topology.surface.width,
    topology.surface.height,
    topology.camera.dynamicResolution?.maxScale,
  );
  const { previousFlicker, currentFlicker } = history;
  const resolve =
    topology.camera.antialias === 'tsr' && opaqueGuide !== undefined
      ? addTsrPasses(
          context.graph,
          resolveTargets,
          opaqueGuide,
          {
            width: upper.width,
            height: upper.height,
          },
          usesTsrCompute(topology.lane),
          writeHalf,
        )
      : previousFlicker !== undefined && currentFlicker !== undefined
        ? addTypedTemporalResolvePass(context.graph, {
            ...resolveTargets,
            historyFlicker: previousFlicker,
            writeFlicker: currentFlicker,
          })
        : err(missingTemporalContributor(topology, 'forgeax::standard::taa-history'));
  if (!resolve.ok) return resolve;
  return ok(history);
}

/** Meter scene HDR after Motion Blur and before lens-domain filters. */
function addExposureMeter(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  source: RenderPipelineTarget,
  autoExposure: StandardAutoExposure | undefined,
  halfResolution: boolean,
): Result<void, RenderPipelineBuildError> {
  if (!route.features.exposure || autoExposure === undefined) return ok(undefined);
  return addAutoExposureGraphPasses(context, {
    source,
    resources: autoExposure,
    halfResolution,
    ...postOutputExtent(topology),
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
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  featureTargets: StandardFeatureTargets,
  postInput: RenderPipelineTarget,
  postTemporal: RenderPipelineTarget | undefined,
  sceneTemporal: RenderPipelineTarget | undefined,
  sceneVelocity: SceneVelocityInputs | undefined,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  if (route.clearOnly) return ok(postInput);
  if (route.motionBlur) {
    return addMotionBlurStage(
      context,
      topology,
      route,
      featureTargets,
      postInput,
      postTemporal,
      sceneTemporal,
      route.features.temporal && topology.opaque.lane === 'forward' ? undefined : sceneVelocity,
    );
  }
  const boundTemporal =
    sceneTemporal === undefined || sceneVelocity !== undefined
      ? undefined
      : bindStandardSceneDataTarget(sceneTemporal, topology, SCENE_DATA_TEMPORAL_V1_SCHEMA);
  const features = context.contributeFeatures({
    targets: featureTargets,
    semanticTargets: boundTemporal === undefined ? [] : [boundTemporal],
    namedTargets: {},
    standardSurfaceAccesses: [],
    exclude: [BARREL_DISTORTION_FEATURE_IDENTITY, EDITOR_ASSISTANCE_FEATURE_IDENTITY],
  });
  if (!features.ok) return features;
  return ok(postInput);
}

function addMotionBlurStage(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  featureTargets: StandardFeatureTargets,
  postInput: RenderPipelineTarget,
  postTemporal: RenderPipelineTarget | undefined,
  sceneTemporal: RenderPipelineTarget | undefined,
  sceneVelocity: SceneVelocityInputs | undefined,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  if (postTemporal === undefined && (sceneTemporal === undefined || sceneVelocity === undefined)) {
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
    semanticTargets:
      sceneVelocity === undefined && postTemporal !== undefined
        ? [bindStandardSceneDataTarget(postTemporal, topology, SCENE_DATA_TEMPORAL_V1_SCHEMA)]
        : [],
    namedTargets: {
      'motion-input': postInput,
      'motion-output': blurred.value,
    },
    standardSurfaceAccesses: [],
    exclude: [
      BARREL_DISTORTION_FEATURE_IDENTITY,
      EDITOR_ASSISTANCE_FEATURE_IDENTITY,
      ...(sceneVelocity === undefined ? [] : [MOTION_BLUR_FEATURE_IDENTITY]),
    ],
  });
  if (!features.ok) return features;

  if (sceneVelocity !== undefined && sceneTemporal !== undefined) {
    const native = addSceneVelocityMotionBlur(
      context.graph,
      postInput,
      sceneTemporal,
      sceneVelocity,
      blurred.value,
      topology.surface.width,
      topology.surface.height,
      topology.lane.compute && topology.lane.storageBuffer && topology.lane.storageTexture === true,
    );
    return native.ok ? ok(blurred.value) : native;
  }
  if (postTemporal !== undefined && context.hasFeature?.(MOTION_BLUR_FEATURE_IDENTITY) !== true) {
    const fallback = addMotionBlurPass(context.graph, postInput, postTemporal, blurred.value);
    if (!fallback.ok) return fallback;
  }
  return ok(blurred.value);
}

/** Copy the original scene only after all generic scene-target writers. */
function addSceneObservation(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  scene: RenderPipelineTarget,
): Result<void, RenderPipelineBuildError> {
  if (route.clearOnly) return ok(undefined);
  // Indirect VFX can write this target in the generic feature stage. Keep the
  // observation after those writers and before HDR lens/output processing.
  return addTypedFrameObservationPass(context.graph, scene);
}

function postOutputExtent(topology: RenderPipelineTopology) {
  return {
    width: topology.extent?.outputWidth ?? topology.surface.width,
    height: topology.extent?.outputHeight ?? topology.surface.height,
  };
}

interface PortableHdrInput {
  readonly color: RenderPipelineTarget;
  readonly glare?: RenderPipelineTarget | undefined;
}

function addHdrLensStages(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  input: RenderPipelineTarget,
  halfScene?: RenderPipelineTarget,
): Result<PortableHdrInput, RenderPipelineBuildError> {
  const fringed = route.features.chromaticAberration
    ? addChromaticAberrationStage(context, input)
    : ok(input);
  if (!fringed.ok) return fringed;
  if (route.hdr && route.features.lensFlare) {
    const glare = addLensFlareContribution(
      context,
      topology,
      input,
      halfScene,
      route.features.bloom,
    );
    return glare.ok ? ok({ color: fringed.value, glare: glare.value }) : glare;
  }
  const colored = route.features.bloom
    ? addStandardBloom(
        context,
        topology,
        fringed.value,
        route.features.chromaticAberration ? undefined : halfScene,
      )
    : fringed;
  return colored.ok ? ok({ color: colored.value }) : colored;
}

/** Scene highlights and Bloom filters share the pre-fringe HDR downsample. */
function addLensFlareContribution(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  halfScene: RenderPipelineTarget | undefined,
  bloom: boolean,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const extent = postOutputExtent(topology);
  const seed =
    halfScene === undefined
      ? addPostSceneColorHalf(context.graph, extent, scene, 'post-scene-color-half-lens')
      : ok(halfScene);
  if (!seed.ok) return seed;
  const filtered = bloom
    ? addStandardBloomFilters(context, topology, scene, seed.value)
    : ok(undefined);
  if (!filtered.ok) return filtered;
  return addLensFlarePasses(context.graph, seed.value, extent, filtered.value);
}

function addChromaticAberrationStage(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  postInput: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const fringed = target(context, 'standard-chromatic-aberration', {
    lifetime: 'pass-local',
    format: 'rgba16float',
    size: 'surface',
    domain: postInput.domain ?? 'linear-hdr',
  });
  if (!fringed.ok) return fringed;
  const pass = addTypedFullscreenPass(context.graph, {
    name: 'chromatic-aberration',
    shader: CHROMATIC_ABERRATION_POST_PROCESS_ID,
    input: postInput,
    outputs: [fringed.value],
  });
  if (!pass.ok) return pass;
  return ok(fringed.value);
}

export function addStandardBloom(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  halfScene?: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const { width, height } = postOutputExtent(topology);
  const { label, format } = STANDARD_BLOOM_TARGET_SPEC.composited;
  const composited = target(context, label, {
    format,
    size: { width, height },
    domain: 'linear-hdr',
  });
  if (!composited.ok) return composited;
  const filters = addStandardBloomFilters(context, topology, scene, halfScene, composited.value);
  if (!filters.ok) return filters;
  return ok(composited.value);
}

function addStandardBloomFilters(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  halfScene?: RenderPipelineTarget,
  composited?: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const extent = postOutputExtent(topology);
  const bloomSpecs = standardBloomTargetSpecs(
    extent.width,
    extent.height,
    topology.camera.bloomQuality ?? BLOOM_QUALITY_HIGH,
    bloomFilterFormat(context.capabilities),
  );
  const seed =
    halfScene === undefined
      ? addPostSceneColorHalf(context.graph, extent, scene, 'post-scene-color-half-bloom')
      : ok(halfScene);
  if (!seed.ok) return seed;
  const prefiltered =
    topology.camera.bloomPrefilter === true
      ? addBloomPrefilter(context.graph, extent, seed.value)
      : seed;
  if (!prefiltered.ok) return prefiltered;
  const sources = addBloomDownsampleChain(
    context.graph,
    prefiltered.value,
    bloomSpecs.levels,
    topology.lane.compute && topology.lane.storageTexture === true,
  );
  if (!sources.ok) return sources;
  const horizontal = declareBloomLevels(context, bloomSpecs.horizontal);
  if (!horizontal.ok) return horizontal;
  const vertical = declareBloomLevels(context, bloomSpecs.vertical);
  if (!vertical.ok) return vertical;
  return addTypedBloomPasses(context.graph, {
    scene,
    sources: sources.value,
    ...(composited === undefined ? {} : { composited }),
    horizontal: horizontal.value,
    vertical: vertical.value,
  });
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
  source: PortableHdrInput,
  autoExposure: StandardAutoExposure | undefined,
): Result<PortableHdrInput, RenderPipelineBuildError> {
  if (!route.features.exposure && !route.features.whiteBalance) return ok(source);
  const exposureOutput = target(context, 'standard-exposure-white-balance', {
    lifetime: 'pass-local',
    format: source.color.format === 'rgba32float' ? 'rgba32float' : 'rgba16float',
    size: 'surface',
    domain: 'linear-hdr',
  });
  if (!exposureOutput.ok) return exposureOutput;
  const exposurePass = addAutoExposureExposurePass(
    context,
    source.color,
    exposureOutput.value,
    route.features.exposure ? autoExposure : undefined,
    {
      temperature: topology.output?.temperature ?? 6504,
      tint: topology.output?.tint ?? 0,
    },
    source.glare,
  );
  if (!exposurePass.ok) return exposurePass;
  return ok({ color: exposureOutput.value });
}

function addEditorAssistanceStages(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  depth: RenderPipelineTarget,
  internalSize: GraphTextureDescriptor['size'],
  featureTargets: StandardFeatureTargets,
  postInput: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const editorReady =
    route.editorAssistance &&
    context.hasFeatureRasterWork?.(EDITOR_ASSISTANCE_FEATURE_IDENTITY) === true;
  if (route.editorOutline && editorReady) {
    const outlined = addOutlinePasses(context.graph, postInput, depth, internalSize, {
      prefix: 'editor-outline',
      programPrefix: 'forgeax.editor-outline',
      selection: (frame) => frame.editorAssistance?.source.outline,
    });
    if (!outlined.ok) return outlined;
    postInput = outlined.value;
  }
  if (editorReady) {
    const output = target(context, 'standard-editor-assistance', {
      format: 'rgba16float',
      size: 'surface',
      domain: 'linear-ldr',
    });
    if (!output.ok) return output;
    const assistance = context.contributeFeatures({
      targets: featureTargets,
      semanticTargets: [],
      namedTargets: {
        'editor-input': postInput,
        'editor-output': output.value,
        'editor-depth': depth,
      },
      standardSurfaceAccesses: [],
      include: [EDITOR_ASSISTANCE_FEATURE_IDENTITY],
    });
    if (!assistance.ok) return assistance;
    postInput = output.value;
  }
  return ok(postInput);
}

/** Tone mapping, color LUT and the linear-LDR spatial effects before output encoding. */
function addLinearLdrStages(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  depth: RenderPipelineTarget,
  internalSize: GraphTextureDescriptor['size'],
  featureTargets: StandardFeatureTargets,
  input: PortableHdrInput,
  finalPresent: RenderPipelineTarget,
  waterInfoTargets?: WaterInfoGraphTargets,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const toned = addToneStage(context, route, input.color, input.glare);
  if (!toned.ok) return toned;
  let postInput = toned.value;
  if (route.features.lut) {
    const lut = addColorLutStage(context, route, postInput, finalPresent, input.glare);
    if (!lut.ok) return lut;
    postInput = lut.value;
  }
  return addLinearLdrExtensions(
    context,
    route,
    depth,
    internalSize,
    featureTargets,
    postInput,
    waterInfoTargets,
  );
}

function addLinearLdrExtensions(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  depth: RenderPipelineTarget,
  internalSize: GraphTextureDescriptor['size'],
  featureTargets: StandardFeatureTargets,
  input: RenderPipelineTarget,
  waterInfoTargets?: WaterInfoGraphTargets,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  let postInput = input;
  if (route.features.outline && route.distanceOutlineFirstStep === undefined) {
    const outlined = addOutlinePasses(
      context.graph,
      postInput,
      depth,
      internalSize,
      route.editorAssistance
        ? {
            selection: (frame) => {
              const selection =
                frame.editorAssistance === undefined
                  ? frame.camera.outline
                  : frame.editorAssistance.authoredOutline;
              return selection?.distanceField ? undefined : selection;
            },
          }
        : {},
      waterInfoTargets,
    );
    if (!outlined.ok) return outlined;
    postInput = outlined.value;
  }
  const assistance = addEditorAssistanceStages(
    context,
    route,
    depth,
    internalSize,
    featureTargets,
    postInput,
  );
  if (!assistance.ok) return assistance;
  postInput = assistance.value;
  // Debug geometry is world-space scene content. Insert it before the spatial
  // warp so its lines and markers bend with the rendered world. Screen-space
  // diagnostics remain on the final surface when no warp is active.
  if (route.rawOnly || route.debugOverlayBeforePost) {
    const overlay = addTypedDebugOverlayPass(context.graph, postInput);
    if (!overlay.ok) return overlay;
  }
  return ok(postInput);
}

interface SpatialOutputInput {
  readonly color: RenderPipelineTarget;
  readonly smaaWeights?: RenderPipelineTarget;
}

/** Edges follow pre-Tonemap scene coordinates; the lens warp follows the blend. */
function addSpatialOutputStages(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  featureTargets: StandardFeatureTargets,
  preTone: RenderPipelineTarget,
  postTone: RenderPipelineTarget,
  retainLinear: boolean,
): Result<SpatialOutputInput, RenderPipelineBuildError> {
  let color = postTone;
  if (route.features.smaa) {
    const weights = addSmaaWeights(context.graph, preTone);
    if (!weights.ok) return weights;
    if (!retainLinear && !route.features.barrelDistortion)
      return ok({ color, smaaWeights: weights.value });
    const blended = addSmaaBlend(context.graph, color, weights.value);
    if (!blended.ok) return blended;
    color = blended.value;
  }
  if (route.features.barrelDistortion) {
    const barrel = addBarrelDistortionStage(context, featureTargets, color);
    if (!barrel.ok) return barrel;
    color = barrel.value;
  }
  return ok({ color });
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
  glare?: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const observesLinearLdr = context.observationCaptureDomains?.includes('linear-ldr') === true;
  if (route.fusedToneLut || !(route.splitOutput || observesLinearLdr)) return ok(postInput);
  const toneOutput = target(context, 'standard-tone-output', {
    lifetime: 'pass-local',
    format: 'rgba16float',
    size: 'surface',
    domain: 'linear-ldr',
  });
  if (!toneOutput.ok) return toneOutput;
  const transformed = addTypedOutputTransformPass(context.graph, postInput, toneOutput.value, {
    dither: false,
    name: 'standard-tone',
    fragmentEntryPoint: 'fs_tone_only',
    glare,
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
  glare?: RenderPipelineTarget,
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
      glare,
    );
    if (!fused.ok) return fused;
    return ok(finalPresent);
  }
  const lutOutput = target(context, 'standard-color-lut', {
    lifetime: 'pass-local',
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
    lifetime: 'pass-local',
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

function declareEncodedFxaaInput(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  name: 'standard-grade-output' | 'standard-output-color',
  compact: boolean,
): Result<RenderPipelineTarget, RenderGraphError> {
  return target(context, name, {
    format: compact ? 'rgba8unorm' : 'rgba16float',
    size: 'surface',
    usage: GPU_TEXTURE_USAGE_COPY_SRC,
    domain: 'display-encoded',
  });
}

const FXAA_NO_DITHER_PARAMS = new Uint8Array(16);

/**
 * Split output keeps FXAA in linear LDR; the combined route encodes first and
 * lets FXAA write the encoded endpoint.
 */
function addFxaaStage(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  route: StandardPostRoute,
  postInput: RenderPipelineTarget,
  encodedOutput: RenderPipelineTarget,
  glare?: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const compact = !route.splitOutput && isUnorm8DisplayTarget(encodedOutput);
  const output = route.splitOutput
    ? target(context, 'standard-fxaa-output', {
        format: 'rgba16float',
        size: 'surface',
        domain: 'linear-ldr',
      })
    : declareEncodedFxaaInput(context, 'standard-output-color', compact);
  if (!output.ok) return output;
  if (!route.splitOutput) {
    // Dither the first 8-bit write while sub-code precision is still available.
    const outputTransform = addTypedOutputTransformPass(context.graph, postInput, output.value, {
      dither: compact ? route.outputDither : false,
      glare,
    });
    if (!outputTransform.ok) return outputTransform;
  }
  const aa = addTypedFullscreenPass(context.graph, {
    name: 'fxaa',
    shader: 'fxaa',
    input: route.splitOutput ? postInput : output.value,
    outputs: [route.splitOutput ? output.value : encodedOutput],
    ...(route.splitOutput || compact
      ? {
          paramsTransform: () => FXAA_NO_DITHER_PARAMS,
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
  encodedOutput: RenderPipelineTarget,
  glare?: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  if (route.splitOutput) return ok(postInput);
  const transformed = addTypedOutputTransformPass(context.graph, postInput, encodedOutput, {
    dither:
      route.rawOnly && route.postEffects.length > 0 && !isUnorm8DisplayTarget(encodedOutput)
        ? false
        : route.outputDither,
    glare,
  });
  if (!transformed.ok) return transformed;
  return ok(postInput);
}

function addLensEffectsStage(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  postInput: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const lensOutput = target(context, 'standard-lens-effects', {
    lifetime: 'pass-local',
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
  input: SpatialOutputInput,
  encodedOutput: RenderPipelineTarget,
  glare?: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  let postInput = input.color;
  if (route.hdr || route.linearLdr || route.features.fxaa || route.rawOnly || route.motionBlur) {
    const transformed = route.features.fxaa
      ? addFxaaStage(context, route, postInput, encodedOutput, glare)
      : addCombinedOutputTransform(context, route, postInput, encodedOutput, glare);
    if (!transformed.ok) return transformed;
    postInput = transformed.value;
  }
  if (route.features.lensEffects) {
    const lens = addLensEffectsStage(context, postInput);
    if (!lens.ok) return lens;
    postInput = lens.value;
  }
  if (route.splitOutput && !route.fusedToneLut) {
    const outputTransform = addTypedOutputTransformPass(context.graph, postInput, encodedOutput, {
      dither: route.outputDither,
      name: input.smaaWeights === undefined ? 'standard-output-encoding' : 'smaa-blend',
      fragmentEntryPoint: 'fs_encode_only',
      smaaWeights: input.smaaWeights,
      observationCaptureDomains: context.observationCaptureDomains?.filter(
        (domain) => domain !== 'final-display',
      ),
    });
    if (!outputTransform.ok) return outputTransform;
    postInput = encodedOutput;
  }
  return ok(postInput);
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

/** Grade and Encode agree on the physical attachment and its dither boundary. */
function declareNativeGradeTargets(
  context: StandardPostContext,
  features: StandardPostRoute['features'],
  finalPresent: RenderPipelineTarget,
  linearSeam: boolean,
) {
  // Grain consumes fractional encoded color after FXAA, as do float destinations.
  const compact = features.fxaa && !features.lensEffects && isUnorm8DisplayTarget(finalPresent);
  const encoded = features.fxaa
    ? declareEncodedFxaaInput(context, 'standard-grade-output', compact)
    : ok(finalPresent);
  if (!encoded.ok) return encoded;
  const grade = linearSeam
    ? target(context, 'standard-grade-linear', {
        format: 'rgba16float',
        size: 'surface',
        domain: 'linear-ldr',
      })
    : encoded;
  return grade.ok ? ok({ grade: grade.value, encoded: encoded.value, compact }) : grade;
}

/** Fused default core, with explicitly selected spatial extensions in linear LDR. */
function addNativeStandardOutput(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  input: RenderPipelineTarget,
  autoExposure: StandardAutoExposure | undefined,
  finalPresent: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  featureTargets: StandardFeatureTargets,
  waterInfoTargets?: WaterInfoGraphTargets,
  halfScene?: RenderPipelineTarget,
): Result<void, RenderPipelineBuildError> {
  const lensFlare = route.hdr && route.features.lensFlare;
  const glare = lensFlare
    ? addLensFlareContribution(context, topology, input, halfScene, route.features.bloom)
    : route.features.bloom
      ? addStandardBloomFilters(context, topology, input, halfScene)
      : ok(undefined);
  if (!glare.ok) return glare;
  const lut = context.standardOutput?.colorLut;
  if (route.features.lut && lut === undefined)
    return err(
      new RenderGraphError({
        code: 'resource-resolution-failed',
        expected: 'the selected native Grade LUT has a prepared graph projection',
        hint: 'prepare the selected Camera color LUT before compiling its output graph',
      }),
    );
  const linearSeam = nativeGradeNeedsLinearImage(
    topology.camera,
    context.observationCaptureDomains?.includes('linear-ldr') === true,
  );
  const outputs = declareNativeGradeTargets(context, route.features, finalPresent, linearSeam);
  if (!outputs.ok) return outputs;
  const { grade, encoded, compact } = outputs.value;
  const parameters = addNativeOutputParameters(context.graph, {
    bloomIntensity: lensFlare ? 1 : route.features.bloom ? 'camera' : 0,
    lut: route.features.lut ? lut : undefined,
    sharpen: 0,
    dither: route.outputDither,
    ditherAtEncoding: compact,
    finishInGrade: !route.features.fxaa,
    linearGrade: linearSeam,
  });
  if (!parameters.ok) return parameters;
  const graded = addNativeOutputPass(
    context.graph,
    'standard-grade',
    input,
    grade,
    parameters.value,
    {
      kind: 'grade',
      exposure: route.features.exposure ? autoExposure?.candidate : undefined,
      bloom: glare.value,
      lut: route.features.lut ? lut : undefined,
    },
  );
  if (!graded.ok) return graded;
  const encodeLinearSeam = (): Result<void, RenderPipelineBuildError> => {
    if (!linearSeam) return ok(undefined);
    const extended = addLinearLdrExtensions(
      context,
      route,
      depth,
      renderInternalSize(topology),
      featureTargets,
      grade,
      waterInfoTargets,
    );
    if (!extended.ok) return extended;
    const observeLinear = context.observationCaptureDomains?.includes('linear-ldr') === true;
    const spatial = addSpatialOutputStages(
      context,
      route,
      featureTargets,
      input,
      extended.value,
      observeLinear,
    );
    if (!spatial.ok) return spatial;
    const { color, smaaWeights } = spatial.value;
    if (observeLinear) {
      const captured = addObservationCapturePass(context.graph, color, 'linear-ldr');
      if (!captured.ok) return captured;
    }
    return addNativeOutputPass(
      context.graph,
      smaaWeights === undefined ? 'standard-encode' : 'smaa-blend',
      color,
      encoded,
      parameters.value,
      { kind: 'encode', smaaWeights },
    );
  };
  const encode = encodeLinearSeam();
  if (!encode.ok) return encode;
  return route.features.fxaa
    ? addNativeOutputPass(
        context.graph,
        'standard-final',
        encoded,
        finalPresent,
        parameters.value,
        { kind: 'final', fxaa: true },
      )
    : ok(undefined);
}

interface StandardPostInputs {
  readonly sceneTemporal?: RenderPipelineTarget | undefined;
  /** Visible surface depth paired with scene color when it differs from opaque depth. */
  readonly sceneColorDepth?: RenderPipelineTarget;
  readonly secondaryReactivity?: TemporalSecondaryReactivity | undefined;
  readonly coverage?: RenderPipelineTarget | undefined;
  readonly coverageDepth?: RenderPipelineTarget | undefined;
  readonly opaqueGuide?: RenderPipelineTarget | undefined;
  readonly waterInfoTargets?: WaterInfoGraphTargets | undefined;
  readonly gpuDriven?: RenderPipelineGpuDrivenProjection | undefined;
  readonly waterFoamSimulation?: GraphTextureView | undefined;
  readonly sceneVelocity?: SceneVelocityInputs | undefined;
}

const EMPTY_POST_INPUTS: StandardPostInputs = {};

function preparePostHalfScene(
  context: StandardPostContext,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
) {
  const extent = postOutputExtent(topology);
  const meterHalf = route.features.exposure && topology.output?.autoExposureHalfRes === true;
  const lensFlare = route.hdr && route.features.lensFlare;
  const lensUsesUnfilteredScene =
    route.distanceOutlineFirstStep === undefined &&
    !topology.hdrOutputEffects?.length &&
    (lensFlare || !route.features.chromaticAberration || usesNativeGrade(topology));
  const needsHalf = meterHalf || ((lensFlare || route.features.bloom) && lensUsesUnfilteredScene);
  const fusedHalf =
    needsHalf &&
    route.features.temporal &&
    topology.camera.antialias === 'tsr' &&
    usesTsrCompute(topology.lane) &&
    !route.motionBlur &&
    context.hasFeatureWork?.(undefined, 'post') === false
      ? declarePostSceneColorHalf(context.graph, extent, 'post-scene-color-half')
      : ok(undefined);
  return fusedHalf.ok
    ? ok({ extent, meterHalf, lensUsesUnfilteredScene, needsHalf, fusedHalf: fusedHalf.value })
    : fusedHalf;
}

function addStandardPostTemporalInputs(
  context: StandardPostContext,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  scene: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  visibleDepth: RenderPipelineTarget,
  needsOutputDepth: boolean,
  inputs: StandardPostInputs,
) {
  const {
    sceneTemporal,
    secondaryReactivity,
    coverage,
    coverageDepth,
    opaqueGuide,
    waterInfoTargets,
    gpuDriven,
    waterFoamSimulation,
    sceneVelocity,
  } = inputs;
  const preTemporal = addPreTemporalEffects(
    context,
    topology,
    route.preTemporalEffects,
    scene,
    depth,
  );
  if (!preTemporal.ok) return preTemporal;
  const focused = route.features.dof
    ? addDepthOfFieldPasses(
        context.graph,
        context.camera?.depthOfField,
        renderInternalCopySize(topology),
        preTemporal.value,
        visibleDepth,
        context.capabilities?.rg16floatRenderable ? 'rg16float' : 'rgba16float',
        topology.lane,
      )
    : preTemporal;
  if (!focused.ok) return focused;
  let preMotionColor = focused.value;
  let postTemporal = sceneVelocity === undefined ? sceneTemporal : undefined;
  const autoExposure = requireAutoExposure(context, route);
  if (!autoExposure.ok) return autoExposure;
  const halfPlan = preparePostHalfScene(context, topology, route);
  if (!halfPlan.ok) return halfPlan;
  const { fusedHalf } = halfPlan.value;
  const prepareTemporalAndOutputDepth = () => {
    if (route.features.temporal) {
      const history = addStandardTemporalResolve(
        context,
        topology,
        preMotionColor,
        depth,
        sceneTemporal,
        secondaryReactivity,
        coverage,
        coverageDepth,
        opaqueGuide,
        sceneVelocity,
        fusedHalf,
      );
      if (!history.ok) return history;
      preMotionColor = history.value.currentColor;
      postTemporal = history.value.currentTemporal;
    }
    return addStandardPostProcessDepth(context, topology, scene, {
      requested: needsOutputDepth,
      temporal: route.features.temporal,
      visibleDepth,
      gpuDriven,
      waterInfoTargets,
      waterFoamSimulation,
    });
  };
  const exactDepth = prepareTemporalAndOutputDepth();
  if (!exactDepth.ok) return exactDepth;
  return ok({
    preMotionColor,
    postTemporal,
    exactDepth: exactDepth.value,
    autoExposure: autoExposure.value,
    ...halfPlan.value,
  });
}

function addStandardHdrOutputEffects(
  context: StandardPostContext,
  topology: RenderPipelineTopology,
  route: StandardPostRoute,
  input: RenderPipelineTarget,
  depth: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const outlined =
    route.distanceOutlineFirstStep === undefined
      ? ok(input)
      : addDistanceOutlinePasses(context.graph, input, depth, route.distanceOutlineFirstStep);
  if (!outlined.ok || route.clearOnly || topology.camera.postProcessing === false) return outlined;
  return addHdrOutputEffects(context, topology, outlined.value);
}

/**
 * Build the one Standard post chain shared by direct and clustered lighting.
 * Bloom is admitted before any Bloom target is declared, keeping the disabled
 * path exact-zero while building one bounded five-level HDR
 * horizontal/vertical Gaussian pyramid for the enabled path.
 */
export function addStandardPost(
  context: StandardPostContext,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  surface: StandardPostSurface,
  inputs: StandardPostInputs = EMPTY_POST_INPUTS,
): Result<void, RenderPipelineBuildError> {
  const { sceneTemporal, sceneColorDepth, waterInfoTargets, sceneVelocity } = inputs;
  if (topology.clearOnly === true && surface.display === undefined) {
    return addClearOnlyPresent(context, scene, surface);
  }
  const route = standardPostRoute(context, topology);
  const capabilityFailure = lensCapabilityFailure(context, route.features);
  if (capabilityFailure !== undefined) return err(capabilityFailure);
  const output = declareStandardColorOutput(context, topology, route, surface);
  if (!output.ok) return output;
  const {
    color,
    effectInput,
    endpoint,
    endpointFeatures,
    needsOutputDepth,
    observed: observedOutput,
  } = output.value;
  const visibleDepth = sceneColorDepth ?? depth;
  const encodedOutput = effectInput ?? color;
  const hdr = addStandardPostTemporalInputs(
    context,
    topology,
    route,
    scene,
    depth,
    visibleDepth,
    needsOutputDepth,
    inputs,
  );
  if (!hdr.ok) return hdr;
  const {
    preMotionColor,
    postTemporal,
    exactDepth,
    autoExposure,
    extent,
    meterHalf,
    lensUsesUnfilteredScene,
    needsHalf,
    fusedHalf,
  } = hdr.value;
  // Forward SSR saves the resolved scene color before display filters.
  if (context.ssrSceneColorOutput !== undefined) {
    const snapshot = addTypedFullscreenPass(context.graph, {
      name: 'ssr-scene-color-history',
      shader: SSR_SCENE_COLOR_HISTORY_PROGRAM.name,
      input: preMotionColor,
      outputs: [context.ssrSceneColorOutput],
    });
    if (!snapshot.ok) return snapshot;
  }
  const featureTargets = standardFeatureTargets(preMotionColor, depth);
  const featured = addSceneFeatureStages(
    context,
    topology,
    route,
    featureTargets,
    preMotionColor,
    postTemporal,
    sceneTemporal,
    sceneVelocity,
  );
  if (!featured.ok) return featured;
  const halfScene =
    needsHalf && fusedHalf === undefined
      ? addPostSceneColorHalf(context.graph, extent, featured.value, 'post-scene-color-half')
      : ok(fusedHalf);
  if (!halfScene.ok) return halfScene;
  const metered = addExposureMeter(
    context,
    topology,
    route,
    meterHalf ? (halfScene.value ?? featured.value) : featured.value,
    autoExposure,
    meterHalf,
  );
  if (!metered.ok) return metered;
  const observed = addSceneObservation(context, route, scene);
  if (!observed.ok) return observed;
  const highlighted = addStandardHdrOutputEffects(context, topology, route, featured.value, depth);
  if (!highlighted.ok) return highlighted;
  const hdrColor = highlighted.value;
  const publishStandardOutput = (selectedRoute: StandardPostRoute = route) => {
    if (effectInput !== undefined) {
      const effects = addTypedCompositePostEffects(
        context.graph,
        route.postEffects,
        effectInput,
        color,
        depth,
      );
      if (!effects.ok) return effects;
    }
    if (endpointFeatures !== undefined) {
      const features = addAfterTonemapFeatures(
        context,
        color,
        endpoint,
        endpointFeatures,
        visibleDepth,
        exactDepth,
        waterInfoTargets,
      );
      if (!features.ok) return features;
    }
    return addStandardPresentStages(context, selectedRoute, surface, endpoint, observedOutput);
  };
  const addSelectedColorOutput = () => {
    if (usesNativeGrade(topology)) {
      const native = addNativeStandardOutput(
        context,
        topology,
        route,
        hdrColor,
        autoExposure,
        encodedOutput,
        depth,
        featureTargets,
        waterInfoTargets,
        lensUsesUnfilteredScene ? halfScene.value : undefined,
      );
      if (!native.ok) return native;
      // V2's encoded debug overlay follows the shared feature/output publication.
      return publishStandardOutput({
        ...route,
        debugOverlayBeforePost: nativeGradeOverlaysLinearImage(
          topology.camera,
          context.observationCaptureDomains?.includes('linear-ldr') === true,
        ),
      });
    }
    const lensed = addHdrLensStages(
      context,
      topology,
      route,
      hdrColor,
      lensUsesUnfilteredScene ? halfScene.value : undefined,
    );
    if (!lensed.ok) return lensed;
    const exposed = addExposureWhiteBalance(context, topology, route, lensed.value, autoExposure);
    if (!exposed.ok) return exposed;
    const ldr = addLinearLdrStages(
      context,
      route,
      depth,
      renderInternalSize(topology),
      featureTargets,
      exposed.value,
      encodedOutput,
      waterInfoTargets,
    );
    if (!ldr.ok) return ldr;
    const spatial = addSpatialOutputStages(
      context,
      route,
      featureTargets,
      lensed.value.color,
      ldr.value,
      route.features.lensEffects ||
        context.observationCaptureDomains?.includes('linear-ldr') === true,
    );
    if (!spatial.ok) return spatial;
    const encoded = addOutputEncodingStages(
      context,
      route,
      spatial.value,
      encodedOutput,
      route.splitOutput ? undefined : exposed.value.glare,
    );
    if (!encoded.ok) return encoded;
    return publishStandardOutput();
  };
  return addSelectedColorOutput();
}
