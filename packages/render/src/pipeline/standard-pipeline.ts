import {
  type GraphTextureDescriptor,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/feature';
import { ProjectedDecalInvalidError } from '../decals/component';
import { addProjectedDecalPasses } from '../decals/graph';
import { addDepthPyramidPasses, type DepthPyramidProjection } from '../depth-pyramid/graph';
import { addAtmosphereBackground } from '../environment/background';
import { StandardProfileInvalidError } from '../errors/render';
import type {
  RenderPipeline,
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineSurfaceMediumPair,
  RenderPipelineTopology,
} from '../render-pipeline';
import {
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipelineTarget,
} from '../render-pipeline';
import { getSsaoParameters } from '../ssao-config';
import { addSsrCompositionPass } from '../ssr/compose';
import { addSsrSpatialPasses } from '../ssr/graph';
import {
  DEFERRED_ATTACHMENT_BYTES,
  DEFERRED_COLOR_FORMATS,
  STANDARD_VISIBLE_SURFACE_FORMAT,
  SUBSURFACE_ATTACHMENT_BYTES,
  SUBSURFACE_DEFERRED_COLOR_FORMATS,
} from '../standard-attachments';
import { addSubsurfaceDiffusion } from '../subsurface/graph';
import { DEFERRED_PASS_SELECTOR, FORWARD_PASS_SELECTOR } from '../systems/pass-selector';
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
  addObservationCapturePass,
  addReflectionFallbackObservationPass,
  addTypedFrameObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  addTypedSsaoPasses,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses } from '../typed-shadow-passes';
import { addOpaqueFogPasses, addTranslucencyVolumetricFogPasses } from './analytic-fog-pass';
import { addGpuLateOcclusion, sceneViewImport } from './gpu-occlusion';
import { renderExtentSize } from './render-extent';
import {
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
import { addStandardDeferredLighting } from './standard-deferred-lighting';
import { buildStandardForwardLane } from './standard-forward-lane';
import {
  standardForwardReceiverFeatureAccesses,
  standardForwardReceiverInputs,
} from './standard-forward-receiver';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  standardClusterReadAccesses,
} from './standard-lighting/graph';
import {
  deriveStandardTopologyInput,
  type StandardTopologyInputValue,
} from './standard-lighting/topology';
import { addStandardPost, contributeStandardSceneFeatures } from './standard-post';
import {
  DEFAULT_STANDARD_PROFILE,
  STANDARD_LIGHT_COUNTS,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from './standard-profile';
import { addStandardTransparentPasses } from './standard-transparency';

/** WGSL owner for the Standard clustered membership producer. */
export const STANDARD_CLUSTER_MEMBERSHIP_WGSL = /* wgsl */ `
struct ClusterUniform {
  grid : vec4<u32>,
  near_far_log : vec4<f32>,
};

@group(0) @binding(0) var<storage, read> cluster_grid : array<u32>;
@group(0) @binding(1) var<storage, read_write> light_index_list : array<u32>;
@group(0) @binding(2) var<uniform> cluster_uniform : ClusterUniform;
@group(0) @binding(3) var<storage, read> light_bounds : array<i32>;

@compute @workgroup_size(64)
fn cs_cluster_membership(@builtin(global_invocation_id) global_id : vec3<u32>) {
  let cluster_index = global_id.x;
  let grid_x = cluster_uniform.grid.x;
  let grid_y = cluster_uniform.grid.y;
  let grid_z = cluster_uniform.grid.z;
  let cluster_count = grid_x * grid_y * grid_z;
  if (cluster_index >= cluster_count) {
    return;
  }

  let cluster_x = cluster_index % grid_x;
  let cluster_yz = cluster_index / grid_x;
  let cluster_y = cluster_yz % grid_y;
  let cluster_z = cluster_yz / grid_y;
  let grid_offset = cluster_index * 2u;
  let output_offset = cluster_grid[grid_offset];
  let output_count = cluster_grid[grid_offset + 1u];
  let cluster_x_i = i32(cluster_x);
  let cluster_y_i = i32(cluster_y);
  let cluster_z_i = i32(cluster_z);
  var output_index = output_offset;

  var light_index = 0u;
  loop {
    if (light_index >= cluster_uniform.grid.w || light_index >= 256u) {
      break;
    }
    let bounds_offset = light_index * 6u;
    let min_x = light_bounds[bounds_offset];
    if (min_x >= 0) {
      let min_y = light_bounds[bounds_offset + 1u];
      let min_z = light_bounds[bounds_offset + 2u];
      let max_x = light_bounds[bounds_offset + 3u];
      let max_y = light_bounds[bounds_offset + 4u];
      let max_z = light_bounds[bounds_offset + 5u];
      if (
        cluster_x_i >= min_x && cluster_x_i <= max_x &&
        cluster_y_i >= min_y && cluster_y_i <= max_y &&
        cluster_z_i >= min_z && cluster_z_i <= max_z
      ) {
        if (output_index < output_offset + output_count) {
          light_index_list[output_index] = light_index;
          output_index += 1u;
        }
      }
    }
    light_index += 1u;
  }
}
`;
export function validateClusterGrid(grid: {
  x: number;
  y: number;
  z: number;
}): Result<{ x: number; y: number; z: number }, StandardProfileInvalidError> {
  const { x, y, z } = grid;
  return Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(z) &&
    x >= 1 &&
    x <= 64 &&
    y >= 1 &&
    y <= 64 &&
    z >= 1 &&
    z <= 64
    ? ok({ x, y, z })
    : err(
        new StandardProfileInvalidError(
          `clusterGrid {x:${x}, y:${y}, z:${z}} is invalid; set x, y, and z to positive integers in [1, 64]`,
          { field: 'clusterGrid', actual: { x, y, z } },
        ),
      );
}

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

function buildStandardDeferredLane(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
  reuseAdjacentShadow = false,
): ReturnType<RenderPipeline['build']> {
  const visibleSurfaceEnabled = topology.standardProfile?.visibleSurface === true;
  const formats =
    topology.subsurface === undefined ? DEFERRED_COLOR_FORMATS : SUBSURFACE_DEFERRED_COLOR_FORMATS;
  const attachmentBytes =
    topology.subsurface === undefined ? DEFERRED_ATTACHMENT_BYTES : SUBSURFACE_ATTACHMENT_BYTES;
  const requiredSurfaceBytes = visibleSurfaceEnabled
    ? attachmentBytes.visibleSurface
    : attachmentBytes.surface;
  if (
    visibleSurfaceEnabled &&
    (topology.lane.primitiveIndex !== true ||
      topology.lane.maxColorAttachments < 7 ||
      (topology.lane.maxColorAttachmentBytesPerSample ?? 0) <
        DEFERRED_ATTACHMENT_BYTES.visibleSurface ||
      topology.camera.antialias === 'msaa')
  ) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected:
          'visible surfaces require primitive-index, seven targets, 48 aligned attachment bytes and single sampling',
        hint: 'request these device features/limits before enabling visibleSurface',
        detail: {
          resourceLabel: 'visible-surface',
          field: 'capabilities',
          expected: 'primitive-index / 7 targets / 48 bytes / single sample',
          actual: JSON.stringify(topology.lane),
        },
      }),
    );
  }
  if (
    !topology.lane.storageBuffer ||
    topology.lane.maxColorAttachments < DEFERRED_COLOR_FORMATS.length
  ) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'Standard deferred requires storage buffers and six color attachments',
        hint: 'select a device with deferred capabilities or explicitly select the Forward profile',
        detail: {
          resourceLabel: 'forgeax::standard',
          field: 'renderPath',
          expected: 'storage buffers and six MRTs',
          actual: `storageBuffer=${topology.lane.storageBuffer}, maxColorAttachments=${topology.lane.maxColorAttachments}`,
        },
      }),
    );
  }
  if (
    topology.subsurface !== undefined &&
    (topology.lane.maxColorAttachmentBytesPerSample ?? 32) < requiredSurfaceBytes
  ) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'subsurface Deferred attachments fit the device byte limit',
        hint: `request at least ${requiredSurfaceBytes} bytes/sample before enabling subsurface`,
        detail: {
          resourceLabel: 'subsurface-profile',
          field: 'capabilities',
          expected: `${requiredSurfaceBytes} bytes/sample`,
          actual: String(topology.lane.maxColorAttachmentBytesPerSample),
        },
      }),
    );
  }
  const graph = context.graph;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;
  const internalSize =
    topology.extent === undefined ? 'surface' : renderExtentSize(topology.extent, 'internal');
  const internalCopySize =
    topology.extent === undefined
      ? { width: topology.surface.width, height: topology.surface.height }
      : renderExtentSize(topology.extent, 'internal');
  const buffers = importStandardClusterBuffers(graph, lighting);
  if (!buffers.ok) return buffers;
  const membership =
    buffers.value === null
      ? ok(undefined)
      : addStandardClusterMembershipPass(graph, lighting, buffers.value);
  if (!membership.ok) return membership;
  const addShadows = (cameraPyramid: GraphTextureView | undefined) => {
    const featureShadows = context.contributeShadowFeatures?.();
    if (featureShadows !== undefined && !featureShadows.ok) return featureShadows;
    return addTypedShadowPasses(
      graph,
      topology,
      context.projectGpuDrivenShadow,
      featureShadows?.value,
      cameraPyramid,
      context.gpuDrivenStaticShadowLayers,
      reuseAdjacentShadow,
    );
  };
  // The atmosphere samples the directional map along open view rays before
  // geometry, so its receivers are not the camera's surfaces and the camera
  // pyramid cannot cull their casters.
  const earlyShadows = topology.atmosphere === true ? addShadows(undefined) : undefined;
  if (earlyShadows !== undefined && !earlyShadows.ok) return earlyShadows;

  const depth = target(graph, 'hdrp-depth', {
    format: 'depth32float-stencil8',
    size: internalSize,
  });
  if (!depth.ok) return depth;
  const depthSample = graph.view(depth.value.texture, {
    label: 'ssr-scene-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depthSample.ok) return depthSample;
  const normalRoughness = target(graph, 'gbuffer-normal-roughness', {
    format: DEFERRED_COLOR_FORMATS[1],
    size: internalSize,
  });
  if (!normalRoughness.ok) return normalRoughness;
  const albedoMetallic = target(graph, 'gbuffer-albedo-metallic', {
    format: DEFERRED_COLOR_FORMATS[3],
    size: internalSize,
  });
  if (!albedoMetallic.ok) return albedoMetallic;
  const f0Occlusion = target(graph, 'gbuffer-f0-occlusion', {
    format: DEFERRED_COLOR_FORMATS[2],
    size: internalSize,
  });
  if (!f0Occlusion.ok) return f0Occlusion;
  const lightingContext = target(graph, 'gbuffer-lighting-context', {
    format: formats[4],
    size: internalSize,
  });
  if (!lightingContext.ok) return lightingContext;
  const receiverGeometry = target(graph, 'gbuffer-receiver-geometry', {
    format: DEFERRED_COLOR_FORMATS[5],
    size: internalSize,
  });
  if (!receiverGeometry.ok) return receiverGeometry;
  const visibleSurface = visibleSurfaceEnabled
    ? target(graph, 'visible-surface', {
        format: STANDARD_VISIBLE_SURFACE_FORMAT,
        size: internalSize,
      })
    : ok(undefined);
  if (!visibleSurface.ok) return visibleSurface;
  const scene = target(graph, 'hdrp-scene-color', {
    format: formats[0],
    size: internalSize,
  });
  if (!scene.ok) return scene;
  const mediumTargets =
    topology.singleLayerMedium === true
      ? (() => {
          const nearestLayer = target(graph, 'single-layer-medium-nearest-layer', {
            format: scene.value.format,
            size: internalSize,
            // The color pass samples this target with a `texture_2d`; keep
            // it single-sample even when a future deferred path is MSAA.
            sampleCount: 1,
            domain: 'linear-ldr',
          });
          if (!nearestLayer.ok) return nearestLayer;
          const nearestDepth = target(graph, 'single-layer-medium-nearest-depth', {
            format: 'depth32float-stencil8',
            size: internalSize,
            sampleCount: 1,
          });
          if (!nearestDepth.ok) return nearestDepth;
          return ok({ nearestLayer: nearestLayer.value, nearestDepth: nearestDepth.value });
        })()
      : ok(undefined);
  if (!mediumTargets.ok) return mediumTargets;
  const reflectionFallback =
    topology.reflectionFallback?.enabled === true ||
    topology.ssr?.status === 'admitted' ||
    (topology.standardProfile?.diffuseGi?.gather !== 'baked' &&
      topology.standardProfile?.diffuseGi?.reflections !== undefined)
      ? target(graph, 'reflection-fallback-linear-hdr', {
          format: 'rgba16float',
          size: internalSize,
          domain: 'linear-hdr',
        })
      : ok(undefined);
  if (!reflectionFallback.ok) return reflectionFallback;
  const specularResponse =
    reflectionFallback.value === undefined
      ? ok(undefined)
      : target(graph, 'deferred-specular-response', {
          format: 'rgba16float',
          size: internalSize,
        });
  if (!specularResponse.ok) return specularResponse;
  const temporalDemand = aggregateTemporalDemand({
    taa: topology.camera.antialias === 'taa',
    motionBlur: topology.temporal?.motionBlur === true,
    ssr: topology.ssr?.status === 'admitted',
    visibleSurface: visibleSurfaceEnabled,
  });
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
  // The same fragments can publish temporal-v1 beside the material facts.
  // Keep the standalone producer on devices that cannot hold this MRT shape.
  const deferredTemporal =
    temporal.value !== undefined &&
    topology.lane.maxColorAttachments >= 7 + Number(visibleSurfaceEnabled) &&
    (topology.lane.maxColorAttachmentBytesPerSample ?? 0) >=
      (visibleSurfaceEnabled ? attachmentBytes.visibleSurfaceTemporal : attachmentBytes.temporal);
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
  const featureRasterWork =
    context.hasFeatureRasterWork?.(CLOUD_LAYER_FEATURE_IDENTITY, 'scene') === true;
  const cloudScene = createStandardCloudSceneTarget(context, featureRasterWork, {
    format: scene.value.format,
    size: internalSize,
    domain: 'linear-hdr',
  });
  if (!cloudScene.ok) return cloudScene;
  const cloudShadow = createStandardCloudShadowTarget(context, featureRasterWork);
  if (!cloudShadow.ok) return cloudShadow;
  // Cloud density and its spatial shadow must be produced before the opaque
  // receiver pass. The composite is projected separately below, after the
  // receiver has populated the scene target; declaration order is execution
  // order for the typed graph.
  const featureTargets = contributeStandardCloudPreOpaque(context, {
    color: scene.value,
    depth: depth.value,
    cloudShadow: cloudShadow.value,
  });
  if (!featureTargets.ok) return featureTargets;

  // Background must precede geometry now that geometry initializes SceneColor.
  const atmosphere =
    topology.atmosphere === true
      ? addAtmosphereBackground(graph, scene.value, {
          directional: earlyShadows?.value.directional?.view,
          cloud: cloudShadow.value?.view,
        })
      : ok(undefined);
  if (!atmosphere.ok) return atmosphere;
  if (atmosphere.value === undefined) {
    const skybox = addTypedSkyboxPass(graph, scene.value);
    if (!skybox.ok) return skybox;
  }

  const gbuffer = addTypedScenePass(graph, {
    name: 'g-buffer',
    color: scene.value,
    colorTargets: [
      scene.value,
      normalRoughness.value,
      f0Occlusion.value,
      albedoMetallic.value,
      lightingContext.value,
      receiverGeometry.value,
      ...(visibleSurface.value === undefined ? [] : [visibleSurface.value]),
      ...(deferredTemporal && temporal.value !== undefined ? [temporal.value.temporal] : []),
    ],
    colorLoadOp: [
      'load',
      'clear',
      'clear',
      'clear',
      'clear',
      'clear',
      ...(visibleSurfaceEnabled ? ['clear' as const] : []),
      ...(deferredTemporal ? ['clear' as const] : []),
    ],
    colorClearValues: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      ...(visibleSurfaceEnabled ? [[0, 0, 0, 0] as const] : []),
      ...(deferredTemporal ? [[0, 0, -1, 1] as const] : []),
    ],
    gpuDrivenFilter: 'deferred-opaque',
    ...(gpuDriven.value === undefined ? {} : { gpuDriven: gpuDriven.value }),
    depth: depth.value,
    selector: DEFERRED_PASS_SELECTOR,
    // The G-buffer only admits opaque Standard materials. Medium Surface
    // programs have no Deferred entry and acquire raw depth in their later
    // paired color pass; filtering here also avoids assembling their bind
    // groups before that producer exists.
    recordMode: 'opaque',
    passKind: 'deferred',
    clearColor: [0, 0, 0, 0],
  });
  if (!gbuffer.ok) return gbuffer;
  const importSceneView = sceneViewImport(graph);
  // One closest-depth pyramid per view, built only when SSR or a diffuse GI
  // gather actually reads it.
  let closestPyramid: Result<DepthPyramidProjection, RenderGraphError> | undefined;
  const closestDepthPyramid = (): Result<DepthPyramidProjection, RenderGraphError> => {
    if (closestPyramid !== undefined) return closestPyramid;
    const view = importSceneView();
    if (!view.ok) return view;
    closestPyramid = addDepthPyramidPasses(graph, {
      depth: depthSample.value,
      width: internalCopySize.width,
      height: internalCopySize.height,
      view: view.value,
    });
    return closestPyramid;
  };
  const late = addGpuLateOcclusion(graph, {
    gpuDriven: gpuDriven.value,
    depth: depthSample.value,
    multisampled: depth.value.sampleCount > 1,
    width: internalCopySize.width,
    height: internalCopySize.height,
    view: importSceneView,
  });
  if (!late.ok) return late;
  if (late.value !== undefined && gpuDriven.value !== undefined) {
    const gbufferLate = addTypedScenePass(graph, {
      name: 'g-buffer-late',
      color: scene.value,
      colorTargets: [
        scene.value,
        normalRoughness.value,
        f0Occlusion.value,
        albedoMetallic.value,
        lightingContext.value,
        receiverGeometry.value,
        ...(visibleSurface.value === undefined ? [] : [visibleSurface.value]),
        ...(deferredTemporal && temporal.value !== undefined ? [temporal.value.temporal] : []),
      ],
      colorLoadOp: [
        'load',
        'load',
        'load',
        'load',
        'load',
        'load',
        ...(visibleSurfaceEnabled ? ['load' as const] : []),
        ...(deferredTemporal ? ['load' as const] : []),
      ],
      depthLoadOp: 'load',
      gpuDriven: gpuDriven.value,
      gpuDrivenFilter: 'deferred-opaque',
      gpuDrivenPhase: 'late',
      depth: depth.value,
      selector: DEFERRED_PASS_SELECTOR,
      recordMode: 'opaque',
      passKind: 'deferred',
    });
    if (!gbufferLate.ok) return gbufferLate;
  }
  // Shadows follow the late pyramid so their caster cull can test it; the
  // lighting pass is their first consumer either way.
  const shadows = earlyShadows ?? addShadows(late.value);
  if (!shadows.ok) return shadows;
  if (visibleSurface.value !== undefined) {
    const capture = addObservationCapturePass(graph, visibleSurface.value, 'visible-surface');
    if (!capture.ok) return capture;
  }
  const decals = addProjectedDecalPasses(graph, topology.projectedDecals ?? [], {
    depth: depthSample.value,
    normal: normalRoughness.value,
    albedo: albedoMetallic.value,
    f0: f0Occlusion.value,
    size: internalSize,
  });
  if (!decals.ok) return decals;
  if (context.contributeProbePlacement !== undefined && visibleSurface.value !== undefined) {
    const placed = context.contributeProbePlacement({
      depth: depthSample.value,
      normal: decals.value.normal,
      identity: visibleSurface.value,
    });
    if (!placed.ok) return placed;
  }

  let ssao: RenderPipelineTarget | undefined;
  if (topology.config?.ssao?.enabled === true) {
    const { resolutionScale } = getSsaoParameters(topology.config.ssao);
    const size = {
      width: Math.max(1, Math.round(internalCopySize.width * resolutionScale)),
      height: Math.max(1, Math.round(internalCopySize.height * resolutionScale)),
    };
    const raw = target(graph, 'ssao-raw', { format: 'rgba8unorm', size });
    if (!raw.ok) return raw;
    const blurred = target(graph, 'ssao-blurred', { format: 'r8unorm', size });
    if (!blurred.ok) return blurred;
    const passes = addTypedSsaoPasses(graph, {
      normal: decals.value.normal,
      depth: depth.value,
      raw: raw.value,
      blurred: blurred.value,
    });
    if (!passes.ok) return passes;
    ssao = blurred.value;
  }

  const targetCaptures = context.contributeCubeCaptures?.(atmosphere.value);
  if (targetCaptures !== undefined && !targetCaptures.ok) return targetCaptures;
  const subsurfaceDiffuse =
    topology.subsurface === undefined
      ? ok(undefined)
      : target(graph, 'subsurface-diffuse', { format: 'rgba16float', size: internalSize });
  if (!subsurfaceDiffuse.ok) return subsurfaceDiffuse;
  const lightingPass = addStandardDeferredLighting(graph, {
    color: scene.value,
    ...(subsurfaceDiffuse.value === undefined ? {} : { diffuse: subsurfaceDiffuse.value }),
    gbuffer: [decals.value.normal, decals.value.albedo, decals.value.f0, lightingContext.value],
    receiverGeometry: receiverGeometry.value,
    depth: depthSample.value,
    ...(reflectionFallback.value === undefined
      ? {}
      : { reflectionFallback: reflectionFallback.value }),
    ...(specularResponse.value === undefined ? {} : { response: specularResponse.value }),
    ...(ssao === undefined ? {} : { ssao }),
    ...(atmosphere.value === undefined ? {} : { environment: atmosphere.value }),
    ...(shadows.value.directional === undefined
      ? {}
      : { directionalShadow: shadows.value.directional }),
    spotShadow: shadows.value.spot,
    ...(cloudShadow.value === undefined ? {} : { cloudShadow: cloudShadow.value }),
    ...(shadows.value.point === undefined ? {} : { pointShadow: shadows.value.point }),
    cluster: buffers.value,
    extraAccesses: buffers.value === null ? [] : standardClusterReadAccesses(buffers.value),
    size: internalCopySize,
  });
  if (!lightingPass.ok) return lightingPass;
  if (subsurfaceDiffuse.value !== undefined && topology.subsurface !== undefined) {
    const diffusion = addSubsurfaceDiffusion(graph, {
      scene: scene.value,
      diffuse: subsurfaceDiffuse.value,
      profiles: lightingContext.value.view,
      normal: decals.value.normal.view,
      depth: depthSample.value,
      size: internalCopySize,
      scale: [
        internalCopySize.width / (topology.extent?.outputWidth ?? topology.surface.width),
        internalCopySize.height / (topology.extent?.outputHeight ?? topology.surface.height),
      ],
      quality: topology.subsurface.quality,
    });
    if (!diffusion.ok) return diffusion;
  }

  // SSR consumes the same Standard temporal-v1 producer as TAA and motion
  // blur. Insert it before the spatial chain so the graph dependency order is
  // explicit and one producer serves every temporal consumer.
  if (temporal.value !== undefined) {
    const producer = addStandardSceneDataPass(
      graph,
      temporal.value.temporal,
      depth.value,
      gpuDriven.value,
      deferredTemporal ? 'forward-only-opaque' : 'opaque',
    );
    if (!producer.ok) return producer;
  }
  if (
    context.contributeDiffuseGi !== undefined &&
    visibleSurface.value !== undefined &&
    temporal.value !== undefined
  ) {
    const diffuse = context.contributeDiffuseGi({
      scene: scene.value,
      depth: depthSample.value,
      normal: decals.value.normal,
      albedo: decals.value.albedo,
      f0: decals.value.f0,
      identity: visibleSurface.value,
      motion: temporal.value.temporal,
      depthPyramid: () => {
        const pyramid = closestDepthPyramid();
        return pyramid.ok ? ok(pyramid.value.pyramid.pyramid) : pyramid;
      },
      ...(reflectionFallback.value === undefined || specularResponse.value === undefined
        ? {}
        : {
            reflection: { fallback: reflectionFallback.value, response: specularResponse.value },
          }),
    });
    if (!diffuse.ok) return diffuse;
  }

  if (context.targetCoverage !== undefined) {
    const coverage = addTargetCoveragePass(graph, context.targetCoverage, gpuDriven.value);
    if (!coverage.ok) return coverage;
  }

  let sceneOutput: RenderPipelineTarget = scene.value;
  let secondaryReactivity: GraphTextureView | undefined;
  if (topology.ssr !== undefined) {
    const ssrView = topology.ssr.status === 'admitted' ? importSceneView() : ok(undefined);
    if (!ssrView.ok) return ssrView;
    const depthPyramid = topology.ssr.status === 'admitted' ? closestDepthPyramid() : ok(undefined);
    if (!depthPyramid.ok) return depthPyramid;
    const spatial = addSsrSpatialPasses(graph, {
      admission: topology.ssr,
      width: internalCopySize.width,
      height: internalCopySize.height,
      depth: depthSample.value,
      normal: decals.value.normal.view,
      scene: scene.value.view,
      ...(temporal.value === undefined ? {} : { currentTemporal: temporal.value.temporal.view }),
      ...(reflectionFallback.value === undefined
        ? {}
        : { fallback: reflectionFallback.value.view }),
      ...(temporal.value === undefined || context.ssrHistory === undefined
        ? {}
        : {
            temporal: {
              previousHistory: context.ssrHistory.previous.view,
              outputHistory: context.ssrHistory.output.view,
              previousSurface: context.ssrHistory.previousSurface.view,
              outputSurface: context.ssrHistory.outputSurface.view,
              params: context.ssrHistory.params,
            },
          }),
      ...(ssrView.value === undefined ? {} : { view: ssrView.value }),
      ...(depthPyramid.value === undefined ? {} : { depthPyramid: depthPyramid.value.pyramid }),
    });
    if (!spatial.ok) return spatial;
    if (
      spatial.value.resources !== undefined &&
      reflectionFallback.value !== undefined &&
      ssrView.value !== undefined &&
      specularResponse.value !== undefined
    ) {
      secondaryReactivity = spatial.value.reactivity;
      const radiance =
        spatial.value.resources.radiancePyramid ?? spatial.value.resources.trace.view;
      const composed = addSsrCompositionPass(graph, {
        scene: scene.value,
        radiance,
        fallback: reflectionFallback.value.view,
        response: specularResponse.value.view,
        normal: decals.value.normal.view,
        view: ssrView.value,
      });
      if (!composed.ok) return composed;
    }
  }

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
  const receiver = standardForwardReceiverInputs({
    shadows: shadows.value,
    cloudShadow: cloudShadow.value,
    ssao,
    clusterReads: buffers.value === null ? [] : standardClusterReadAccesses(buffers.value),
  });

  const forward = addTypedScenePass(graph, {
    environment: atmosphere.value,
    name: 'forward',
    color: sceneOutput,
    depth: depth.value,
    selector: FORWARD_PASS_SELECTOR,
    colorLoadOp: 'load',
    depthLoadOp: 'load',
    ...receiver,
    ...(gpuDriven.value === undefined ? {} : { gpuDriven: gpuDriven.value }),
    passKind: 'forward',
    excludeSelector: DEFERRED_PASS_SELECTOR,
    // Keep the deferred opaque lane separate from Surface medium passes.
    recordMode: 'opaque' as const,
    gpuDrivenFilter: 'forward-only-opaque',
  });
  if (!forward.ok) return forward;

  // Atmosphere and analytic fog composite onto the opaque scene before
  // transmission copies and translucent draws. Every translucent writer then
  // fogs itself at its own depth, so blending composes depth-correctly.
  const fogged = addOpaqueFogPasses(graph, {
    topology,
    atmosphere: atmosphere.value?.atmosphere,
    color: scene.value,
    depth: depth.value,
  });
  if (!fogged.ok) return fogged;

  if (cloudScene.value !== undefined) {
    const compositeFeatures = contributeStandardCloudComposite(
      context,
      featureTargets.value,
      { input: scene.value, output: cloudScene.value, cloudShadow: cloudShadow.value },
      receiver.extraAccesses,
      atmosphere.value?.atmosphere,
    );
    if (!compositeFeatures.ok) return compositeFeatures;
  }

  if (cloudScene.value !== undefined) sceneOutput = cloudScene.value;

  const transmission = addTransmissionBackdropPasses({
    graph,
    source: sceneOutput,
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
    const rawDepth = addSingleLayerMediumRawDepthProducer({
      graph,
      sourceColor: sceneOutput,
      sourceDepth: depth.value,
      size: internalSize,
    });
    if (!rawDepth.ok) return rawDepth;
    // Standard owns this producer fact. Deferred depth is single-sample, so
    // the independent r32float copy is available to both medium passes.
    const surfacePair: RenderPipelineSurfaceMediumPair = {
      opaqueColor: medium.value.backdrop,
      rawDepth: { status: 'available', view: rawDepth.value.view },
    };
    const mediumPasses = addSingleLayerMediumPasses({
      graph,
      size: internalSize,
      ...medium.value.nearestTargets,
      color: sceneOutput,
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
        color: sceneOutput,
        depth: depth.value,
        selector: FORWARD_PASS_SELECTOR,
        colorLoadOp: 'load',
        depthLoadOp: 'load',
        ...receiver,
        passKind: 'forward',
        recordMode: 'transmission',
        // Inject the complete backdrop view so the Standard shader can select
        // the producer's optional roughness mip level. mipViews[0] is only the
        // copy destination view and intentionally exposes one level.
        transmissionBackdrop: transmission.value.backdrop?.view,
      });
      if (!transmissionPass.ok) return transmissionPass;
    }
    const transparentPass = addStandardTransparentPasses(graph, {
      color: sceneOutput,
      depth: depth.value,
      size: internalSize,
      transparency: topology.transparency,
      template: {
        environment: atmosphere.value,
        ...receiver,
        passKind: 'forward',
      },
    });
    if (!transparentPass.ok) return transparentPass;
  }
  if (backdropActive) {
    const temporal = addTransmissionBackdropTemporalPass(graph, sceneOutput);
    if (!temporal.ok) return temporal;
  }
  if (!transmission.value.topology.active) {
    const transparentPass = addStandardTransparentPasses(graph, {
      color: sceneOutput,
      depth: depth.value,
      size: internalSize,
      transparency: topology.transparency,
      template: {
        environment: atmosphere.value,
        ...receiver,
        passKind: 'forward',
      },
    });
    if (!transparentPass.ok) return transparentPass;
  }

  // The local froxel volume composites after every translucent writer: its
  // per-pixel integral ends at opaque depth, so composited earlier each
  // blended surface behind the medium would cut its shape out of the haze.
  const volume = addTranslucencyVolumetricFogPasses(graph, {
    topology,
    atmosphere: atmosphere.value?.atmosphere,
    color: sceneOutput,
    depth: depth.value,
    directionalShadow: shadows.value.directional?.view,
    spotShadow: shadows.value.spot.view,
    clusterBuffers: buffers.value,
    cloudShadow: cloudShadow.value?.view,
  });
  if (!volume.ok) return volume;

  // Generic post features consume the final deferred scene target after cloud
  // and volume producers. Keep the same clustered, shadow, and SSAO reads that
  // the Standard receiver exposes to feature-owned lighting passes.
  const features = contributeStandardSceneFeatures(
    context,
    { color: sceneOutput, colorResolve: undefined, depth: depth.value },
    standardForwardReceiverFeatureAccesses(receiver),
    atmosphere.value?.atmosphere,
  );
  if (!features.ok) return features;
  const observation = addTypedFrameObservationPass(graph, sceneOutput);
  if (!observation.ok) return observation;
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
    sceneOutput,
    depth.value,
    surface.value,
    temporal.value?.temporal,
    secondaryReactivity,
    context.targetCoverage?.coverage,
    context.targetCoverage?.depth,
  );
  if (!post.ok) return post;
  return ok(undefined);
}
export interface StandardPipeline extends RenderPipeline {
  readonly identity: typeof STANDARD_PIPELINE_ID;
}

function profileFor(topology: RenderPipelineTopology): StandardProfile {
  return topology.standardProfile ?? DEFAULT_STANDARD_PROFILE;
}

function resolveStandardTopologyInput(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
): Result<StandardTopologyInputValue, RenderGraphError> {
  const supplied = context.standardLighting;
  if (supplied !== undefined) {
    const derived = deriveStandardTopologyInput(supplied);
    if (derived.ok) return derived;
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'Forward/Deferred consume one prepared Standard topology input',
        hint: derived.error.hint,
        detail: {
          resourceLabel: 'forgeax::standard',
          field: `standardLighting.${derived.error.detail.field}`,
          expected: derived.error.expected,
          actual: 'invalid',
        },
      }),
    );
  }

  return err(
    new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: 'RenderPipelineBuildContext.standardLighting from frame preparation',
      hint: 'prepare Standard lighting once, select a proven Cluster transport, and pass it to both lanes',
      detail: {
        resourceLabel: 'forgeax::standard',
        field: 'standardLighting',
        expected: 'prepared Standard lighting topology input',
        actual: 'invalid',
      },
    }),
  );
}

function standardTopology(
  topology: RenderPipelineTopology,
  profile: StandardProfile,
): RenderPipelineTopology {
  const config = {
    ...(topology.config ?? {}),
    ssao: {
      ...(topology.config?.ssao ?? {}),
      ...(typeof profile.ssao === 'object' ? profile.ssao : {}),
      enabled: profile.ssao !== false,
    },
  };
  return {
    ...topology,
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: profile,
    config,
  };
}

/**
 * @internal
 * The sole built-in pipeline entry point. All local lights use the same
 * prepared Cluster topology; the profile chooses only Forward or Deferred
 * graph shape and never a second lighting authority.
 */
export function buildStandard(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  reuseAdjacentShadow = false,
): ReturnType<RenderPipeline['build']> {
  const standardContext = context as StandardPipelineBuildContext;
  const profile = profileFor(topology);
  if (!STANDARD_LIGHT_COUNTS.some((count) => count === profile.lightCount)) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'StandardProfile.lightCount is one of 1, 32, or 256',
        hint: 'set StandardProfile.lightCount to 1, 32, or 256',
        detail: {
          resourceLabel: 'forgeax::standard',
          field: 'lightCount',
          expected: '1 | 32 | 256',
          actual: profile.lightCount,
        },
      }),
    );
  }
  if (
    (topology.projectedDecals?.length ?? 0) > 0 &&
    (profile.renderPath !== 'deferred' || topology.camera.antialias === 'msaa')
  )
    throw new ProjectedDecalInvalidError(
      'renderPath',
      'Standard Deferred with single-sample depth',
    );
  const effective = standardTopology(topology, profile);
  const lighting = resolveStandardTopologyInput(context);
  if (!lighting.ok) return lighting;
  // A missing Camera is an intentional clear-only frame. Keep it on the
  // forward raster lane so clustered resources cannot introduce work.
  if (effective.clearOnly === true) {
    return buildStandardForwardLane(
      standardContext,
      effective,
      lighting.value,
      reuseAdjacentShadow,
    );
  }
  return profile.renderPath === 'forward'
    ? buildStandardForwardLane(standardContext, effective, lighting.value, reuseAdjacentShadow)
    : buildStandardDeferredLane(standardContext, effective, lighting.value, reuseAdjacentShadow);
}

export const standardPipeline: StandardPipeline = Object.freeze({
  identity: STANDARD_PIPELINE_ID,
  build: buildStandard,
});

export { DEFAULT_STANDARD_PROFILE, STANDARD_PIPELINE_ID } from './standard-profile';
