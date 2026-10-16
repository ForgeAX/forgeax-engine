import { err, ok, type Result } from '@forgeax/engine-types';
import type { PreparedStandardLighting } from './prepare';
import type { StandardClusterTransport } from './transport';

/** A prepared frame with no local lights on a non-storage backend. */
export interface StandardNoLocalTopologyInput {
  readonly kind: 'no-local-lights';
  readonly prepared: PreparedStandardLighting;
}

/** A prepared frame whose Standard surface uses one proven Cluster transport. */
export interface StandardClusteredTopologyInput {
  readonly kind: 'clustered';
  readonly prepared: PreparedStandardLighting;
  readonly transport: StandardClusterTransport;
}

/**
 * The only lighting value accepted by a Standard topology adapter. It is a
 * projection of one prepared frame, not a second light/config/capability
 * input. Both Forward and Deferred keep the same object identity for a frame.
 */
export type StandardTopologyInput = StandardNoLocalTopologyInput | StandardClusteredTopologyInput;

export type StandardTopologyInputValue = StandardTopologyInput;

/**
 * Stable identity for the graph-facing Standard lighting declaration.
 *
 * The prepared light payload itself is frame-local and must never be retained
 * by a compiled graph. These are the only facts that affect the Cluster graph
 * shape and persistent buffer contract, so the record owner can reject an old
 * graph before uploading a payload derived from a different declaration.
 */
export function standardLightingTopologySignature(
  input: StandardTopologyInputValue | undefined,
): string {
  if (input === undefined) return 'missing';
  if (input.kind === 'no-local-lights') return 'no-local-lights';
  return JSON.stringify({
    kind: input.kind,
    transport: input.transport.kind,
    producer: input.transport.producer,
    grid: input.prepared.layout.grid,
    clusterGridU32Length: input.prepared.layout.clusterGridU32Length,
    lightIndexListCapacity: input.prepared.layout.lightIndexListCapacity,
    lightDataSlotCount: input.prepared.layout.lightDataSlotCount,
    lightBoundsInt32Length: input.prepared.layout.lightBoundsInt32Length,
  });
}

export interface StandardTopologyInputError {
  readonly code: 'topology-input-invalid';
  readonly expected: 'prepared Standard lighting topology input';
  readonly hint: 'derive topology from prepared Standard lighting';
  readonly detail: {
    readonly field: 'kind' | 'prepared' | 'transport' | 'lights' | 'capabilities';
  };
}

function invalid(
  field: StandardTopologyInputError['detail']['field'],
): Result<never, StandardTopologyInputError> {
  return err({
    code: 'topology-input-invalid',
    expected: 'prepared Standard lighting topology input',
    hint: 'derive topology from prepared Standard lighting',
    detail: { field },
  });
}

/**
 * Validate that transport and prepared membership are the same derivation.
 * The identity checks make it impossible for an adapter to silently combine
 * one path's layout/counts with another path's prepared light corpus.
 */
export function deriveStandardTopologyInput(
  input: StandardTopologyInput,
): Result<StandardTopologyInputValue, StandardTopologyInputError> {
  const candidate = input as StandardTopologyInput & {
    readonly kind?: unknown;
    readonly lights?: unknown;
    readonly capabilities?: unknown;
    readonly transport?: unknown;
  };
  if ('lights' in candidate) return invalid('lights');
  if ('capabilities' in candidate) return invalid('capabilities');
  if (input === null || typeof input !== 'object') return invalid('kind');
  if (input.prepared === null || typeof input.prepared !== 'object') {
    return invalid('prepared');
  }

  const prepared = input.prepared;
  if (input.kind === 'no-local-lights') {
    if (prepared.local.length !== 0 || 'transport' in candidate) return invalid('transport');
    return ok(input);
  }
  if (input.kind !== 'clustered') return invalid('kind');
  if (
    !('transport' in candidate) ||
    candidate.transport === null ||
    typeof candidate.transport !== 'object'
  ) {
    return invalid('transport');
  }

  const transport = input.transport;
  const requested = prepared.local.length;
  const transportMatchesPrepared =
    transport.layout === prepared.layout &&
    transport.requestedLightCount === requested &&
    transport.admittedLightCount === requested &&
    transport.membershipEntryCount === prepared.membershipEntryCount &&
    transport.lightBoundsBytes === prepared.lightBounds.byteLength;
  const producerMatchesKind =
    (transport.producer === 'gpu' && transport.kind === 'compute-storage') ||
    (transport.producer === 'cpu' &&
      (transport.kind === 'cpu-storage' || transport.kind === 'cpu-texture'));
  if (!transportMatchesPrepared || !producerMatchesKind) return invalid('transport');
  return ok(input);
}
