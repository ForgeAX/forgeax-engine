import type {
  CompiledRenderGraphInfo,
  GraphAccess,
  GraphTextureDescriptor,
  GraphTextureView,
} from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { standardBloomAdmitted } from '../bloom-admission';
import { addTypedDebugOverlayPass } from '../debug-draw-glue';
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

interface StandardPostSurface {
  readonly display?: RenderPipelineTarget;
  readonly storage: RenderPipelineTarget;
}

export const STANDARD_BLOOM_MAX_LEVELS = 5;

/** One authored Bloom contract drives declaration and compiled-graph validation. */
export const STANDARD_BLOOM_TARGET_SPEC = {
  composited: { label: 'bloom-composited', format: 'rgba16float' },
  downsamplePrefix: 'bloom-downsample-',
  upsamplePrefix: 'bloom-upsample-',
} as const;

export interface StandardBloomLevelDimensions {
  readonly width: number;
  readonly height: number;
}

/** Derive the bounded ceil-halving output pyramid, including D0. */
export function deriveStandardBloomLevels(
  outputWidth: number,
  outputHeight: number,
): readonly StandardBloomLevelDimensions[] {
  const levels: StandardBloomLevelDimensions[] = [];
  let width = Math.max(1, Math.ceil(outputWidth / 2));
  let height = Math.max(1, Math.ceil(outputHeight / 2));
  for (let level = 0; level < STANDARD_BLOOM_MAX_LEVELS; level += 1) {
    levels.push({ width, height });
    if (width === 1 && height === 1) break;
    width = Math.max(1, Math.ceil(width / 2));
    height = Math.max(1, Math.ceil(height / 2));
  }
  return levels;
}

export interface StandardBloomTargetSpecs {
  readonly composited: GraphTextureDescriptor & { readonly label: string };
  readonly downsample: readonly (GraphTextureDescriptor & { readonly label: string })[];
  readonly upsample: readonly (GraphTextureDescriptor & { readonly label: string })[];
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
    downsample: levels.map((size, level) => ({
      label: `${STANDARD_BLOOM_TARGET_SPEC.downsamplePrefix}${level}`,
      format: 'rgba16float' as const,
      size,
      domain: 'linear-hdr' as const,
    })),
    upsample: levels.slice(0, -1).map((size, level) => ({
      label: `${STANDARD_BLOOM_TARGET_SPEC.upsamplePrefix}${level}`,
      format: 'rgba16float' as const,
      size,
      domain: 'linear-hdr' as const,
    })),
    levels,
  };
}

export interface StandardBloomGraphInspection {
  readonly status: 'empty' | 'valid' | 'invalid';
  readonly targetCount: number;
  readonly targetBytes: number;
  readonly passCount: number;
  readonly levelCount: number;
  readonly levelDimensions: readonly StandardBloomLevelDimensions[];
  readonly downsamplePassCount: number;
  readonly upsamplePassCount: number;
}

const emptyBloomGraphInspection = (): StandardBloomGraphInspection => ({
  status: 'empty',
  targetCount: 0,
  targetBytes: 0,
  passCount: 0,
  levelCount: 0,
  levelDimensions: [],
  downsamplePassCount: 0,
  upsamplePassCount: 0,
});

const invalidBloomGraphInspection = (): StandardBloomGraphInspection => ({
  status: 'invalid',
  targetCount: 0,
  targetBytes: 0,
  passCount: 0,
  levelCount: 0,
  levelDimensions: [],
  downsamplePassCount: 0,
  upsamplePassCount: 0,
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
  const texelBytes = 8;
  let bytes = 0;
  for (let level = 0; level < descriptor.mipLevelCount; level += 1) {
    bytes +=
      Math.max(1, descriptor.width >> level) *
      Math.max(1, descriptor.height >> level) *
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
  const downsample = graph.resources
    .filter((resource) => resource.label.startsWith(STANDARD_BLOOM_TARGET_SPEC.downsamplePrefix))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const upsample = graph.resources
    .filter((resource) => resource.label.startsWith(STANDARD_BLOOM_TARGET_SPEC.upsamplePrefix))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const targets = [...composited, ...downsample, ...upsample];
  const passes = graph.passes
    .filter(
      (pass) =>
        pass.name === TYPED_BLOOM_PASS_NAMES.composite ||
        pass.name.startsWith(`${TYPED_BLOOM_PASS_NAMES.downsample}-`) ||
        pass.name.startsWith(`${TYPED_BLOOM_PASS_NAMES.upsample}-`),
    )
    .sort((left, right) => left.executionIndex - right.executionIndex);
  if (targets.length === 0 && passes.length === 0) return emptyBloomGraphInspection();
  if (composited.length !== 1) return invalidBloomGraphInspection();
  const compositedResource = composited[0];
  if (compositedResource === undefined) return invalidBloomGraphInspection();
  const compositedSize = resourceSize(compositedResource);
  if (compositedSize === undefined) return invalidBloomGraphInspection();

  const expected = standardBloomTargetSpecs(compositedSize.width, compositedSize.height);
  const expectedDownsampleLabels = expected.downsample.map((entry) => entry.label);
  const expectedUpsampleLabels = expected.upsample.map((entry) => entry.label);
  const orderedDownsample = downsample.sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { numeric: true }),
  );
  const orderedUpsample = upsample.sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { numeric: true }),
  );
  const completeTargetSet =
    targets.length === 1 + expectedDownsampleLabels.length + expectedUpsampleLabels.length &&
    orderedDownsample.length === expectedDownsampleLabels.length &&
    orderedUpsample.length === expectedUpsampleLabels.length &&
    orderedDownsample.every(
      (resource, level) => resource.label === expectedDownsampleLabels[level],
    ) &&
    orderedUpsample.every((resource, level) => resource.label === expectedUpsampleLabels[level]) &&
    orderedDownsample.every(
      (resource, level) =>
        resourceSize(resource)?.width === expected.levels[level]?.width &&
        resourceSize(resource)?.height === expected.levels[level]?.height,
    ) &&
    orderedUpsample.every(
      (resource, level) =>
        resourceSize(resource)?.width === expected.levels[level]?.width &&
        resourceSize(resource)?.height === expected.levels[level]?.height,
    );
  const expectedPassNames = [
    ...expectedDownsampleLabels,
    ...[...expectedUpsampleLabels].reverse(),
    TYPED_BLOOM_PASS_NAMES.composite,
  ];
  const completePassSet =
    passes.length === expected.levels.length + expected.upsample.length + 1 &&
    passes.every((pass, index) => pass.name === expectedPassNames[index]);
  const sceneLabel = passes[0]?.accesses[0]?.resource;
  const passTopology =
    completePassSet &&
    sceneLabel !== undefined &&
    !sceneLabel.startsWith(STANDARD_BLOOM_TARGET_SPEC.downsamplePrefix) &&
    !sceneLabel.startsWith(STANDARD_BLOOM_TARGET_SPEC.upsamplePrefix) &&
    sceneLabel !== STANDARD_BLOOM_TARGET_SPEC.composited.label &&
    graph.resources.some((resource) => resource.label === sceneLabel) &&
    orderedDownsample.every((_, level) =>
      hasPassAccesses(passes[level], [
        {
          resource: level === 0 ? sceneLabel : `bloom-downsample-${level - 1}`,
          usage: 'sampled-read',
        },
        { resource: `bloom-downsample-${level}`, usage: 'color-attachment' },
      ]),
    ) &&
    orderedUpsample.every((_, level) => {
      const passIndex = expected.levels.length + expected.upsample.length - 1 - level;
      return hasPassAccesses(passes[passIndex], [
        { resource: `bloom-downsample-${level}`, usage: 'sampled-read' },
        {
          resource:
            level === expected.levels.length - 2
              ? `bloom-downsample-${level + 1}`
              : `bloom-upsample-${level + 1}`,
          usage: 'sampled-read',
        },
        { resource: `bloom-upsample-${level}`, usage: 'color-attachment' },
      ]);
    }) &&
    hasPassAccesses(passes.at(-1), [
      { resource: sceneLabel, usage: 'sampled-read' },
      {
        resource: expected.levels.length === 1 ? 'bloom-downsample-0' : 'bloom-upsample-0',
        usage: 'sampled-read',
      },
      { resource: STANDARD_BLOOM_TARGET_SPEC.composited.label, usage: 'color-attachment' },
    ]);
  if (!completeTargetSet || !passTopology) {
    return invalidBloomGraphInspection();
  }
  const levelDimensions = orderedDownsample.flatMap((resource) => {
    const size = resourceSize(resource);
    return size === undefined ? [] : [size];
  });
  if (levelDimensions.length !== orderedDownsample.length) {
    return invalidBloomGraphInspection();
  }
  const targetBytes = targets.reduce((bytes, resource) => bytes + (textureBytes(resource) ?? 0), 0);
  return {
    status: 'valid',
    targetCount: targets.length,
    targetBytes,
    passCount: passes.length,
    levelCount: orderedDownsample.length,
    levelDimensions,
    downsamplePassCount: orderedDownsample.length,
    upsamplePassCount: orderedUpsample.length,
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
 * Build the one Standard post chain shared by direct and clustered lighting.
 * Bloom is admitted before any Bloom target is declared, keeping the disabled
 * path exact-zero while building one bounded five-level HDR
 * downsample/tent-upsample pyramid for the enabled path.
 */
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
  return context.contributeFeatures(
    [
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
    [],
    {},
    receiverAccesses,
    { exclude: [BARREL_DISTORTION_FEATURE_IDENTITY] },
    [],
    atmosphere,
  );
}

export function addStandardPost(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  surface: StandardPostSurface,
  sceneTemporal?: RenderPipelineTarget,
  secondaryReactivity?: GraphTextureView,
  coverage?: RenderPipelineTarget,
  coverageDepth?: RenderPipelineTarget,
): Result<void, RenderPipelineBuildError> {
  const clearOnly = topology.clearOnly === true;
  if (clearOnly && surface.display === undefined) {
    // Raw-only surfaces are attachment-only. The clear already landed in the
    // graph-owned encoded scene target; observe it and present without encoding again.
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
  const outputPlan = createStandardOutputPlan({
    lane: topology.standardProfile?.renderPath === 'deferred' ? 'clustered' : 'direct',
    temporal: !clearOnly && topology.camera.antialias === 'taa',
    meter: topology.output?.autoExposure === true,
    bloom: !clearOnly && standardBloomAdmitted(topology.camera),
    dof: !clearOnly && topology.camera.depthOfField !== undefined,
    lensFlare: !clearOnly && topology.camera.lensFlare === true,
    exposure: topology.output?.autoExposure === true,
    whiteBalance: topology.output?.whiteBalance === true,
    lut: topology.output?.colorLut === true,
    outline: !clearOnly && topology.camera.outline === true,
    barrelDistortion: topology.camera.barrelDistortion === true,
    lensEffects: !clearOnly && topology.camera.lensEffects === true,
    fxaa: !clearOnly && topology.camera.antialias === 'fxaa',
    smaa: !clearOnly && topology.camera.antialias === 'smaa',
    outputEncoding: 'explicit-oetf',
  });
  if (
    (outputPlan.features.barrelDistortion ||
      outputPlan.features.lensEffects ||
      outputPlan.features.lensFlare) &&
    context.capabilities?.rgba16floatRenderable !== true
  ) {
    return err(
      new RenderFeatureCapabilityMissingError(
        outputPlan.features.barrelDistortion
          ? BARREL_DISTORTION_FEATURE_IDENTITY
          : outputPlan.features.lensEffects
            ? LENS_EFFECTS_POST_PROCESS_ID
            : LENS_FLARE_POST_PROCESS_ID,
        0,
        'rgba16floatRenderable',
      ),
    );
  }
  const hdr =
    !clearOnly && (topology.camera.tonemap !== 'none' || topology.camera.antialias === 'taa');
  // Bloom is an HDR-domain effect and its recorders intentionally no-op when
  // tone mapping is disabled. Keep the graph in the same no-op state for the
  // TAA + tonemap:none combination; otherwise the declared Bloom composite is
  // left clear and the following Output Transform presents a black frame.
  const bloomActive = hdr && outputPlan.features.bloom;
  const fxaa = outputPlan.features.fxaa;
  // Keep the graph-owned output transform on every non-HDR frame, including
  // structural lanes without storage buffers; the final writer remains the
  // single display-encoding owner.
  const linearLdr = !clearOnly && !hdr;
  const rawOnly = !clearOnly && topology.surface.profile?.kind === 'raw-only';
  const outputDither = resolveOutputDither(topology.config);
  const motionBlur = !clearOnly && topology.temporal?.motionBlur === true;
  // The barrel declaration is supplied by the ordinary feature host so its
  // shader stays prepared and recoverable, but Standard owns its one explicit
  // linear-LDR stage below. Do not send that identity through the generic
  // encoded tail, or storage-buffer lanes would sample the image twice.
  const preTemporalEffects = clearOnly ? [] : (topology.preTemporalEffects ?? []);
  const postEffects = clearOnly
    ? []
    : (topology.config?.postEffects ?? []).filter(
        (identity) =>
          !preTemporalEffects.includes(identity) &&
          identity !== BARREL_DISTORTION_POST_PROCESS_ID &&
          identity !== LENS_EFFECTS_POST_PROCESS_ID &&
          !isOutlinePostProcess(identity) &&
          !isLensFlarePostProcess(identity) &&
          !isSmaaPostProcess(identity),
      );
  const rawOnlyPostInput =
    rawOnly && postEffects.length > 0
      ? target(context, 'standard-post-effects-input', {
          format: 'rgba16float',
          size: 'surface',
          usage: GPU_TEXTURE_USAGE_COPY_SRC,
          domain: 'display-encoded',
        })
      : undefined;
  if (rawOnlyPostInput !== undefined && !rawOnlyPostInput.ok) return rawOnlyPostInput;
  // Every Standard route terminates at the same encoded raw storage endpoint.
  // The raw-only profile has no alternate display view, so its debug overlay
  // and optional post effects are kept in graph-owned float targets until the
  // single Output Transform performs the first 8-bit quantization.
  const observedOutput =
    rawOnly && context.observationCaptureDomains?.includes('final-display') === true
      ? target(context, 'standard-observed-output', {
          format: topology.surface.storageFormat,
          size: 'surface',
          domain: 'display-encoded',
        })
      : undefined;
  if (observedOutput !== undefined && !observedOutput.ok) return observedOutput;
  const finalPresent = observedOutput?.value ?? surface.storage;
  let postInput = scene;
  let postTemporal = sceneTemporal;
  for (const [index, shader] of preTemporalEffects.entries()) {
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
  const autoExposure = context.standardOutput?.autoExposure;
  if (outputPlan.features.exposure && autoExposure === undefined) {
    return err(
      new RenderGraphError({
        code: 'resource-resolution-failed',
        expected: 'a prepared same-frame auto-exposure producer projection',
        hint: 'prepare device-scoped auto-exposure resources before compiling Standard output',
        detail: { resourceLabel: 'standard-auto-exposure' },
      }),
    );
  }
  if (topology.camera.antialias === 'taa') {
    if (sceneTemporal === undefined) {
      return err(missingTemporalContributor(topology, 'forgeax::standard::scene-data'));
    }
    const history = context.taaHistory;
    if (history === undefined) {
      return err(missingTemporalContributor(topology, 'forgeax::standard::taa-history'));
    }
    const resolveTargets: TypedTemporalResolveTargets = {
      scene: postInput,
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
    postInput = history.currentColor;
    // TAA resolves both outputs to the unjittered lattice. Later effects must
    // consume its matching temporal attachment, not raw jittered coverage.
    postTemporal = history.currentTemporal;
  }

  // Meter the temporally resolved color before lens-domain filters. Motion
  // Blur and Bloom must consume a single exposure decision for this frame;
  // running the meter after either filter makes the measured luminance depend
  // on the authored streak radius and changes the exposure feedback loop.
  if (outputPlan.features.exposure && autoExposure !== undefined) {
    const added = addAutoExposureGraphPasses(context, {
      source: postInput,
      resources: autoExposure,
      width: topology.surface.width,
      height: topology.surface.height,
    });
    if (!added.ok) return added;
  }

  // Feature projection and the built-in fallback share one target contract.
  // The projection runs after TAA so Motion Blur consumes the resolved color,
  // then both paths feed the same linear float target into Bloom/Output.
  const featureTargets = [
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
  if (!clearOnly) {
    if (motionBlur) {
      if (postTemporal === undefined) {
        return err(
          new Error('Motion Blur requires the Standard scene-data producer') as RenderGraphError,
        );
      }
      const blurred = target(context, 'motion-blurred-color', {
        format: 'rgba16float',
        size: 'surface',
        domain: hdr ? 'linear-hdr' : 'linear-ldr',
      });
      if (!blurred.ok) return blurred;
      const features = context.contributeFeatures(
        featureTargets,
        [postTemporal],
        {
          'motion-input': postInput,
          'motion-output': blurred.value,
        },
        [],
        { exclude: [BARREL_DISTORTION_FEATURE_IDENTITY] },
      );
      if (!features.ok) return features;
      if (context.hasFeature?.('forgeax.motion-blur') === true) {
        postInput = blurred.value;
      } else {
        const fallback = addMotionBlurPass(context.graph, postInput, postTemporal, blurred.value);
        if (!fallback.ok) return fallback;
        postInput = blurred.value;
      }
    } else {
      const features = context.contributeFeatures(
        featureTargets,
        sceneTemporal === undefined ? [] : [sceneTemporal],
        {},
        [],
        { exclude: [BARREL_DISTORTION_FEATURE_IDENTITY] },
      );
      if (!features.ok) return features;
    }
  }

  if (outputPlan.features.dof) {
    const dof = addDepthOfFieldPasses(
      {
        graph: context.graph,
        camera: context.camera ?? {},
        temporalTaa: topology.temporal?.taa === true,
        msaaActive: depth.sampleCount === 4,
        ...(topology.extent === undefined ? {} : { extent: topology.extent }),
      },
      postInput,
      depth,
      topology.temporal?.taa === true ? postTemporal : undefined,
    );
    if (!dof.ok) return dof;
    postInput = dof.value;
  }
  if (bloomActive) {
    const outputWidth = topology.extent?.outputWidth ?? topology.surface.width;
    const outputHeight = topology.extent?.outputHeight ?? topology.surface.height;
    const bloomSpecs = standardBloomTargetSpecs(outputWidth, outputHeight);
    const composited = target(context, bloomSpecs.composited.label, bloomSpecs.composited);
    if (!composited.ok) return composited;
    const downsample: RenderPipelineTarget[] = [];
    for (const spec of bloomSpecs.downsample) {
      const level = target(context, spec.label, spec);
      if (!level.ok) return level;
      downsample.push(level.value);
    }
    const upsample: RenderPipelineTarget[] = [];
    for (const spec of bloomSpecs.upsample) {
      const level = target(context, spec.label, spec);
      if (!level.ok) return level;
      upsample.push(level.value);
    }
    const bloom = addTypedBloomPasses(context.graph, {
      scene: postInput,
      composited: composited.value,
      downsample,
      upsample,
      levelDimensions: bloomSpecs.levels,
    });
    if (!bloom.ok) return bloom;
    postInput = composited.value;
  }
  // The threshold is authored in scene HDR units, so the flare shares Bloom's
  // HDR-only admission and reads the Bloom-composited color.
  if (hdr && outputPlan.features.lensFlare) {
    const flare = addLensFlarePasses(context.graph, postInput, {
      width: topology.extent?.outputWidth ?? topology.surface.width,
      height: topology.extent?.outputHeight ?? topology.surface.height,
    });
    if (!flare.ok) return flare;
    postInput = flare.value;
  }

  if (outputPlan.features.exposure || outputPlan.features.whiteBalance) {
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
      outputPlan.features.exposure ? autoExposure : undefined,
      {
        temperature: topology.output?.temperature ?? 6504,
        tint: topology.output?.tint ?? 0,
      },
    );
    if (!exposurePass.ok) return exposurePass;
    postInput = exposureOutput.value;
  }

  // Auto exposure changes the HDR source before tone mapping, so it needs the
  // same explicit linear-LDR boundary as the LUT route even when no LUT is
  // bound. Keep the manual/LUT0 route combined so disabling auto exposure
  // remains exact-zero.
  const splitOutput =
    !clearOnly &&
    (outputPlan.features.lut ||
      outputPlan.features.exposure ||
      outputPlan.features.whiteBalance ||
      outputPlan.features.barrelDistortion ||
      outputPlan.features.lensEffects ||
      outputPlan.features.outline ||
      outputPlan.features.smaa);

  // Tone mapping and output encoding are separate entry points when a LUT is
  // enabled or auto exposure is active: the LUT must sample linear LDR, and
  // the single OETF writer runs only after LUT and optional FXAA.
  // A missing linear-LDR observation needs its own tone-only producer. It must
  // not move the ordinary FXAA pass across the output encoding boundary.
  const toneOutput =
    splitOutput || context.observationCaptureDomains?.includes('linear-ldr') === true
      ? target(context, 'standard-tone-output', {
          format: 'rgba16float',
          size: 'surface',
          domain: 'linear-ldr',
        })
      : undefined;
  if (toneOutput !== undefined) {
    if (!toneOutput.ok) return toneOutput;
    const transformed = addTypedOutputTransformPass(context.graph, postInput, toneOutput.value, {
      dither: false,
      name: 'standard-tone',
      fragmentEntryPoint: 'fs_tone_only',
    });
    if (!transformed.ok) return transformed;
    if (splitOutput) {
      postInput = toneOutput.value;
    } else {
      const captured = addObservationCapturePass(context.graph, toneOutput.value, 'linear-ldr');
      if (!captured.ok) return captured;
    }
  }

  if (outputPlan.features.lut) {
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
    const lutOutput = target(context, 'standard-color-lut', {
      format: 'rgba16float',
      size: 'surface',
      domain: 'linear-ldr',
    });
    if (!lutOutput.ok) return lutOutput;
    const lutPass = addStandardColorLutPass(context.graph, postInput, lutOutput.value, colorLut);
    if (!lutPass.ok) return lutPass;
    postInput = lutOutput.value;
  }

  if (outputPlan.features.outline) {
    const outlined = addOutlinePasses(context.graph, postInput, depth);
    if (!outlined.ok) return outlined;
    postInput = outlined.value;
  }

  // Debug geometry is world-space scene content. Insert it before the spatial
  // warp so its lines and markers bend with the rendered world. Screen-space
  // diagnostics remain on the final surface below when no warp is active.
  const debugOverlayBeforePost =
    outputPlan.features.barrelDistortion || outputPlan.features.lensEffects;
  if (rawOnly || debugOverlayBeforePost) {
    const overlay = addTypedDebugOverlayPass(context.graph, postInput);
    if (!overlay.ok) return overlay;
  }

  if (outputPlan.features.barrelDistortion) {
    const barrelOutput = target(context, 'standard-barrel-distortion', {
      format: 'rgba16float',
      size: 'surface',
      domain: 'linear-ldr',
    });
    if (!barrelOutput.ok) return barrelOutput;
    const barrel = context.contributeFeatures(
      featureTargets,
      [],
      { 'barrel-input': postInput, 'barrel-output': barrelOutput.value },
      [],
      { include: [BARREL_DISTORTION_FEATURE_IDENTITY] },
    );
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
    postInput = barrelOutput.value;
  }

  if (outputPlan.features.smaa) {
    const antialiased = addSmaaPasses(context.graph, postInput);
    if (!antialiased.ok) return antialiased;
    postInput = antialiased.value;
  }

  if (hdr || linearLdr || fxaa || rawOnly || motionBlur) {
    if (fxaa) {
      const output = splitOutput
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
      if (!splitOutput) {
        // FXAA samples this display-encoded intermediate; leave dither to the
        // final FXAA writer so the same pixel is not dithered twice.
        const outputTransform = addTypedOutputTransformPass(
          context.graph,
          postInput,
          output.value,
          { dither: false },
        );
        if (!outputTransform.ok) return outputTransform;
      }
      const aa = addTypedFullscreenPass(context.graph, {
        name: 'fxaa',
        shader: 'fxaa',
        input: splitOutput ? postInput : output.value,
        outputs: [splitOutput ? output.value : (rawOnlyPostInput?.value ?? finalPresent)],
        ...(splitOutput
          ? {
              paramsTransform: (): Uint8Array => new Uint8Array(16),
            }
          : {}),
      });
      if (!aa.ok) return aa;
      if (splitOutput) postInput = output.value;
    } else if (rawOnlyPostInput !== undefined && !splitOutput) {
      const transformed = addTypedOutputTransformPass(
        context.graph,
        postInput,
        rawOnlyPostInput.value,
        {
          dither: outputDither && postEffects.length === 0,
        },
      );
      if (!transformed.ok) return transformed;
    } else if ((rawOnly || linearLdr) && !splitOutput) {
      const transformed = addTypedOutputTransformPass(context.graph, postInput, finalPresent, {
        dither: outputDither,
      });
      if (!transformed.ok) return transformed;
    } else if (!splitOutput) {
      const outputTransform = addTypedOutputTransformPass(context.graph, postInput, finalPresent, {
        dither: outputDither,
      });
      if (!outputTransform.ok) return outputTransform;
    }
  }

  if (outputPlan.features.lensEffects) {
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
    postInput = lensOutput.value;
  }

  if (splitOutput) {
    const encodedOutput = rawOnlyPostInput?.value ?? finalPresent;
    const outputTransform = addTypedOutputTransformPass(context.graph, postInput, encodedOutput, {
      dither: outputDither,
      name: 'standard-output-encoding',
      fragmentEntryPoint: 'fs_encode_only',
      observationCaptureDomains: context.observationCaptureDomains?.filter(
        (domain) => domain !== 'final-display',
      ),
    });
    if (!outputTransform.ok) return outputTransform;
    postInput = encodedOutput;
  }

  if (postEffects.length > 0) {
    // Effects sample display-encoded values unchanged, so the copy source is
    // the raw storage view rather than the sRGB-decoding display view.
    const postInputTarget = rawOnly ? rawOnlyPostInput?.value : surface.storage;
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
      postEffects,
      postInputTarget,
      finalPresent,
      depth,
      topology.surface,
    );
    if (!effects.ok) return effects;
  }

  if (!rawOnly && !debugOverlayBeforePost) {
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
