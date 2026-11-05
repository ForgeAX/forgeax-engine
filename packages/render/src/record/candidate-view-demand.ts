import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { standardBloomAdmitted } from '../bloom-admission';
import { CAMERA_VIEW_DEFAULTS, cameraViewExtent } from '../components/camera-view';
import type { MaterialResource } from '../material-resource';
import { deriveCameraStandardConfiguration } from '../pipeline/camera-standard-profile';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import type { MeshPipelinePreparation } from '../publication/contract';
import type { RenderPublicationReceiver } from '../publication/receiver';
import type { CameraSnapshot } from '../render-contract';
import type { LightRoster, MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { resolveCameraTarget } from '../render-system-extract';
import { sameValue } from '../same-value';
import { MaterialFrame } from '../scene/material-dispatch';
import { resolveViewSsrDependencies } from '../world/reflection-systems';
import { renderLightsOf } from '../world/render-lights';
import { renderProbesOf } from '../world/render-probes';
import {
  displayShortSideLimit,
  RenderView,
  type RenderViewFrameSource,
  RenderViewInput,
  type RenderViewSource,
  resolveViewCamera,
  type ViewCameraState,
} from '../world/render-views';
import { renderWorldFor } from '../world/render-world';
import { admitSsrPipelineDemand, readSsrSceneInputDemand } from '../world/ssr-admission-systems';
import { recordContext } from '../world/view-record-context';
import type { ViewSettlementOwner } from '../world/view-settlement';
import type { GeometryPipelineRequestContext } from './geometry-pipeline-requests';
import { hasSsrSceneInputs } from './main-pass';
import { matchesRecordMode } from './material-pass-selection';
import type { ScenePassSelectionCamera } from './scene-pass-selection';
import {
  gpuDrivenPipelineLane,
  hasShadowPipelineDemand,
  shadowPipelineReflections,
  standardLightingPipelineDemand,
  visibleSurfacePipelineDemand,
} from './view-pipeline-demand';

export type AcceptedViewDemandSource = NonNullable<
  ReturnType<RenderPublicationReceiver['borrowAcceptedDemand']>
>;

export interface CandidateViewDemand {
  readonly selectionCamera: ScenePassSelectionCamera;
  readonly geometry: GeometryPipelineRequestContext;
  readonly worldId: number;
  readonly hasLocalLights: boolean;
  readonly ssao: boolean;
  readonly reflectionFallbackDemand: boolean;
  readonly gpuDrivenGeometryLane: 'automatic' | 'direct' | undefined;
  readonly shadowReflections: ReadonlySet<boolean>;
  readonly hasShadowViews: boolean;
  readonly tonemapActive: boolean;
  readonly probeBlend: boolean;
  /** Only validates this synchronous borrow. A lease must call the reader again. */
  sourceCurrent(): boolean;
}

export interface CandidateViewDemandInput {
  readonly world?: World;
  readonly materials: MaterialFrame;
  readonly preparation: MeshPipelinePreparation;
  readonly view?: EntityHandle;
}

function candidateSceneInput(input: CandidateViewDemandInput, worldId: number) {
  // Novel pass families require the ordinary graph producer. Candidate ids are local to this recipe.
  if (
    input.materials.hasMedium ||
    input.materials.hasUnfoggedOpaque ||
    input.materials.hasFoldableSprites ||
    input.materials.transmissionDemand.activeCount > 0 ||
    input.preparation.template.snapshot.probeBlendRecord !== undefined
  )
    return undefined;
  const resourcesByValue = new Map<MaterialSnapshot, MaterialResource>();
  input.materials.changesSince(new MaterialFrame(undefined), (_before, after) => {
    if (after !== undefined) resourcesByValue.set(after.snapshot, after.resource);
  });
  const resources = new Map<number, MaterialResource>();
  for (const row of input.preparation.materials) {
    const resource = resourcesByValue.get(row.value);
    if (resource === undefined || !matchesRecordMode(row.value, 'opaque')) return undefined;
    resources.set(row.id, resource);
  }
  const resourceFor = (id: number) => {
    const resource = resources.get(id);
    if (resource === undefined) throw new Error('Candidate preparation has no accepted material');
    return resource;
  };
  const { material, materials, materialOverrides, ...snapshot } =
    input.preparation.template.snapshot;
  const source: RenderableSnapshot = {
    ...snapshot,
    material: resourceFor(material),
    materials: materials.map(resourceFor),
    ...(materialOverrides === undefined
      ? {}
      : {
          materialOverrides: materialOverrides.map((id) =>
            id === 0 ? undefined : resourceFor(id),
          ),
        }),
    entityKey: input.preparation.entity,
    worldId,
    transform: input.preparation.transform,
  };
  return {
    renderables: [source],
    materialFrame: input.materials,
    dispatch: input.preparation.template.dispatch.map((pass) => ({
      ...pass,
      entityIndex: input.preparation.entity as EntityHandle,
      renderableIndex: 0,
    })),
  };
}

function viewDeclarationCurrent(
  world: World,
  view: Parameters<typeof resolveViewCamera>[1],
  camera: CameraSnapshot,
  cap: number,
): boolean {
  const declaration = camera.view ?? CAMERA_VIEW_DEFAULTS;
  return (
    view.primary ||
    (sameValue(view.viewport, declaration.viewport) &&
      view.order === declaration.order &&
      view.resolutionScale === declaration.resolutionScale &&
      view.maxRenderShortSide ===
        displayShortSideLimit(declaration.maxRenderShortSide, cap, camera.target) &&
      view.updateInterval === declaration.updateInterval &&
      view.enabled === declaration.enabled &&
      resolveCameraTarget(world, view.target) === camera.target)
  );
}

function acceptedCamera(
  owner: ViewSettlementOwner,
  accepted: AcceptedViewDemandSource,
  entity: EntityHandle,
): CameraSnapshot | undefined {
  const world = renderWorldFor(owner.internals);
  if (!world.hasComponent(entity, RenderView)) return undefined;
  const view = world.get(entity, RenderView).unwrap();
  // Capture work owns independent environment leases and face cameras. It is not a display demand.
  if (!view.enabled || view.capture) return undefined;
  const metadata = accepted.metadata;
  const camera = view.primary
    ? metadata.cameras[0]
    : metadata.cameras.find((item) => item.entityKey === view.camera);
  if (camera === undefined) return undefined;
  if (camera.stereo !== undefined) return undefined;
  const current = world.hasResource(RenderViewInput)
    ? world.getResource<RenderViewFrameSource>(RenderViewInput)
    : undefined;
  if (current === undefined) return undefined;
  const cap = current.maxRenderShortSide;
  if (view.primary && (cap > 0 || camera.view !== undefined)) return undefined;
  if (
    view.camera !== (camera.entityKey ?? 0) ||
    view.viewGeneration !== (camera.historyVersion ?? 0)
  )
    return undefined;
  if (!viewDeclarationCurrent(world, view, camera, cap)) return undefined;
  const context = recordContext(owner.internals);
  const canvas = context.canvas;
  const source: RenderViewSource = {
    cameras: metadata.cameras,
    captures: [],
    primary: view.primary,
    primaryCamera: metadata.cameras[0],
    canvas,
    attachment: () => accepted.resources.identity,
    targetExtent: (target) => context.getRenderTargetPhysical?.(target)?.descriptor,
  };
  const state: ViewCameraState = {
    camera: undefined,
    extent: { width: canvas.width, height: canvas.height },
    viewport: cameraViewExtent(CAMERA_VIEW_DEFAULTS, canvas.width, canvas.height),
  };
  resolveViewCamera(world, view, state, source);
  return state.camera;
}

function readLightingDemand(
  owner: ViewSettlementOwner,
  lights: LightRoster,
  camera: CameraSnapshot,
) {
  const { internals, frameState } = owner;
  const context = recordContext(internals);
  const pipelineState = context.getPipelineState();
  if (pipelineState === null) return undefined;
  const caps = internals.device.caps;
  const lane = {
    storageBuffer: caps.storageBuffer,
    maxColorAttachments: caps.maxColorAttachments,
    maxColorAttachmentBytesPerSample: internals.device.limits.maxColorAttachmentBytesPerSample,
  };
  let configuration = deriveCameraStandardConfiguration(
    internals.standardProfile,
    frameState.standardInstall.configured,
    camera,
    lane,
  );
  if (!configuration.ok)
    configuration = deriveCameraStandardConfiguration(
      internals.standardProfile,
      frameState.standardInstall.configured,
      { screenSpaceReflection: camera.screenSpaceReflection },
      lane,
    );
  if (!configuration.ok) return undefined;
  const renderPath = (configuration.value.profile ?? DEFAULT_STANDARD_PROFILE).renderPath;
  const ssao = configuration.value.config?.ssao?.enabled === true;
  const lighting = standardLightingPipelineDemand(
    true,
    lights,
    ssao,
    caps.storageBuffer,
    pipelineState.pbrPipelineLayout,
  );
  if (
    lighting.lightingKind === 'clustered' &&
    (pipelineState.standardClusterAbi ?? internals.standardClusterAbi) === undefined
  )
    return undefined;
  return { pipelineState, renderPath, ssao, lighting };
}

function readReflectionDemand(
  owner: ViewSettlementOwner,
  accepted: AcceptedViewDemandSource,
  view: EntityHandle,
  camera: CameraSnapshot,
  renderPath: 'forward' | 'deferred',
  candidate: NonNullable<ReturnType<typeof candidateSceneInput>>,
) {
  const { internals, scene } = owner;
  const world = renderWorldFor(internals);
  const caps = internals.device.caps;
  const probes = renderProbesOf(world).roster;
  if (!sameValue(probes.facts, accepted.metadata.reflectionProbes ?? [])) return undefined;
  // A new primitive can select a different local probe; no spatial selection is guessed here.
  if (probes.facts.length > 0) return undefined;
  // This is the normal incremental projection: unchanged rows do no work and no World is scanned.
  scene.projectReflectionProbes(probes);
  const probeDemand = owner.reflectionProbes.pipelineFallbackDemand(
    probes.facts,
    scene.reflectionProbeProjection().selected,
    accepted.metadata.skylight,
  );
  const dependencies = resolveViewSsrDependencies(
    owner,
    camera.screenSpaceReflection !== undefined,
  );
  const requested =
    probeDemand ||
    (dependencies.requested && dependencies.reflectionFallback !== undefined) ||
    camera.screenSpaceReflection !== undefined;
  const sceneInputs = readSsrSceneInputDemand(
    world,
    view,
    camera,
    renderPath,
    accepted.resources,
    requested,
  );
  if (sceneInputs === undefined) return undefined;
  // Use the normal classifier on the actual candidate recipe, including its selected passes.
  // A newly visible receiver (or an incompatible receiver) cannot borrow the scene's old result.
  if (requested && hasSsrSceneInputs(candidate, renderPath) !== sceneInputs) return undefined;
  return admitSsrPipelineDemand(
    {
      camera,
      dependencies,
      probeFallbackDemand: probeDemand,
      capabilities: caps,
      sampledTextureLimit: internals.device.limits.maxSampledTexturesPerShaderStage,
    },
    renderPath,
    sceneInputs,
  );
}

function currentAcceptedScene(owner: ViewSettlementOwner, accepted: AcceptedViewDemandSource) {
  const retained = owner.scene.compositionRetainedScene();
  if (retained === undefined || !retained.isSourceCurrent()) return undefined;
  const worldId = retained.worlds.indexOf(accepted.resources);
  if (worldId < 0) return undefined;
  const lights = renderLightsOf(renderWorldFor(owner.internals)).borrowAdoptedRoster(
    accepted.metadata.lights,
  );
  return lights === undefined ? undefined : { worldId, lights };
}

/** Derive actual demand from the accepted source and its already-adopted persistent products. */
export function readCandidateViewDemand(
  owner: ViewSettlementOwner,
  accepted: AcceptedViewDemandSource,
  input: CandidateViewDemandInput,
): CandidateViewDemand | undefined {
  if (!accepted.isCurrent() || input.world !== undefined || input.view === undefined)
    return undefined;
  const { internals, frameState, scene } = owner;
  const world = renderWorldFor(internals);
  const adopted = currentAcceptedScene(owner, accepted);
  if (adopted === undefined) return undefined;
  const { worldId, lights } = adopted;
  const candidate = candidateSceneInput(input, worldId);
  if (candidate === undefined) return undefined;
  const camera = acceptedCamera(owner, accepted, input.view);
  if (camera === undefined) return undefined;
  const fitted = renderLightsOf(world).borrowFittedViewLights(
    accepted.metadata.lights,
    input.view,
    camera,
  );
  if (fitted === undefined) return undefined;
  const lightingDemand = readLightingDemand(owner, lights, camera);
  if (lightingDemand === undefined) return undefined;
  const { pipelineState, renderPath, ssao, lighting } = lightingDemand;
  const ssr = readReflectionDemand(owner, accepted, input.view, camera, renderPath, candidate);
  if (ssr === undefined) return undefined;
  const context = recordContext(internals);
  const source = world.hasResource(RenderViewInput)
    ? world.getResource<RenderViewFrameSource>(RenderViewInput)
    : undefined;
  if (source === undefined) return undefined;
  const gpuLane = gpuDrivenPipelineLane(renderPath, ssr.reflectionFallbackCandidate);
  const gpuScene = scene.compositionGpuDrivenState();
  const visibleSurface = visibleSurfacePipelineDemand(internals.standardProfile);
  if (visibleSurface && gpuScene === undefined) return undefined;
  const directionalViews = fitted.cascades?.lightViewProj?.length ?? 0;
  const shadows = shadowPipelineReflections(lights, directionalViews);
  const probeReceipt = owner.reflectionProbes.pipelineFallbackReceipt();
  const pipelineHandle = frameState.installedPipelineHandle;
  const generation = context.deviceScope.generation;
  const view = input.view;
  const sourceCurrent = () => {
    if (
      !accepted.isCurrent() ||
      context.getPipelineState() !== pipelineState ||
      frameState.installedPipelineHandle !== pipelineHandle ||
      context.deviceScope.generation !== generation ||
      renderLightsOf(world).borrowAdoptedRoster(accepted.metadata.lights) !== lights ||
      renderLightsOf(world).borrowFittedViewLights(accepted.metadata.lights, view, camera) !==
        fitted ||
      !sameValue(acceptedCamera(owner, accepted, view), camera) ||
      owner.reflectionProbes.pipelineFallbackReceipt() !== probeReceipt
    )
      return false;
    const current = scene.compositionRetainedScene();
    return current?.worlds.includes(accepted.resources) === true && current.isSourceCurrent();
  };
  if (!sourceCurrent()) return undefined;
  return {
    geometry: {
      runtime: internals,
      pipelineState,
      lightingKind: lighting.lightingKind,
      clipping: camera.clipping,
      visibleSurface,
      capturedAtmosphere: false,
      // The exact installed graph preparation supplies its attachment format and blend policy.
      reflectionFallbackColorFormat: undefined,
      translucentFog: false,
      splitLdrSprite: false,
      transparentColorFormat: undefined,
      warnedNineSliceScaleEntities: frameState.warnedNineSliceScaleEntities,
    },
    selectionCamera: camera,
    worldId,
    hasLocalLights: lighting.hasLocalLights,
    ssao,
    reflectionFallbackDemand: ssr.reflectionFallbackDemand,
    gpuDrivenGeometryLane: gpuLane ? (source.opts.geometryLane ?? 'automatic') : undefined,
    shadowReflections: shadows,
    hasShadowViews: hasShadowPipelineDemand(lights, directionalViews),
    tonemapActive: camera.tonemap !== 'none' || standardBloomAdmitted(camera),
    probeBlend: (gpuScene?.probeBlend?.records.length ?? 0) > 0,
    sourceCurrent,
  };
}
