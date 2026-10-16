import { textureFormatBlock } from '@forgeax/engine-types';
import type {
  TransmissionBackdropExtent,
  TransmissionBackdropTopology,
  TransmissionCandidateAdmissionInspection,
  TransmissionCapabilityFact,
  TransmissionCapabilityVerdict,
  TransmissionLifecycleState,
  TransmissionRecoveryState,
} from './backdrop';
import type { TransmissionDemand } from './projection';

export type {
  TransmissionBackdropExtent,
  TransmissionCandidateAdmissionInspection,
  TransmissionLifecycleState,
  TransmissionRecoveryState,
} from './backdrop';

export interface TransmissionInspection {
  readonly activeCount: number;
  readonly needsRoughMips: boolean;
  readonly extent: TransmissionBackdropExtent;
  readonly format: string;
  /** Total resident mip levels, including level zero. */
  readonly mipCount: number;
  readonly bytes: number;
  readonly copyCount: number;
  readonly transmissionDrawCount: number;
  readonly fallbackCount: number;
  readonly generation: number;
  readonly singleLayer: true;
  readonly lifecycle: TransmissionLifecycleState;
  readonly lastKnownGood: boolean;
  readonly recovery: TransmissionRecoveryState;
  readonly capability: TransmissionCapabilityVerdict;
}

export interface TransmissionInspectionInput {
  readonly demand: TransmissionDemand;
  readonly topology: Pick<TransmissionBackdropTopology, 'active' | 'copyCount' | 'mipCount'>;
  readonly extent: TransmissionBackdropExtent;
  readonly generation: number;
  readonly lastKnownGood: boolean;
  readonly recovery: TransmissionRecoveryState;
  readonly lifecycle?: TransmissionLifecycleState;
  /** Whether a committed physical backdrop is resident on the active device. */
  readonly resourcePresent?: boolean;
  readonly format?: string;
  /** Override only when the resource receipt reports the actual total. */
  readonly mipCount?: number;
  /** Override only when the resource receipt reports the actual allocation. */
  readonly bytes?: number;
  readonly transmissionDrawCount?: number;
  readonly fallbackCount?: number;
  readonly capability?: TransmissionCapabilityVerdict;
}

export interface TransmissionInspectionFromAdmissionInput {
  readonly admission: TransmissionCandidateAdmissionInspection;
  readonly topology: TransmissionInspectionInput['topology'];
  readonly extent: TransmissionBackdropExtent;
  readonly transmissionDrawCount?: number;
  readonly fallbackCount?: number;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function assertExtent(extent: TransmissionBackdropExtent): void {
  if (!Number.isInteger(extent.width) || extent.width <= 0) {
    throw new Error('transmission inspection extent.width must be a positive integer');
  }
  if (!Number.isInteger(extent.height) || extent.height <= 0) {
    throw new Error('transmission inspection extent.height must be a positive integer');
  }
}

function mipExtent(value: number, level: number): number {
  return Math.max(1, Math.floor(value / 2 ** level));
}

export function estimateTransmissionBackdropBytes(
  extent: TransmissionBackdropExtent,
  mipCount: number,
  format = 'rgba16float',
): number {
  assertExtent(extent);
  assertNonNegativeInteger('transmission inspection mipCount', mipCount);
  if ((format !== 'rgba16float' && format !== 'rgba32float') || mipCount === 0) return 0;

  let bytes = 0;
  for (let level = 0; level < mipCount; level += 1) {
    bytes += mipExtent(extent.width, level) * mipExtent(extent.height, level);
  }
  return bytes * textureFormatBlock(format).bytesPerBlock;
}

function copyCapability(capability: TransmissionCapabilityVerdict): TransmissionCapabilityVerdict {
  return capability.ok
    ? { ok: true, missing: [] }
    : { ok: false, missing: [...capability.missing] as TransmissionCapabilityFact[] };
}

function defaultLifecycle(active: boolean, lastKnownGood: boolean): TransmissionLifecycleState {
  if (!active) return 'inactive';
  return lastKnownGood ? 'resident' : 'failed';
}

/**
 * Project the last completed backdrop facts into a detached, stable POD.
 * Demand and copy/mip topology are read from their existing owners; this
 * function never accepts a texture, view, encoder, queue, or graph handle.
 */
export function inspectTransmission(input: TransmissionInspectionInput): TransmissionInspection {
  const active = input.demand.activeCount > 0;
  if (input.topology.active !== active) {
    throw new Error('transmission inspection demand and topology are inconsistent');
  }
  assertNonNegativeInteger('transmission inspection generation', input.generation);
  assertNonNegativeInteger(
    'transmission inspection transmissionDrawCount',
    input.transmissionDrawCount ?? 0,
  );
  assertNonNegativeInteger('transmission inspection fallbackCount', input.fallbackCount ?? 0);
  assertExtent(input.extent);

  const format = input.format ?? 'rgba16float';
  const resourcePresent = input.resourcePresent ?? input.lastKnownGood;
  const mipCount = resourcePresent ? (input.mipCount ?? input.topology.mipCount + 1) : 0;
  assertNonNegativeInteger('transmission inspection mipCount', mipCount);
  const bytes = resourcePresent
    ? (input.bytes ?? estimateTransmissionBackdropBytes(input.extent, mipCount, format))
    : 0;
  assertNonNegativeInteger('transmission inspection bytes', bytes);
  const copyCount = resourcePresent ? input.topology.copyCount : 0;
  if (copyCount !== (resourcePresent ? 1 : 0)) {
    throw new Error('transmission inspection copy count does not match backdrop topology');
  }

  return Object.freeze({
    activeCount: input.demand.activeCount,
    needsRoughMips: active && input.demand.needsRoughMips,
    extent: Object.freeze({ ...input.extent }),
    format,
    mipCount,
    bytes,
    copyCount,
    transmissionDrawCount: input.transmissionDrawCount ?? 0,
    fallbackCount: input.fallbackCount ?? 0,
    generation: input.generation,
    singleLayer: true,
    lifecycle: input.lifecycle ?? defaultLifecycle(active, input.lastKnownGood),
    lastKnownGood: input.lastKnownGood,
    recovery: input.recovery,
    capability: copyCapability(input.capability ?? { ok: true, missing: [] }),
  });
}

export function inspectTransmissionFromAdmission(
  input: TransmissionInspectionFromAdmissionInput,
): TransmissionInspection {
  const resource = input.admission.resource;
  return inspectTransmission({
    demand: input.admission.demand,
    topology: input.topology,
    extent: resource?.extent ?? input.extent,
    ...(resource === undefined
      ? {}
      : { format: resource.format, mipCount: resource.mipCount, bytes: resource.bytes }),
    resourcePresent: resource !== undefined,
    generation: input.admission.generation,
    lifecycle: input.admission.lifecycle,
    lastKnownGood: input.admission.lastKnownGood,
    recovery: input.admission.recovery,
    capability: input.admission.capability,
    ...(input.transmissionDrawCount === undefined
      ? {}
      : { transmissionDrawCount: input.transmissionDrawCount }),
    ...(input.fallbackCount === undefined ? {} : { fallbackCount: input.fallbackCount }),
  });
}
