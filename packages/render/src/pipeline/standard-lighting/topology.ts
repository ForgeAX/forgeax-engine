import { err, ok, type Result } from '@forgeax/engine-types';
import type { StandardClusterLayout } from './layout';
import { standardLightBoundsBytes } from './membership';
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
type StandardTopologyInput = StandardNoLocalTopologyInput | StandardClusteredTopologyInput;

export type StandardTopologyInputValue = StandardTopologyInput;

/** Physical layout of a graph-owned Cluster binding. The light payload stays frame-local. */
export type StandardLightingDeclaration =
  | 'missing'
  | 'no-local-lights'
  | {
      readonly kind: StandardClusterTransport['kind'];
      readonly producer: StandardClusterTransport['producer'];
      readonly layout: StandardClusterLayout;
      readonly slotBytes: number;
      readonly uniformBytes: number;
    };

export function standardLightingDeclaration(
  input: StandardTopologyInputValue | undefined,
): StandardLightingDeclaration {
  if (input?.kind !== 'clustered') return input?.kind ?? 'missing';
  return {
    kind: input.transport.kind,
    producer: input.transport.producer,
    layout: input.prepared.layout,
    slotBytes: input.transport.lightDataSlotBytes,
    uniformBytes: input.transport.clusterUniformBytes,
  };
}

export function matchesStandardLightingDeclaration(
  declaration: StandardLightingDeclaration,
  input: StandardTopologyInputValue | undefined,
): boolean {
  if (input?.kind !== 'clustered') return declaration === (input?.kind ?? 'missing');
  if (typeof declaration === 'string') return false;
  const transport = input.transport;
  return (
    declaration.kind === transport.kind &&
    declaration.producer === transport.producer &&
    declaration.slotBytes === transport.lightDataSlotBytes &&
    declaration.uniformBytes === transport.clusterUniformBytes &&
    matchesClusterLayout(declaration.layout, input.prepared.layout)
  );
}

function matchesClusterLayout(a: StandardClusterLayout, b: StandardClusterLayout): boolean {
  return (
    a === b ||
    (a.grid.x === b.grid.x &&
      a.grid.y === b.grid.y &&
      a.grid.z === b.grid.z &&
      a.clusterGridU32Length === b.clusterGridU32Length &&
      a.lightIndexListCapacity === b.lightIndexListCapacity &&
      a.lightDataSlotCount === b.lightDataSlotCount &&
      a.lightBoundsInt32Length === b.lightBoundsInt32Length)
  );
}

/** The authored graph topology still exposes the established diagnostic identity. */
export function standardLightingTopologySignature(
  input: StandardTopologyInputValue | undefined,
): string {
  if (input?.kind !== 'clustered') return input?.kind ?? 'missing';
  const { layout } = input.prepared;
  return JSON.stringify({
    kind: input.kind,
    transport: input.transport.kind,
    producer: input.transport.producer,
    grid: layout.grid,
    clusterGridU32Length: layout.clusterGridU32Length,
    lightIndexListCapacity: layout.lightIndexListCapacity,
    lightDataSlotCount: layout.lightDataSlotCount,
    lightDataSlotBytes: input.transport.lightDataSlotBytes,
    clusterUniformBytes: input.transport.clusterUniformBytes,
    lightBoundsInt32Length: layout.lightBoundsInt32Length,
  });
}

interface StandardTopologyInputError {
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
  const admitted = prepared.local.length;
  const transportMatchesPrepared =
    transport.layout === prepared.layout &&
    transport.requestedLightCount === admitted + prepared.droppedLocalLights &&
    transport.admittedLightCount === admitted &&
    transport.membershipEntryCount === prepared.membershipEntryCount &&
    transport.lightBoundsBytes === standardLightBoundsBytes(prepared);
  const producerMatchesKind =
    (transport.producer === 'gpu' && transport.kind === 'compute-storage') ||
    (transport.producer === 'cpu' &&
      (transport.kind === 'cpu-storage' || transport.kind === 'cpu-texture'));
  if (!transportMatchesPrepared || !producerMatchesKind) return invalid('transport');
  return ok(input);
}
