import type { Page, Frame } from 'playwright';

export type RunIdentity = { serviceId: string; runId: string; key?: string };
export type GpuMode = 'auto' | 'hardware' | 'software';
export type LeaseRequest = { run: RunIdentity; generation: number; headless?: boolean; gpu?: GpuMode; width?: number; height?: number; metadata?: unknown };
export type NormalizedLeaseRequest = ReturnType<typeof createLeaseRequest>;
export type LeaseTarget = { leaseId: string; targetId: string; kind: string; surfaceId: string; run: RunIdentity; generation: number; width: number; height: number; gpu: GpuMode; allocatedAt?: number };
export type CarrierCapabilities = { protocolVersion: number; ready: boolean; supportsPage: boolean; gpuModes: readonly GpuMode[]; maxWidth: number; maxHeight: number; canvasSizing: string };
export type CreatePageInput = { leaseId: string; run: RunIdentity; generation: number; width: number; height: number; gpu: GpuMode; signal?: AbortSignal; onLost: (reason?: string) => void };
export type ExecutionTarget = { kind: 'page'; ownerPage: Page; realm: Page } | { kind: 'frame'; ownerPage: Page; realm: Frame; surfaceSelector: string };
export type ViewPlatformPage = { targetId: string | number; surfaceId: string; kind?: string; page: Page; execution?: ExecutionTarget; dispose?: () => void | Promise<void>; close?: () => void | Promise<void> };
export type ViewPlatform = { createPage(input: CreatePageInput): Promise<ViewPlatformPage>; getCapabilities?: () => Partial<CarrierCapabilities>; dispose?: () => void | Promise<void> };
export type ReleaseResult = { released: boolean; reason: string; leaseId?: string };
export type ViewDecision = { carrier: typeof VIEW_CARRIER; target: LeaseTarget; request: NormalizedLeaseRequest; release: (reason?: string) => Promise<ReleaseResult> };
export type FallbackReason = typeof FALLBACK_REASONS[keyof typeof FALLBACK_REASONS];
export type FallbackDecision = { carrier: typeof BROWSER_CARRIER; fallbackReason: FallbackReason; message?: string; currentGeneration?: number; occupiedBy?: RunIdentity };

export const VIEW_PROTOCOL = 'forgeax-view/1';
export const VIEW_PROTOCOL_VERSION = 1;
export const VIEW_CARRIER = 'view';
// Keep the fallback discriminator identical to Engine's public carrier seam.
export const BROWSER_CARRIER = 'private-browser';

export const GPU_MODES = Object.freeze(['auto', 'hardware', 'software'] as const);

/**
 * Fallback identifiers are stable API values.  They are deliberately more
 * specific than a generic "View unavailable" so CLI output can explain why
 * an existing headed browser carrier was selected.
 */
export const FALLBACK_REASONS = Object.freeze({
  HEADLESS_REQUESTED: 'headless-requested',
  PROTOCOL_UNSUPPORTED: 'view-protocol-unsupported',
  CAPABILITY_MISMATCH: 'view-capability-mismatch',
  OCCUPIED: 'view-occupied',
  CANCELLED: 'view-cancelled',
  STALE_GENERATION: 'view-stale-generation',
  TARGET_LOST: 'view-target-lost',
  ALLOCATION_FAILED: 'view-allocation-failed',
} as const);

const FALLBACK_REASON_VALUES = new Set(Object.values(FALLBACK_REASONS));

function requireString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function createRunIdentity({ serviceId, runId }: RunIdentity) {
  const identity = Object.freeze({
    serviceId: requireString(serviceId, 'serviceId'),
    runId: requireString(runId, 'runId'),
  });
  return Object.freeze({ ...identity, key: `${identity.serviceId}:${identity.runId}` });
}

export function normalizeRunIdentity(run: RunIdentity | undefined) {
  if (!run || typeof run !== 'object') {
    throw new TypeError('run identity is required');
  }
  return createRunIdentity(run);
}

export function createLeaseRequest({
  run,
  generation,
  headless = false,
  gpu = 'auto',
  width = 1280,
  height = 720,
  metadata,
}: Partial<LeaseRequest> = {}) {
  const identity = normalizeRunIdentity(run);
  const normalizedGeneration = requireInteger(generation, 'generation');
  if (!GPU_MODES.includes(gpu)) {
    throw new TypeError(`gpu must be one of ${GPU_MODES.join(', ')}`);
  }
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new TypeError('width and height must be positive safe integers');
  }
  return Object.freeze({
    run: identity,
    generation: normalizedGeneration,
    headless: Boolean(headless),
    gpu,
    width,
    height,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

export function sameRun(a: RunIdentity | undefined | null, b: RunIdentity | undefined | null) {
  return Boolean(a && b && a.serviceId === b.serviceId && a.runId === b.runId);
}

export function assertLeaseTarget(target: LeaseTarget) {
  if (!target || typeof target !== 'object') throw new TypeError('lease target is required');
  requireString(target.leaseId, 'leaseId');
  requireString(target.targetId, 'targetId');
  requireString(target.kind, 'target.kind');
  requireString(target.surfaceId, 'surfaceId');
  if (!/^[_A-Za-z][_A-Za-z0-9-]*$/.test(target.surfaceId)) {
    throw new TypeError('surfaceId must be a stable DOM id');
  }
  normalizeRunIdentity(target.run);
  requireInteger(target.generation, 'target.generation');
  return target;
}

export function viewDecision({ target, release, request }: Omit<ViewDecision, 'carrier'>): ViewDecision {
  assertLeaseTarget(target);
  if (typeof release !== 'function') throw new TypeError('View decision release must be a function');
  return Object.freeze({
    carrier: VIEW_CARRIER,
    target,
    release,
    request,
  });
}

export function browserFallback(reason: FallbackReason, details: Omit<FallbackDecision, 'carrier' | 'fallbackReason'> = {}): FallbackDecision {
  if (!FALLBACK_REASON_VALUES.has(reason)) {
    throw new TypeError(`unknown View fallback reason: ${reason}`);
  }
  return Object.freeze({
    carrier: BROWSER_CARRIER,
    fallbackReason: reason,
    ...details,
  });
}

export function isFallbackDecision(value: unknown): value is FallbackDecision {
  return Boolean(value && typeof value === 'object' && 'carrier' in value && value.carrier === BROWSER_CARRIER && 'fallbackReason' in value && FALLBACK_REASON_VALUES.has(value.fallbackReason as FallbackReason));
}

export function serializeTarget(target: LeaseTarget) {
  assertLeaseTarget(target);
  // Never serialize a page object, debugger endpoint, or cleanup callback.
  return {
    leaseId: target.leaseId,
    targetId: target.targetId,
    kind: target.kind,
    surfaceId: target.surfaceId,
    run: { ...target.run },
    generation: target.generation,
    width: target.width,
    height: target.height,
    gpu: target.gpu,
  };
}

export function deserializeRequest(value: LeaseRequest) {
  return createLeaseRequest(value);
}
