import type { Buffer } from '@forgeax/engine-rhi';
import type { VolumetricFogFrameContext } from '../render-contract';
import type { ExtractedVolumetricFog } from '../render-system-extract';
import { inspectVolumetricFog } from '../volume/inspection';
import { inspectVolumetricFogResources } from '../volume/resources';
import type { VolumeTemporalSignature } from '../volume/temporal';
import type { ViewLights } from '../world/render-lights';
import type { RenderFrameState } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';
import type { FrameVolumetricFog } from './view-topology';
import { emptyVolumetricFogParams, promoteVolumetricFogParams } from './volume-params';

/**
 * Volumetric fog state a submitted recording staged. The Render World
 * environment systems promote it in RenderCommit for an accepted scene
 * submission and drop it in RenderCleanup.
 */
export interface StagedVolumetricFog {
  readonly volumetricFog: ExtractedVolumetricFog | undefined;
  readonly volume: FrameVolumetricFog;
  readonly context: VolumetricFogFrameContext | undefined;
  readonly signature: VolumeTemporalSignature | undefined;
  readonly graph: NonNullable<RenderFrameState['volumetricFogHistoryGraph']>;
  /** Present when the attempt prepared fog inspection facts; applied after promotion. */
  readonly inspection:
    | {
        readonly fog: ExtractedVolumetricFog | undefined;
        readonly lights: ViewLights;
        readonly prepared: VolumetricFogFrameContext | undefined;
        readonly capability: boolean;
        readonly attempted: boolean;
      }
    | undefined;
}

/** Promote a submitted fog candidate, then project it into the fog inspection. */
export function commitSubmittedVolumetricFog(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  staged: StagedVolumetricFog,
): void {
  promoteSubmittedVolumetricFog(internals, frameState, staged);
  const { inspection } = staged;
  if (inspection === undefined) return;
  updateVolumetricFogInspection(
    frameState,
    inspection.fog,
    inspection.lights,
    inspection.prepared,
    true,
    inspection.capability,
    inspection.attempted,
  );
}

/** Retire parameter buffers only after the submit that stopped using them. */
export function retireVolumetricFogParams(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): void {
  const buffers = frameState.volumetricFogParams.buffers;
  frameState.volumetricFogParams = emptyVolumetricFogParams();
  const live = buffers.filter((buffer): buffer is Buffer => buffer !== null);
  if (live.length === 0) return;
  const device = internals.device;
  const release = (): void => {
    for (const buffer of live) {
      const destroyed = device.destroyBuffer(buffer);
      if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
    }
  };
  try {
    void device.queue.onSubmittedWorkDone().then(release, release);
  } catch {
    release();
  }
}

/**
 * Temporal history is graph-owned state. Promote the write slot only after
 * queue submission succeeds; a failed candidate keeps the accepted
 * graph/context/slot and retries into the same pending slot.
 */
function promoteVolumetricFogHistory(
  frameState: RenderFrameState,
  volumetricFog: ExtractedVolumetricFog | undefined,
  volume: FrameVolumetricFog,
  context: VolumetricFogFrameContext,
  signature: VolumeTemporalSignature,
  graph: NonNullable<RenderFrameState['volumetricFogHistoryGraph']>,
): void {
  frameState.volumetricFogHistoryGraph = graph;
  frameState.volumetricFogHistorySlot = context.historyWriteSlot;
  frameState.volumetricFogHistorySignature = signature;
  promoteVolumetricFogParams(frameState.volumetricFogParams);
  if (volumetricFog?.status === 'available' && volume.prepared !== undefined) {
    frameState.volumetricFogAccepted = volumetricFog;
    frameState.volumetricFogAcceptedContext = context;
  } else if (volume.acceptedFallback !== undefined) {
    // The current authored source is degraded, so keep the old accepted
    // POD while advancing the LKG graph's ping-pong slot.
    frameState.volumetricFogAcceptedContext = context;
  }
}

export function promoteSubmittedVolumetricFog(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  { volumetricFog, volume, context, signature, graph }: StagedVolumetricFog,
): void {
  if (volume.graphFog === undefined) {
    // A valid offscreen view is an actual no-volume submission, not an
    // upload failure. Retain only the previously accepted source/resources
    // for degraded-authoring LKG; never replay that projection offscreen.
    // Genuine component removal still retires everything normally.
    if (!volume.viewCulled) {
      frameState.volumetricFogAccepted = undefined;
      frameState.volumetricFogAcceptedContext = undefined;
      retireVolumetricFogParams(internals, frameState);
    }
    frameState.volumetricFogHistoryGraph = null;
    frameState.volumetricFogHistorySlot = null;
    frameState.volumetricFogHistorySignature = null;
    return;
  }
  if (context !== undefined && signature !== undefined) {
    promoteVolumetricFogHistory(frameState, volumetricFog, volume, context, signature, graph);
    return;
  }
  if (volumetricFog?.status === 'available' && volume.prepared !== undefined) {
    // Defensive fallback for a volume graph that was accepted before the
    // temporal context could be resolved; do not manufacture history.
    frameState.volumetricFogAccepted = volumetricFog;
    frameState.volumetricFogAcceptedContext = volume.prepared;
  }
}

const VOLUMETRIC_FOG_PASS_COUNT = 4;

function volumetricFogResourceFacts(frameState: RenderFrameState) {
  return frameState.compiledFrameGraph === undefined || frameState.compiledFrameGraph === null
    ? undefined
    : inspectVolumetricFogResources(frameState.compiledFrameGraph.graph.inspect(), {
        parameterBufferCount: frameState.volumetricFogParams.buffers.filter(
          (buffer) => buffer !== null,
        ).length,
      });
}

type VolumeResourceFacts = ReturnType<typeof volumetricFogResourceFacts>;

/** The last accepted volume projection, completed with its inspected resource facts. */
function acceptedVolumetricFogLkg(
  frameState: RenderFrameState,
  fog: ExtractedVolumetricFog | undefined,
  resourceFacts: VolumeResourceFacts,
) {
  const previous = frameState.volumetricFogInspection;
  const accepted = frameState.volumetricFogAccepted;
  if (accepted === undefined) return undefined;
  return {
    guid: accepted.guid ?? previous.guid,
    generation: accepted.generation ?? previous.generation,
    digest: accepted.digest ?? previous.digest,
    deviceEpoch: previous.deviceEpoch,
    format: previous.format ?? accepted.densityAsset?.format ?? fog?.densityAsset?.format,
    passCount: previous.passCount > 0 ? previous.passCount : VOLUMETRIC_FOG_PASS_COUNT,
    sampleCount:
      previous.sampleCount > 0 ? previous.sampleCount : (resourceFacts?.sampleCount ?? 0),
    memoryBytes: previous.memoryBytes > 0 ? previous.memoryBytes : (resourceFacts?.totalBytes ?? 0),
    resourceFacts: previous.resourceFacts ?? resourceFacts,
    lightEntity: accepted.lightEntity,
    lightKind: accepted.lightKind,
    pointLightEntity: accepted.pointLightEntity,
    spotLightEntity: accepted.spotLightEntity,
    projector: accepted.projector,
  };
}

type AcceptedVolumetricFogLkg = NonNullable<ReturnType<typeof acceptedVolumetricFogLkg>>;

function volumeCandidateIdentity(fog: ExtractedVolumetricFog | undefined) {
  return fog?.guid === undefined || fog.generation === undefined
    ? undefined
    : { guid: fog.guid, generation: fog.generation, digest: fog.digest };
}

type VolumeCandidateIdentity = ReturnType<typeof volumeCandidateIdentity>;

function selectedVolumeLightAvailable(fog: ExtractedVolumetricFog, lights: ViewLights): boolean {
  if (fog.lightKind === 'spot')
    return lights.spot.some((light) => light.entity === fog.lightEntity);
  if (fog.lightKind === 'point') {
    return (
      lights.point.some((light) => light.entity === (fog.pointLightEntity ?? fog.lightEntity)) &&
      (fog.spotLightEntity === undefined ||
        lights.spot.some((light) => light.entity === fog.spotLightEntity))
    );
  }
  if (fog.lightKind === 'directional') return lights.directional?.entity === fog.lightEntity;
  return lights.directional !== undefined;
}

function volumeLightingCapability(
  volumeCapability: boolean,
  fog: ExtractedVolumetricFog,
  lights: ViewLights,
): 'available' | 'unavailable' {
  return volumeCapability && selectedVolumeLightAvailable(fog, lights)
    ? 'available'
    : 'unavailable';
}

function candidateRecoveryFields(candidate: VolumeCandidateIdentity) {
  if (candidate === undefined) return {};
  return {
    candidateGeneration: candidate.generation,
    ...(candidate.digest === undefined ? {} : { candidateDigest: candidate.digest }),
  };
}

function acceptedVolumeSelectedLight(lkg: AcceptedVolumetricFogLkg) {
  if (lkg.lightEntity === undefined || lkg.lightKind === undefined) return {};
  return {
    selectedLight: {
      entity: lkg.lightEntity,
      kind: lkg.lightKind,
      revision: 0,
      shadowTile: -1,
      ...(lkg.pointLightEntity === undefined ? {} : { pointLightEntity: lkg.pointLightEntity }),
      ...(lkg.spotLightEntity === undefined ? {} : { spotLightEntity: lkg.spotLightEntity }),
      ...(lkg.projector === undefined ? {} : { projector: lkg.projector }),
    },
  };
}

/** Project the last accepted volume (LKG); false when no accepted identity exists. */
function inspectAcceptedVolume(
  frameState: RenderFrameState,
  lkg: AcceptedVolumetricFogLkg | undefined,
  candidate: VolumeCandidateIdentity,
  status: 'accepted' | 'degraded',
  candidateFailure?: 'submit-failed',
): boolean {
  if (lkg === undefined || lkg.guid === undefined || lkg.generation === undefined) return false;
  const recovery = {
    guid: lkg.guid,
    generation: lkg.generation,
    deviceEpoch: lkg.deviceEpoch,
    status,
    ...(status === 'degraded' ? { lkgGeneration: lkg.generation } : {}),
    ...candidateRecoveryFields(candidate),
    ...acceptedVolumeSelectedLight(lkg),
    ...(candidateFailure === undefined ? {} : { candidateFailure }),
  } satisfies import('../volume/recovery').VolumeRecoveryState;
  frameState.volumetricFogInspection = inspectVolumetricFog({
    authored: true,
    capability: 'available',
    degraded: status === 'degraded',
    recovery,
    ...(lkg.digest === undefined ? {} : { acceptedDigest: lkg.digest }),
    ...(lkg.format === undefined ? {} : { format: lkg.format }),
    passCount: lkg.passCount,
    sampleCount: lkg.sampleCount,
    memoryBytes: lkg.memoryBytes,
    ...(lkg.resourceFacts === undefined ? {} : { resourceFacts: lkg.resourceFacts }),
  });
  return true;
}

function submittedVolumeSelectedLight(fog: ExtractedVolumetricFog, lights: ViewLights) {
  if (fog.lightEntity === undefined || fog.lightKind === undefined) return {};
  return {
    selectedLight: {
      entity: fog.lightEntity,
      kind: fog.lightKind,
      revision: 0,
      shadowTile:
        lights.spot.find((spot) => spot.entity === fog.spotLightEntity)?.shadowAtlasTile ??
        lights.spot.find((spot) => spot.entity === fog.lightEntity)?.shadowAtlasTile ??
        -1,
      ...(fog.pointLightEntity === undefined ? {} : { pointLightEntity: fog.pointLightEntity }),
      ...(fog.spotLightEntity === undefined ? {} : { spotLightEntity: fog.spotLightEntity }),
      ...(fog.projector === undefined ? {} : { projector: fog.projector }),
    },
  };
}

/**
 * A successfully submitted available candidate is the only path that may
 * become the new accepted projection.
 */
function inspectSubmittedVolume(
  frameState: RenderFrameState,
  fog: ExtractedVolumetricFog,
  lights: ViewLights,
  candidate: VolumeCandidateIdentity,
  resourceFacts: VolumeResourceFacts,
) {
  const recovery =
    candidate === undefined
      ? undefined
      : {
          guid: candidate.guid,
          generation: candidate.generation,
          deviceEpoch: frameState.volumetricFogInspection.deviceEpoch,
          status: 'accepted' as const,
          ...submittedVolumeSelectedLight(fog, lights),
        };
  return inspectVolumetricFog({
    authored: true,
    capability: 'available',
    ...(recovery === undefined ? {} : { recovery }),
    ...(candidate?.digest === undefined ? {} : { acceptedDigest: candidate.digest }),
    ...(fog.densityAsset?.format === undefined ? {} : { format: fog.densityAsset.format }),
    passCount: VOLUMETRIC_FOG_PASS_COUNT,
    sampleCount: resourceFacts?.sampleCount ?? 0,
    memoryBytes: resourceFacts?.totalBytes ?? 0,
    ...(resourceFacts === undefined ? {} : { resourceFacts }),
  });
}

/**
 * A degraded source that has no LKG is still a diagnostic, but it must not
 * claim accepted resources. Keep its identity in the candidate stage.
 */
function inspectCandidateVolume(
  frameState: RenderFrameState,
  fog: ExtractedVolumetricFog,
  capability: 'available' | 'unavailable',
  candidate: VolumeCandidateIdentity,
  lkg: AcceptedVolumetricFogLkg | undefined,
  failedSubmission: boolean,
) {
  const recovery =
    candidate === undefined
      ? undefined
      : {
          guid: candidate.guid,
          generation: candidate.generation,
          deviceEpoch: frameState.volumetricFogInspection.deviceEpoch,
          status: 'candidate' as const,
          ...candidateRecoveryFields(candidate),
          ...(failedSubmission ? { candidateFailure: 'submit-failed' as const } : {}),
        };
  const format = fog.densityAsset?.format === undefined ? lkg?.format : fog.densityAsset.format;
  return inspectVolumetricFog({
    authored: fog.status === 'available' || fog.status === 'degraded',
    capability,
    degraded: fog.status === 'degraded' || capability === 'unavailable',
    ...(recovery === undefined ? {} : { recovery }),
    ...(lkg?.digest === undefined ? {} : { acceptedDigest: lkg.digest }),
    ...(format === undefined ? {} : { format }),
    passCount: 0,
    sampleCount: 0,
    memoryBytes: 0,
  });
}

export function updateVolumetricFogInspection(
  frameState: RenderFrameState,
  fog: ExtractedVolumetricFog | undefined,
  lights: ViewLights,
  prepared: VolumetricFogFrameContext | undefined,
  submitted: boolean,
  volumeCapability: boolean,
  volumeSubmissionAttempted: boolean,
): void {
  const resourceFacts = volumetricFogResourceFacts(frameState);
  const acceptedLkg = acceptedVolumetricFogLkg(frameState, fog, resourceFacts);
  const candidate = volumeCandidateIdentity(fog);
  // Any candidate that reached encode/submit but failed must project the LKG,
  // never the unsubmitted candidate. The candidate identity remains visible so
  // recovery tooling can distinguish the rejected bytes from the frame being
  // rendered.
  const failedSubmission = !submitted && volumeSubmissionAttempted;

  if (fog === undefined || fog.status === 'off') {
    // A failed fog-off candidate must not erase the inspection/LKG that is
    // still being rendered. The accepted projection is retired only after a
    // successful no-volume submission below.
    if (failedSubmission) {
      inspectAcceptedVolume(frameState, acceptedLkg, candidate, 'degraded', 'submit-failed');
      return;
    }
    if (!submitted) return;
    frameState.volumetricFogInspection = inspectVolumetricFog({
      authored: false,
      capability: 'available',
    });
    return;
  }

  const capability = volumeLightingCapability(volumeCapability, fog, lights);
  // This call runs after graph settlement so the inspection and the
  // graph/context observe the same transaction.
  if (
    submitted &&
    fog.status === 'available' &&
    prepared !== undefined &&
    capability === 'available'
  ) {
    frameState.volumetricFogInspection = inspectSubmittedVolume(
      frameState,
      fog,
      lights,
      candidate,
      resourceFacts,
    );
    return;
  }

  // A submitted degraded source (or an available source whose residency
  // preparation failed) is rendered through the previously accepted graph.
  // Keep that LKG resource fact visible instead of projecting a zero-resource
  // candidate merely because the current source could not be prepared.
  if (
    submitted &&
    (fog.status === 'degraded' || prepared === undefined) &&
    inspectAcceptedVolume(frameState, acceptedLkg, candidate, 'degraded')
  ) {
    return;
  }
  if (
    failedSubmission &&
    inspectAcceptedVolume(frameState, acceptedLkg, candidate, 'degraded', 'submit-failed')
  ) {
    return;
  }
  frameState.volumetricFogInspection = inspectCandidateVolume(
    frameState,
    fog,
    capability,
    candidate,
    acceptedLkg,
    failedSubmission,
  );
}
