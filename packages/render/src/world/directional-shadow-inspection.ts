import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { Texture } from '@forgeax/engine-rhi';
import {
  type DirectionalShadowInspectionSource,
  directionalShadowProfileFromQuality,
  projectDirectionalShadowInspectionSource,
} from '../assembly/directional-shadow-inspection';
import type { DirectionalShadowInspection } from '../inspection-types';
import {
  directionalShadowCandidateError,
  directionalShadowSubmitted,
} from '../render-system-record-attempt';
import type { ShadowDepthLayers } from '../shadow-depth-layers';
import type { DirectionalShadowOutcome, StagedRecord } from './record-history';
import { type ViewLights, viewLightsOf } from './render-lights';
import { renderWorldFor } from './render-world';
import { recordContext } from './view-record-context';
import type { ViewSettlementOwner } from './view-settlement';

const DEPTH = 'directional-shadow-depth';

/** Cheap owner facts only: graph inspection and detached projection happen on public inspection. */
export interface SettledDirectionalShadow
  extends Omit<DirectionalShadowInspectionSource, 'writerPasses'> {
  readonly renderAttempt: number;
  readonly observationFrameId: number | undefined;
  readonly submitted: boolean;
  readonly sceneSubmitted: boolean;
  readonly accepted: boolean;
  readonly graph: ViewSettlementOwner['frameState']['compiledFrameGraph'];
  readonly layers: ShadowDepthLayers | undefined;
  readonly allocation: Texture | undefined;
}

function submittedDirectionalShadow(
  { attempt, failure }: StagedRecord,
  lights: ViewLights | undefined,
  ready: boolean,
): boolean {
  return (
    failure === undefined &&
    lights?.directionalShadowError === undefined &&
    attempt.outcome !== undefined &&
    attempt.submitted &&
    attempt.sceneSubmitted &&
    ready
  );
}

/** A successfully submitted preparation barrier deliberately records no scene or shadow work. */
function submittedPreparationOnly(staged: StagedRecord): boolean {
  const { attempt } = staged;
  return (
    staged.failure === undefined &&
    attempt.submitted &&
    !attempt.sceneSubmitted &&
    (attempt.outcome === undefined || attempt.outcome.presentation.presentation === 'pending')
  );
}

function settledDirectionalShadowError(
  { frameState, internals }: ViewSettlementOwner,
  lights: ViewLights | undefined,
  shadowSubmitted: boolean,
  requested: DirectionalShadowInspectionSource['requested'],
  submitted: boolean,
  preparationOnly: boolean,
): DirectionalShadowInspectionSource['error'] {
  return (
    lights?.directionalShadowError ??
    (!shadowSubmitted && requested !== 'off' && lights !== undefined && !preparationOnly
      ? directionalShadowCandidateError(frameState, internals, lights, submitted)
      : undefined)
  );
}

/** Publish every settled attempt, including preparation/record failures with no outcome. */
export function settleDirectionalShadow(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
  shadow: DirectionalShadowOutcome,
  staged: StagedRecord,
  frameAccepted: boolean,
): void {
  const { frameState, internals } = owner;
  const { attempt } = staged;
  const lights = attempt.outcome?.lights ?? viewLightsOf(world, entity);
  const requested = directionalShadowProfileFromQuality(lights?.cascades?.directionalShadowQuality);
  const ready = lights !== undefined && directionalShadowSubmitted(frameState, internals, lights);
  const accepted = frameAccepted && staged.accepted;
  const shadowSubmitted = submittedDirectionalShadow(staged, lights, ready);
  const candidate = shadowSubmitted ? 'accepted' : 'failed';
  const error = settledDirectionalShadowError(
    owner,
    lights,
    shadowSubmitted,
    requested,
    attempt.submitted,
    submittedPreparationOnly(staged),
  );
  const layers = frameState.shadowDepthLayers;
  shadow.candidate = candidate;
  shadow.error = error;
  shadow.settled = {
    requested,
    candidate,
    error,
    lastKnownGood:
      frameState.directionalShadowCache === null
        ? undefined
        : directionalShadowProfileFromQuality(
            frameState.directionalShadowCache.directionalShadowQuality,
          ),
    cascadeCount: lights?.cascades?.cascadeCount ?? 0,
    mapSize: recordContext(internals).getPipelineState()?.perPassResources.shadowMapSize ?? 0,
    shadowMapBytes: shadowSubmitted && ready ? (layers?.byteSize(DEPTH) ?? 0) : 0,
    shadowAngularRadius: lights?.directionalCsmConfig?.shadowAngularRadius,
    maxPenumbraTexels: lights?.directionalCsmConfig?.maxPenumbraTexels,
    deviceGeneration: staged.generation ?? recordContext(internals).deviceScope.generation,
    graphGeneration:
      frameState.compiledFrameGraph?.targets.graphGeneration ?? frameState.graphGeneration,
    shadowReady: shadowSubmitted && requested !== 'off' && ready,
    renderAttempt: staged.frame,
    observationFrameId: internals.observationFrameId,
    submitted: attempt.submitted,
    sceneSubmitted: attempt.sceneSubmitted,
    accepted,
    graph: frameState.compiledFrameGraph,
    layers,
    allocation: layers?.allocation(DEPTH),
  };
}

function requestedShadowCurrent(
  owner: ViewSettlementOwner,
  settled: SettledDirectionalShadow,
): boolean {
  const { internals } = owner;
  const lights = viewLightsOf(renderWorldFor(internals), internals.viewEntity);
  return (
    settled.requested ===
      directionalShadowProfileFromQuality(lights?.cascades?.directionalShadowQuality) &&
    settled.cascadeCount === (lights?.cascades?.cascadeCount ?? 0) &&
    settled.shadowAngularRadius === lights?.directionalCsmConfig?.shadowAngularRadius &&
    settled.maxPenumbraTexels === lights?.directionalCsmConfig?.maxPenumbraTexels &&
    lights?.directionalShadowError === undefined
  );
}

function retainedOwnerCurrent(
  owner: ViewSettlementOwner,
  settled: SettledDirectionalShadow,
): boolean {
  const { frameState, internals } = owner;
  if (
    !requestedShadowCurrent(owner, settled) ||
    settled.deviceGeneration !== recordContext(internals).deviceScope.generation ||
    settled.mapSize !==
      (recordContext(internals).getPipelineState()?.perPassResources.shadowMapSize ?? 0)
  )
    return false;
  if (settled.requested === 'off') return true;
  const layers = frameState.shadowDepthLayers;
  if (
    layers === undefined ||
    layers !== settled.layers ||
    settled.allocation === undefined ||
    layers.allocation(DEPTH) !== settled.allocation ||
    layers.byteSize(DEPTH) !== settled.shadowMapBytes
  )
    return false;
  for (let layer = 0; layer < settled.cascadeCount; layer++)
    if (!layers.retained(DEPTH, layer)) return false;
  return true;
}

/** Lazy detached facts of that attempt; current resource loss can invalidate, never upgrade it. */
export function inspectSettledDirectionalShadow(
  owner: ViewSettlementOwner,
  settled: SettledDirectionalShadow,
): DirectionalShadowInspection {
  const current = retainedOwnerCurrent(owner, settled);
  const lights = viewLightsOf(renderWorldFor(owner.internals), owner.internals.viewEntity);
  const projection = projectDirectionalShadowInspectionSource({
    ...settled,
    candidate: current ? settled.candidate : 'failed',
    shadowReady: current && settled.shadowReady,
    shadowMapBytes: current && settled.shadowReady ? settled.shadowMapBytes : 0,
    error: current ? settled.error : (lights?.directionalShadowError ?? settled.error),
    writerPasses:
      settled.graph?.graph.inspect().passes.filter((pass) => pass.name.startsWith('shadowCascade'))
        .length ?? 0,
  });
  return Object.freeze({
    ...projection,
    settlement: Object.freeze({
      scope: 'settled-view-record-attempt',
      renderAttempt: settled.renderAttempt,
      observationFrameId: settled.observationFrameId,
      submitted: settled.submitted,
      sceneSubmitted: settled.sceneSubmitted,
      accepted: settled.accepted,
    }),
  });
}
