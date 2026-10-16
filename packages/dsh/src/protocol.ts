export const FEDERATION_PROTOCOL_VERSION = 1 as const;
export const FEDERATION_ROUTE_PREFIX = '/forgeax-federation/v1' as const;

export type FederationBinding = 'attach' | 'external' | 'embedded';
export type FederationOwnership = 'lease' | 'instance';

export interface FederationStatus {
  readonly protocol: typeof FEDERATION_PROTOCOL_VERSION;
  readonly identity: string;
  readonly ready: true;
  readonly realm: 'dsh';
  readonly capabilities: readonly string[];
  readonly leases: number;
  readonly engine: EngineProjection;
}

export type EngineProjection = EngineEndpointProjection | EmbeddedEngineProjection;

export interface EngineEndpointProjection {
  readonly binding: 'external';
  readonly endpoint: string;
  readonly ready: true;
}

export interface EmbeddedEngineProjection {
  readonly binding: 'embedded';
  readonly ready: true;
  readonly frameId: number;
  readonly tick: number;
  readonly state: number;
}

export interface FederationLease {
  readonly leaseId: string;
}

export interface FederationCommunityCapability {
  readonly id: string;
  readonly value: string;
}

export interface FederationActivityResult {
  readonly output: string;
}

export interface EnginePreviewStatus {
  readonly protocol: typeof FEDERATION_PROTOCOL_VERSION;
  readonly kind: 'forgeax-engine-status';
  readonly binding: 'external';
  readonly ready: true;
  readonly frameId: number;
  readonly tick: number;
  readonly state: number;
}

export interface EnginePreviewPoll {
  readonly protocol: typeof FEDERATION_PROTOCOL_VERSION;
  readonly kind: 'forgeax-engine-poll';
}

export interface EnginePreviewControl {
  readonly protocol: typeof FEDERATION_PROTOCOL_VERSION;
  readonly kind: 'forgeax-engine-control';
  readonly action: 'toggle';
}

export type EnginePreviewRequest = EnginePreviewPoll | EnginePreviewControl;

export function isEnginePreviewRequest(value: unknown): value is EnginePreviewRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.protocol !== FEDERATION_PROTOCOL_VERSION) return false;
  if (record.kind === 'forgeax-engine-poll') return true;
  return record.kind === 'forgeax-engine-control' && record.action === 'toggle';
}

export function isEnginePreviewStatus(value: unknown): value is EnginePreviewStatus {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocol === FEDERATION_PROTOCOL_VERSION &&
    record.kind === 'forgeax-engine-status' &&
    record.binding === 'external' &&
    record.ready === true &&
    typeof record.frameId === 'number' &&
    typeof record.tick === 'number' &&
    typeof record.state === 'number'
  );
}

export function isFederationStatus(value: unknown): value is FederationStatus {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocol === FEDERATION_PROTOCOL_VERSION &&
    record.realm === 'dsh' &&
    record.ready === true &&
    typeof record.identity === 'string' &&
    Array.isArray(record.capabilities) &&
    record.capabilities.every((capability) => typeof capability === 'string') &&
    Number.isInteger(record.leases) &&
    (record.leases as number) >= 0 &&
    isEngineProjection(record.engine)
  );
}

function isEngineProjection(value: unknown): value is EngineProjection {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ready !== true) return false;
  if (record.binding === 'external') return typeof record.endpoint === 'string';
  return (
    record.binding === 'embedded' &&
    typeof record.frameId === 'number' &&
    typeof record.tick === 'number' &&
    typeof record.state === 'number'
  );
}
