import type {
  GraphTextureDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/feature';
import { addAtmosphereBackground } from '../environment/background';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type {
  RenderPipeline,
  RenderPipelineFrame,
  RenderPipelineSurfaceMediumPair,
  RenderPipelineTopology,
} from '../render-pipeline';
import {
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipelineTarget,
} from '../render-pipeline';
import { FORWARD_PASS_SELECTOR } from '../systems/pass-selector';
import {
  addStandardSceneDataPass,
  aggregateTemporalDemand,
  createStandardSceneDataTarget,
  requireStandardTemporalLane,
} from '../temporal/standard-scene-data';
import { addTargetCoveragePass } from '../temporal/target-coverage-attachment';
import {
  addTransmissionBackdropPasses,
  addTransmissionBackdropTemporalPass,
  resolveTransmissionBackdropTopology,
  transmissionDemandForTopology,
} from '../transmission/backdrop';
import {
  addReflectionFallbackObservationPass,
  addTypedFrameObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  type TypedScenePassOptions,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses } from '../typed-shadow-passes';
import { addOpaqueFogPasses, addTranslucencyVolumetricFogPasses } from './analytic-fog-pass';
import { addGpuLateOcclusion, sceneViewImport } from './gpu-occlusion';
import { renderExtentSize } from './render-extent';
import {
  addSingleLayerMediumMsaaPairProducer,
  addSingleLayerMediumPasses,
  addSingleLayerMediumRawDepthProducer,
  requireSingleLayerMediumInputs,
} from './single-layer-medium-passes';
import type { StandardPipelineBuildContext } from './standard-build-context';
import {
  contributeStandardCloudComposite,
  contributeStandardCloudPreOpaque,
  createStandardCloudSceneTarget,
  createStandardCloudShadowTarget,
} from './standard-cloud-stage';
import {
  standardForwardReceiverFeatureAccesses,
  standardForwardReceiverInputs,
} from './standard-forward-receiver';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  standardClusterReadAccesses,
} from './standard-lighting/graph';
import type { StandardTopologyInputValue } from './standard-lighting/topology';
import { addStandardPost, contributeStandardSceneFeatures } from './standard-post';
import { addStandardTransparentPasses } from './standard-transparency';

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

function buildUrp(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
  reuseAdjacentShadow = false,
): ReturnType<RenderPipeline['build']> {
  const graph = context.graph;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;

  const internalSize =
    topology.extent === undefined ? 'surface' : renderExtentSize(topology.extent, 'internal');
  const internalCopySize =
    topology.extent === undefined
      ? { width: topology.surface.width, height: topology.surface.height }
      : renderExtentSize(topology.extent, 'internal');

  const clearOnly = topology.clearOnly === true;
  const msaa = !clearOnly && topology.camera.antialias === 'msaa' && topology.lane.multisample;
  const hdr =
    !clearOnly && (topology.camera.tonemap !== 'none' || topology.camera.antialias === 'taa');
  const fxaa = !clearOnly && topology.camera.antialias === 'fxaa';
  const taa = !clearOnly && topology.camera.antialias === 'taa';
  const rawOnly = !clearOnly && topology.surface.profile?.kind === 'raw-only';
  // Every non-clear lane keeps a linear float scene target until the shared
  // Output Transform. This includes no-AA and the no-storage fallback: the
  // final dither and display encoding must have one graph-owned boundary.
  // MSAA resolves into a separate linear target before presentation. Treat
  // that resolved target like linear LDR so the shared Output Transform owns
  // its write into the surface storage view; without this, the resolve is
  // never presented and MSAA is indistinguishable from the no-AA path.
  const linearLdr = !clearOnly && !hdr;
  const temporalDemand = aggregateTemporalDemand({
    taa,
    motionBlur: !clearOnly && topology.temporal?.motionBlur === true,
  });
  const needsTemporalIntermediate = temporalDemand.targetCount === 1;
  const sceneFormat =
    hdr || linearLdr || rawOnly || needsTemporalIntermediate || topology.singleLayerMedium === true
      ? 'rgba16float'
      : topology.surface.storageFormat;

  const depth = target(graph, 'scene-depth', {
    format: 'depth32float-stencil8',
    size: internalSize,
    sampleCount: msaa ? 4 : 1,
  });
  if (!depth.ok) return depth;

  const sceneResolved = clearOnly
    ? surface.value.display === undefined
      ? target(graph, 'scene-color', {
          format: topology.surface.storageFormat,
          size: 'surface',
          sampleCount: 1,
          domain: 'display-encoded',
        })
      : ok(surface.value.display)
    : hdr ||
        fxaa ||
        linearLdr ||
        msaa ||
        rawOnly ||
        needsTemporalIntermediate ||
        topology.singleLayerMedium === true
      ? target(graph, 'scene-color', {
          format: sceneFormat,
          size: internalSize,
          sampleCount: 1,
          domain: 'linear-ldr',
          ...(sceneFormat === topology.surface.storageFormat &&
          topology.surface.storageFormat !== topology.surface.viewFormat
            ? { viewFormats: [topology.surface.viewFormat] }
            : {}),
        })
      : surface.value.display === undefined
        ? target(graph, 'scene-color', {
            format: topology.surface.storageFormat,
            size: 'surface',
            sampleCount: 1,
            domain: 'display-encoded',
          })
        : ok(surface.value.display);
  if (!sceneResolved.ok) return sceneResolved;
  const scene = msaa
    ? target(graph, 'scene-color-msaa', {
        format: sceneFormat,
        size: internalSize,
        sampleCount: 4,
        domain: 'linear-ldr',
        ...(sceneFormat === topology.surface.storageFormat &&
        topology.surface.storageFormat !== topology.surface.viewFormat
          ? { viewFormats: [topology.surface.viewFormat] }
          : {}),
      })
    : sceneResolved;
  if (!scene.ok) return scene;

  const mediumTargets =
    topology.singleLayerMedium === true
      ? (() => {
          const nearestLayer = target(graph, 'single-layer-medium-nearest-layer', {
            format: scene.value.format,
            size: internalSize,
            sampleCount: msaa ? 4 : 1,
            domain: 'linear-ldr',
          });
          if (!nearestLayer.ok) return nearestLayer;
          const nearestDepth = target(graph, 'single-layer-medium-nearest-depth', {
            format: 'depth32float-stencil8',
            size: internalSize,
            sampleCount: msaa ? 4 : 1,
          });
          if (!nearestDepth.ok) return nearestDepth;
          return ok({ nearestLayer: nearestLayer.value, nearestDepth: nearestDepth.value });
        })()
      : ok(undefined);
  if (!mediumTargets.ok) return mediumTargets;

  const reflectionFallback = topology.reflectionFallback?.enabled
    ? target(graph, 'reflection-fallback-linear-hdr', {
        format: 'rgba16float',
        size: internalSize,
        sampleCount: scene.value.sampleCount,
        domain: 'linear-hdr',
        usage:
          GPU_TEXTURE_USAGE_COPY_SRC |
          GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
          GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      })
    : ok(undefined);
  if (!reflectionFallback.ok) return reflectionFallback;
  if (reflectionFallback.value !== undefined) {
    const initialized = graph.addRasterPass('reflection-fallback-clear', {
      accesses: [{ resource: reflectionFallback.value.view, usage: 'color-attachment' }],
      colorAttachments: [
        {
          view: reflectionFallback.value.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      encode: () => {},
    });
    if (!initialized.ok) return initialized;
  }

  const featureShadows = context.contributeShadowFeatures?.();
  if (featureShadows !== undefined && !featureShadows.ok) return featureShadows;
  const shadows = addTypedShadowPasses(
    graph,
    topology,
    context.projectGpuDrivenShadow,
    featureShadows?.value,
    undefined,
    context.gpuDrivenStaticShadowLayers,
    reuseAdjacentShadow,
  );
  if (!shadows.ok) return shadows;

  const clusterBuffers = clearOnly ? ok(null) : importStandardClusterBuffers(graph, lighting);
  if (!clusterBuffers.ok) return clusterBuffers;
  const clusterMembership =
    clusterBuffers.value === null
      ? ok(undefined)
      : addStandardClusterMembershipPass(graph, lighting, clusterBuffers.value);
  if (!clusterMembership.ok) return clusterMembership;
  const clusterReads =
    clusterBuffers.value === null ? [] : standardClusterReadAccesses(clusterBuffers.value);

  const atmosphere =
    topology.atmosphere === true ? addAtmosphereBackground(graph, scene.value) : ok(undefined);
  if (!atmosphere.ok) return atmosphere;
  if (atmosphere.value === undefined) {
    const skybox = addTypedSkyboxPass(graph, scene.value);
    if (!skybox.ok) return skybox;
  }
  const gpuDriven = context.projectGpuDriven({
    format: scene.value.format,
    sampleCount: scene.value.sampleCount,
    lateOcclusion: topology.config?.gpuOcclusion !== false,
    ...(reflectionFallback.value === undefined
      ? {}
      : {
          additionalColorFormats: [reflectionFallback.value.format],
        }),
  });
  if (!gpuDriven.ok) return gpuDriven;
  const transmissionDemand = transmissionDemandForTopology(topology);
  const backdropDemand = {
    activeCount: transmissionDemand.activeCount + (topology.singleLayerMedium === true ? 1 : 0),
    needsRoughMips: transmissionDemand.needsRoughMips,
  };
  const transmissionActive = resolveTransmissionBackdropTopology({
    demand: transmissionDemand,
    sourceSampleCount: scene.value.sampleCount,
  }).active;
  const backdropActive = resolveTransmissionBackdropTopology({
    demand: backdropDemand,
    sourceSampleCount: scene.value.sampleCount,
  }).active;
  const featureRasterWork =
    context.hasFeatureRasterWork?.(CLOUD_LAYER_FEATURE_IDENTITY, 'scene') === true;
  const cloudScene = createStandardCloudSceneTarget(context, featureRasterWork && !msaa, {
    format: sceneResolved.value.format,
    size: internalSize,
    domain: hdr ? 'linear-hdr' : 'linear-ldr',
  });
  if (!cloudScene.ok) return cloudScene;
  const cloudShadow = createStandardCloudShadowTarget(context, featureRasterWork);
  if (!cloudShadow.ok) return cloudShadow;
  const targetCaptures = context.contributeCubeCaptures?.(atmosphere.value);
  if (targetCaptures !== undefined && !targetCaptures.ok) return targetCaptures;
  // Produce the density cache and spatial receiver shadow before opaque
  // shading. The cloud composite is a later scene pass, so it cannot be
  // projected in this call without being overwritten by `main`.
  const featureTargets = contributeStandardCloudPreOpaque(context, {
    color: sceneResolved.value,
    depth: depth.value,
    cloudShadow: cloudShadow.value,
  });
  if (!featureTargets.ok) return featureTargets;
  const receiver = standardForwardReceiverInputs({
    shadows: shadows.value,
    cloudShadow: cloudShadow.value,
    clusterReads,
  });
  const mainOptions = {
    environment: atmosphere.value,
    name: 'main',
    color: scene.value,
    ...(reflectionFallback.value === undefined
      ? {}
      : { colorTargets: [scene.value, reflectionFallback.value] }),
    depth: depth.value,
    ...(msaa ? { resolve: sceneResolved.value } : {}),
    ...receiver,
    selector: FORWARD_PASS_SELECTOR,
    colorLoadOp: 'load',
    // Opaque, transmission and ordinary transparency are separate queue
    // segments. Keeping the opaque filter unconditional prevents an
    // ordinary transparent material from being drawn before the cloud pass.
    recordMode: 'opaque' as const,
    gpuDrivenFilter: 'opaque' as const,
    ...(gpuDriven.value === undefined ? {} : { gpuDriven: gpuDriven.value }),
  } satisfies TypedScenePassOptions;
  const main = addTypedScenePass(graph, mainOptions);
  if (!main.ok) return main;
  const depthSample = graph.view(depth.value.texture, {
    label: 'occlusion-scene-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depthSample.ok) return depthSample;
  const late = addGpuLateOcclusion(graph, {
    gpuDriven: gpuDriven.value,
    depth: depthSample.value,
    multisampled: msaa,
    width: internalCopySize.width,
    height: internalCopySize.height,
    view: sceneViewImport(graph),
  });
  if (!late.ok) return late;
  if (late.value !== undefined) {
    const mainLate = addTypedScenePass(graph, {
      ...mainOptions,
      name: 'main-late',
      depthLoadOp: 'load',
      gpuDrivenPhase: 'late',
    });
    if (!mainLate.ok) return mainLate;
  }

  const opaqueMediumPair =
    topology.singleLayerMedium === true && msaa
      ? addSingleLayerMediumMsaaPairProducer({
          graph,
          label: 'single-layer-medium-opaque-resolve',
          sourceColor: scene.value,
          sourceDepth: depth.value,
          size: internalSize,
        })
      : ok(undefined);
  if (!opaqueMediumPair.ok) return opaqueMediumPair;
  if (cloudScene.value !== undefined) {
    const compositeFeatures = contributeStandardCloudComposite(
      context,
      featureTargets.value,
      { input: sceneResolved.value, output: cloudScene.value, cloudShadow: cloudShadow.value },
      [],
    );
    if (!compositeFeatures.ok) return compositeFeatures;
  }

  const temporalAdmission = requireStandardTemporalLane({
    demand: temporalDemand,
    compute: topology.lane.compute,
    storageBuffer: topology.lane.storageBuffer,
    rgba16floatRenderable: context.capabilities?.rgba16floatRenderable ?? false,
  });
  if (!temporalAdmission.ok) return temporalAdmission;
  const temporal =
    temporalDemand.targetCount === 1
      ? createStandardSceneDataTarget(graph, topology.extent)
      : ok(undefined);
  if (!temporal.ok) return temporal;
  if (temporal.value !== undefined) {
    const producer = addStandardSceneDataPass(
      graph,
      temporal.value.temporal,
      depth.value,
      gpuDriven.value,
    );
    if (!producer.ok) return producer;
  }
  if (context.targetCoverage !== undefined) {
    const coverage = addTargetCoveragePass(graph, context.targetCoverage, gpuDriven.value);
    if (!coverage.ok) return coverage;
  }

  let sceneForLater: RenderPipelineTarget = scene.value;
  let sceneResolvedForLater: RenderPipelineTarget = sceneResolved.value;
  if (cloudScene.value !== undefined) {
    sceneForLater = cloudScene.value;
    sceneResolvedForLater = cloudScene.value;
  }

  // Analytic fog composites onto the opaque scene before transmission copies
  // and translucent draws. Every translucent writer then fogs itself at its
  // own depth, so blending composes depth-correctly.
  const fogged = addOpaqueFogPasses(graph, {
    topology,
    color: sceneResolvedForLater,
    depth: depth.value,
  });
  if (!fogged.ok) return fogged;

  const transmission = addTransmissionBackdropPasses({
    graph,
    source: sceneResolvedForLater,
    demand: backdropDemand,
    copySize: internalCopySize,
    surfaceSize: topology.surface,
    encodeRoughMip: context.encodeTransmissionMip,
    includeConsumerPasses: false,
  });
  if (!transmission.ok) return transmission;
  if (topology.singleLayerMedium === true) {
    const medium = requireSingleLayerMediumInputs(
      mediumTargets.value,
      transmission.value.backdrop?.view,
    );
    if (!medium.ok) return medium;
    let rawDepthTarget: RenderPipelineTarget | undefined = opaqueMediumPair.value?.depth;
    if (rawDepthTarget === undefined) {
      const rawDepth = addSingleLayerMediumRawDepthProducer({
        graph,
        sourceColor: sceneResolvedForLater,
        sourceDepth: depth.value,
        size: internalSize,
      });
      if (!rawDepth.ok) return rawDepth;
      rawDepthTarget = rawDepth.value;
    }
    const surfacePair: RenderPipelineSurfaceMediumPair = {
      opaqueColor: opaqueMediumPair.value?.color.view ?? medium.value.backdrop,
      rawDepth:
        rawDepthTarget === undefined
          ? { status: 'unavailable', reason: 'depth-copy-unavailable' }
          : { status: 'available', view: rawDepthTarget.view },
    };
    const mediumPasses = addSingleLayerMediumPasses({
      graph,
      size: internalSize,
      ...medium.value.nearestTargets,
      color: sceneForLater,
      ...(msaa ? { colorResolve: sceneResolvedForLater } : {}),
      depth: depth.value,
      ...receiver,
      extraAccesses: [
        ...receiver.extraAccesses,
        ...(targetCaptures?.value === undefined
          ? []
          : [{ resource: targetCaptures.value, usage: 'sampled-read' as const }]),
      ],
      surfacePair,
      ...(gpuDriven.value === undefined ? {} : { gpuDriven: gpuDriven.value }),
    });
    if (!mediumPasses.ok) return mediumPasses;
  }
  if (backdropActive) {
    if (transmissionActive) {
      const transmissionPass = addTypedScenePass(graph, {
        environment: atmosphere.value,
        name: 'transmission-forward',
        color: sceneForLater,
        depth: depth.value,
        ...(msaa ? { resolve: sceneResolvedForLater } : {}),
        ...receiver,
        selector: FORWARD_PASS_SELECTOR,
        colorLoadOp: 'load',
        depthLoadOp: 'load',
        recordMode: 'transmission',
        // Inject the complete backdrop view so the Standard shader can select
        // the producer's optional roughness mip level. mipViews[0] is only the
        // copy destination view and intentionally exposes one level.
        transmissionBackdrop: transmission.value.backdrop?.view,
      });
      if (!transmissionPass.ok) return transmissionPass;
    }
  }
  const transparentPass = addStandardTransparentPasses(graph, {
    color: sceneForLater,
    ...(msaa ? { resolve: sceneResolvedForLater } : {}),
    depth: depth.value,
    size: internalSize,
    transparency: topology.transparency,
    template: {
      environment: atmosphere.value,
      ...receiver,
    },
  });
  if (!transparentPass.ok) return transparentPass;
  if (backdropActive) {
    const temporal = addTransmissionBackdropTemporalPass(graph, sceneResolvedForLater);
    if (!temporal.ok) return temporal;
  }

  // The local froxel volume composites after every translucent writer (see
  // addTranslucencyVolumetricFogPasses).
  const volume = addTranslucencyVolumetricFogPasses(graph, {
    topology,
    color: sceneResolvedForLater,
    depth: depth.value,
    directionalShadow: shadows.value.directional?.view,
    spotShadow: shadows.value.spot.view,
    clusterBuffers: clusterBuffers.value,
    cloudShadow: cloudShadow.value?.view,
  });
  if (!volume.ok) return volume;

  // Project the remaining generic post features after every scene producer has
  // finished. The forward lane may have replaced the scene target with the
  // cloud-resolved target; keep the MSAA resolve target paired with that final
  // color target so feature attachments observe the same surface that the
  // Standard observation reads.
  const features = contributeStandardSceneFeatures(
    context,
    {
      color: sceneForLater,
      colorResolve: msaa ? sceneResolvedForLater.view : undefined,
      depth: depth.value,
    },
    standardForwardReceiverFeatureAccesses(receiver),
  );
  if (!features.ok) return features;

  if (hdr || linearLdr || rawOnly) {
    const observation = addTypedFrameObservationPass(
      graph,
      sceneResolvedForLater,
      'forgeax::standard',
    );
    if (!observation.ok) return observation;
  }
  if (reflectionFallback.value?.sampleCount === 1) {
    const fallbackObservation = addReflectionFallbackObservationPass(
      graph,
      reflectionFallback.value,
    );
    if (!fallbackObservation.ok) return fallbackObservation;
  }

  const post = addStandardPost(
    context,
    topology,
    sceneResolvedForLater,
    depth.value,
    surface.value,
    temporal.value?.temporal,
    undefined,
    context.targetCoverage?.coverage,
    context.targetCoverage?.depth,
  );
  if (!post.ok) return post;
  return ok(undefined);
}

export const buildStandardForwardLane = buildUrp;
