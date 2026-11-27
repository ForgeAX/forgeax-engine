import { defineComponent, defineSystem, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { RhiDevice, TextureFormat } from '@forgeax/engine-rhi';
import { numMipLevels } from '@forgeax/engine-types';
import { isMultisampleAntialias } from '../components/camera';
import { TransmissionCapabilityMissingError } from '../errors/render';
import type { CameraSnapshot } from '../render-contract';
import { RenderViewFrameOrder } from '../system-order';
import {
  evaluateTransmissionCapability,
  probeTransmissionCapability,
  resolveTransmissionBackdropTopology,
  TransmissionCandidateAdmission,
  type TransmissionCapabilityFacts,
} from '../transmission/backdrop';
import {
  estimateTransmissionBackdropBytes,
  inspectTransmission,
  inspectTransmissionFromAdmission,
  type TransmissionInspection,
} from '../transmission/inspection';
import { limitRoughRefraction } from '../transmission/projection';
import { ViewRecorder } from './render-views';
import { RenderPrepare, renderSubmission } from './render-world';
import { readViewField, readViewState, requireViewField } from './view-field';
import { ViewFrame, type ViewFrameState } from './view-frame-systems';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

/** RenderPrepare: the view's transmission backdrop candidate gate. */
export const VIEW_TRANSMISSION_ADMIT_SYSTEM = 'render-transmission-admit';

/**
 * `render-transmission-admit` outcome. `admitted`: no transmission demand, or the
 * device backs it. `capability-missing`: the device cannot back the demand, so
 * the view publishes no graph. `failed`: the gate could not run; the recording
 * rethrows `cause`.
 */
export type ViewTransmissionOutcome =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'capability-missing' }
  | { readonly kind: 'failed'; readonly cause: unknown };

interface CapabilityCache {
  readonly device: RhiDevice;
  readonly formats: Map<TextureFormat, TransmissionCapabilityFacts>;
}

interface ViewTransmissionState {
  frame: number;
  outcome: ViewTransmissionOutcome;
  /** The view's persistent candidate lifecycle across frames and device generations. */
  readonly admission: TransmissionCandidateAdmission;
  /** Last completed candidate facts, detached from GPU handles. */
  inspection: TransmissionInspection | undefined;
  key: string;
  antialias: CameraSnapshot['antialias'];
  capabilities: CapabilityCache | undefined;
}

/** A recording view's transmission admission and inspection; written by `render-transmission-admit`. */
export const ViewTransmission = defineComponent('ViewTransmission', {
  state: 'unique<ViewTransmission>',
});

function stateOf(world: World, entity: EntityHandle | undefined) {
  return readViewState<ViewTransmissionState>(world, entity, ViewTransmission);
}

/** The view's admission written this renderer frame; undefined when the system did not run for it. */
export function viewTransmissionOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewTransmissionOutcome | undefined {
  const state = stateOf(world, entity);
  return state?.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/** The view's last completed transmission facts; they outlive the frame that produced them. */
export function viewTransmissionInspection(
  world: World,
  entity: EntityHandle | undefined,
): TransmissionInspection | undefined {
  return stateOf(world, entity)?.inspection;
}

/**
 * The recording takes its view's admission; a failed gate rethrows inside its
 * recovery. `capability-missing` rejects the frame before any graph exists.
 */
export function consumeViewTransmission(
  world: World,
  entity: EntityHandle | undefined,
): 'admitted' | 'capability-missing' {
  const outcome = viewTransmissionOf(world, entity);
  if (outcome === undefined)
    throw new Error(`${VIEW_TRANSMISSION_ADMIT_SYSTEM} did not admit the recorded view`);
  if (outcome.kind === 'failed') throw outcome.cause;
  return outcome.kind;
}

function capabilityOf(
  state: ViewTransmissionState,
  device: RhiDevice,
  format: TextureFormat = 'rgba16float',
): TransmissionCapabilityFacts {
  if (state.capabilities?.device !== device) state.capabilities = { device, formats: new Map() };
  const { formats } = state.capabilities;
  let facts = formats.get(format);
  if (facts === undefined) {
    facts = probeTransmissionCapability(device, format);
    formats.set(format, facts);
  }
  return facts;
}

function viewTransmissionDemand(owner: ViewSettlementOwner) {
  const profile = owner.frameState.cameraStandardProfile ?? owner.internals.standardProfile;
  return limitRoughRefraction(owner.scene.transmissionTopologyDemand(), profile?.roughRefraction);
}

function submittedBackdropTopology(
  input: Parameters<typeof resolveTransmissionBackdropTopology>[0],
  copied: boolean | undefined,
) {
  const planned = resolveTransmissionBackdropTopology(input);
  return copied === false ? { ...planned, copyCount: 0 } : planned;
}

function admitCandidate(
  state: ViewTransmissionState,
  owner: ViewSettlementOwner,
  antialias: CameraSnapshot['antialias'],
): ViewTransmissionOutcome {
  const { internals } = owner;
  const demand = viewTransmissionDemand(owner);
  if (demand.activeCount === 0) return { kind: 'admitted' };
  const topology = resolveTransmissionBackdropTopology({
    demand,
    sourceSampleCount: isMultisampleAntialias(antialias) ? 4 : 1,
  });
  const capability = {
    ...capabilityOf(state, internals.device),
    msaaResolve: isMultisampleAntialias(antialias) || topology.sourceSampleCount === 1,
  } as const;
  const verdict = evaluateTransmissionCapability(capability);
  if (verdict.ok) return { kind: 'admitted' };
  const extent = {
    width: Math.max(1, recordContext(internals).canvas.width),
    height: Math.max(1, recordContext(internals).canvas.height),
  };
  const mipCount = topology.mipCount === 0 ? 1 : numMipLevels(extent);
  state.admission.admit(demand, capability, {
    extent,
    format: capability.format,
    mipCount,
    bytes: estimateTransmissionBackdropBytes(extent, mipCount, capability.format),
    deviceGeneration: recordContext(internals).deviceScope.generation,
  });
  internals.errorRegistry.fire(
    new TransmissionCapabilityMissingError('standard transmission', 'prepare', {
      lane: 'standard-forward',
      format: capability.format,
      missing: verdict.missing,
    }),
  );
  return { kind: 'capability-missing' };
}

/**
 * Refresh the view's detached inspection from its demand and admission.
 * `submitted` reads the submitted graph's physical backdrop; otherwise the
 * facts come from the last admission. Never throws into a frame: inspection is
 * observation, and a failed read keeps the previous facts.
 */
function refreshInspection(
  state: ViewTransmissionState,
  owner: ViewSettlementOwner,
  antialias: CameraSnapshot['antialias'],
  submitted: boolean,
): void {
  const { internals, frameState } = owner;
  state.antialias = antialias;
  const demand = viewTransmissionDemand(owner);
  if (demand.activeCount === 0) {
    state.inspection = undefined;
    state.key = '';
    return;
  }
  const targets = submitted ? frameState.currentTransmissionTargets : undefined;
  const current = targets?.current;
  const physical =
    submitted && current === undefined
      ? frameState.compiledFrameGraph?.graph
          .inspect()
          .resources.find(
            (resource) => resource.kind === 'texture' && resource.label === 'transmission-backdrop',
          )
      : undefined;
  const descriptor = physical?.descriptor.kind === 'texture' ? physical.descriptor : undefined;
  const extent = {
    width:
      current?.width ?? descriptor?.width ?? Math.max(1, recordContext(internals).canvas.width),
    height:
      current?.height ?? descriptor?.height ?? Math.max(1, recordContext(internals).canvas.height),
  };
  const topology = submittedBackdropTopology(
    {
      demand,
      sourceSampleCount: isMultisampleAntialias(antialias) ? 4 : 1,
    },
    targets?.copied,
  );
  const format = current?.format ?? descriptor?.format ?? 'rgba16float';
  const mipCount =
    (current === undefined ? undefined : frameState.currentTransmissionTargets?.mipCount) ??
    descriptor?.mipLevelCount ??
    (topology.mipCount === 0 ? 1 : numMipLevels(extent));
  const resource =
    current === undefined && descriptor === undefined
      ? undefined
      : ({
          extent,
          format,
          mipCount,
          bytes:
            current?.color.allocation.bytes ??
            physical?.byteSize ??
            estimateTransmissionBackdropBytes(extent, mipCount, format),
          deviceGeneration: recordContext(internals).deviceScope.generation,
        } as const);
  const key = `${demand.activeCount}:${demand.needsRoughMips}:${extent.width}:${extent.height}:${recordContext(internals).deviceScope.generation}:${format}:${mipCount}:${topology.copyCount}:${resource?.bytes ?? 0}:${antialias}:${submitted}`;
  if (key === state.key && state.inspection !== undefined) return;
  if (submitted) {
    state.admission.admit(
      demand,
      {
        ...capabilityOf(state, internals.device, format),
        msaaResolve: isMultisampleAntialias(antialias) || topology.sourceSampleCount === 1,
      },
      resource,
    );
  }
  const admission = state.admission.inspectLifecycle();
  state.inspection = submitted
    ? inspectTransmissionFromAdmission({
        admission,
        topology,
        extent,
        transmissionDrawCount: resource === undefined ? 0 : demand.activeCount,
      })
    : inspectTransmission({
        demand,
        topology,
        extent,
        generation: admission.generation,
        lastKnownGood: admission.lastKnownGood,
        lifecycle: admission.lifecycle,
        recovery: admission.recovery,
        capability: admission.capability,
        resourcePresent: admission.resource !== undefined,
        ...(admission.resource === undefined
          ? {}
          : {
              extent: admission.resource.extent,
              format: admission.resource.format,
              mipCount: admission.resource.mipCount,
              bytes: admission.resource.bytes,
            }),
        transmissionDrawCount: demand.activeCount,
      });
  state.key = key;
}

/** The recording's submission settles the view's inspection from the graph it submitted. */
export function settleViewTransmission(
  world: World,
  entity: EntityHandle | undefined,
  owner: ViewSettlementOwner,
  submitted: boolean,
): void {
  const state = stateOf(world, entity);
  if (state !== undefined) refreshInspection(state, owner, state.antialias, submitted);
}

/** Device loss fences the physical backdrop and exposes the rebuild-required lifecycle. */
export function recoverViewTransmission(
  world: World,
  entity: EntityHandle | undefined,
  owner: ViewSettlementOwner,
): void {
  const state = stateOf(world, entity);
  if (state === undefined) return;
  state.admission.markDeviceLost();
  state.key = '';
  state.capabilities = undefined;
  refreshInspection(state, owner, state.antialias, false);
}

/**
 * Register `render-transmission-admit` (RenderPrepare): each staged view whose
 * frame resolved checks that the device can back its scene's transmission
 * demand. A missing capability fires the structured error and stores the
 * outcome the recording rejects on; it is never thrown here.
 */
export function registerTransmissionSystem(world: World): void {
  const systemToken1 = defineSystem({
    commands: 'none',
    name: VIEW_TRANSMISSION_ADMIT_SYSTEM,
    after: [RenderViewFrameOrder],
    queries: [{ read: [ViewRecorder, ViewFrame], optional: [ViewTransmission] }],
    fn: (world, [rows]) => {
      const frame = renderSubmission(world).frame;
      const first: { entity: EntityHandle; state: ViewTransmissionState }[] = [];

      rows.forEach((row) => {
        const entity = row.entity;

        const staged = world
          .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
          .unwrap();
        if (staged.frame !== frame || staged.result?.ok !== true) return;
        const owner = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
        const stored = readViewField(world, entity, ViewTransmission, 'state');
        const state: ViewTransmissionState =
          stored === undefined
            ? {
                frame,
                outcome: { kind: 'admitted' },
                admission: new TransmissionCandidateAdmission(),
                inspection: undefined,
                key: '',
                antialias: 'none',
                capabilities: undefined,
              }
            : world.resolveUniqueRef<ViewTransmissionState>(stored).unwrap();
        const antialias = staged.result.value.cameras[0]?.antialias ?? 'none';
        state.frame = frame;
        try {
          state.outcome = admitCandidate(state, owner, antialias);
          if (state.outcome.kind === 'capability-missing')
            refreshInspection(state, owner, antialias, false);
        } catch (cause) {
          state.outcome = { kind: 'failed', cause };
        }
        state.antialias = antialias;
        if (stored === undefined) first.push({ entity: entity, state });
      });
      // A view's first admission attaches its component after the iteration.
      for (const { entity, state } of first)
        world
          .addComponent(entity, {
            component: ViewTransmission,
            data: { state: world.allocUniqueRef('ViewTransmission', state) },
          })
          .unwrap();
    },
  });
  world.addSystem(RenderPrepare, systemToken1).unwrap();
}
