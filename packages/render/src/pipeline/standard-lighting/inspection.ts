import type { StandardTopologyInputValue } from './topology';
import type { StandardClusterTransport } from './transport';

export interface StandardClusterTransportInspection {
  readonly renderPath: 'forward' | 'deferred';
  readonly transport: StandardClusterTransport['kind'];
  readonly producer: StandardClusterTransport['producer'];
  readonly requested: StandardClusterTransport['requestedLightCount'];
  readonly admitted: StandardClusterTransport['admittedLightCount'];
  readonly shadowed: number;
  readonly maxLights: number;
  readonly indexCount: StandardClusterTransport['membershipEntryCount'];
  readonly occupied: StandardClusterTransport['occupiedClusterCount'];
  readonly clusterGridBytes: number;
  readonly lightIndexListBytes: number;
  readonly lightDataBytes: number;
  readonly lightBoundsBytes: number;
  readonly grid: StandardClusterTransport['layout']['grid'];
}

export interface StandardNoLocalLightingInspection {
  readonly renderPath: 'forward' | 'deferred';
  readonly transport: 'not-required';
  readonly producer: 'none';
  readonly requested: 0;
  readonly admitted: 0;
  readonly shadowed: 0;
  readonly maxLights: number;
  readonly indexCount: 0;
  readonly occupied: 0;
  readonly clusterGridBytes: 0;
  readonly lightIndexListBytes: 0;
  readonly lightDataBytes: 0;
  readonly lightBoundsBytes: 0;
  readonly grid: StandardTopologyInputValue['prepared']['layout']['grid'];
}

export type StandardLightingInspection =
  | StandardClusterTransportInspection
  | StandardNoLocalLightingInspection;

export function inspectStandardClusterTransport(
  transport: StandardClusterTransport,
  prepared: StandardTopologyInputValue['prepared'],
): StandardClusterTransportInspection {
  return Object.freeze({
    renderPath: prepared.renderPath,
    transport: transport.kind,
    producer: transport.producer,
    requested: transport.requestedLightCount,
    admitted: transport.admittedLightCount,
    shadowed: prepared.local.filter((light) => light.shadowed === true).length,
    maxLights: prepared.maxLights,
    indexCount: transport.membershipEntryCount,
    occupied: transport.occupiedClusterCount,
    clusterGridBytes: transport.clusterGridBytes,
    lightIndexListBytes: transport.lightIndexListBytes,
    lightDataBytes: transport.lightDataBytes,
    lightBoundsBytes: transport.lightBoundsBytes,
    // The inspection boundary is JSON-safe and detached from the mutable
    // layout object carried by a per-frame prepared result.
    grid: Object.freeze({ ...transport.layout.grid }),
  });
}

export function inspectStandardLighting(
  input: StandardTopologyInputValue,
): StandardLightingInspection {
  if (input.kind === 'no-local-lights') {
    return Object.freeze({
      renderPath: input.prepared.renderPath,
      transport: 'not-required' as const,
      producer: 'none' as const,
      requested: 0 as const,
      admitted: 0 as const,
      shadowed: 0 as const,
      maxLights: input.prepared.maxLights,
      indexCount: 0 as const,
      occupied: 0 as const,
      clusterGridBytes: 0 as const,
      lightIndexListBytes: 0 as const,
      lightDataBytes: 0 as const,
      lightBoundsBytes: 0 as const,
      grid: Object.freeze({ ...input.prepared.layout.grid }),
    });
  }
  return inspectStandardClusterTransport(input.transport, input.prepared);
}
