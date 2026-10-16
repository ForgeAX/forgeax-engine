import type { CarrierCapabilities, ViewPlatform, ViewPlatformPage, LeaseTarget, RunIdentity, NormalizedLeaseRequest, LeaseRequest, ReleaseResult, FallbackReason } from './carrier-contract.ts';
import { randomUUID } from 'node:crypto';

import {
  FALLBACK_REASONS,
  VIEW_CARRIER,
  VIEW_PROTOCOL,
  VIEW_PROTOCOL_VERSION,
  browserFallback,
  createLeaseRequest,
  sameRun,
  serializeTarget,
  viewDecision,
} from './carrier-contract.ts';
import { disposeResource } from './effects.ts';


type Reservation = { leaseId: string; request: NormalizedLeaseRequest; controller: AbortController; state: 'allocating' | 'lost' | 'active' | 'releasing' | 'released'; cancelled: boolean; page: ViewPlatformPage | null; target: LeaseTarget | null; pageLost: string | null; releasePromise?: Promise<ReleaseResult> };
const DEFAULT_CAPABILITIES: Readonly<CarrierCapabilities> = Object.freeze({
  protocolVersion: VIEW_PROTOCOL_VERSION,
  ready: true,
  supportsPage: true,
  // `auto` is safe as an intent; hardware/software require an explicit
  // platform probe from the embedding runtime.
  gpuModes: ['auto'] as const,
  maxWidth: 8192,
  maxHeight: 8192,
  canvasSizing: 'fixed',
});

function copyCapabilities(capabilities: Partial<CarrierCapabilities> = {}) {
  const merged = {
    ...DEFAULT_CAPABILITIES,
    ...capabilities,
    gpuModes: [...(capabilities.gpuModes ?? DEFAULT_CAPABILITIES.gpuModes)],
  };
  if (!Number.isInteger(merged.protocolVersion)) merged.protocolVersion = VIEW_PROTOCOL_VERSION;
  return Object.freeze(merged);
}

function targetMatches(target: LeaseTarget, active: Reservation | null): active is Reservation {
  return Boolean(
    target &&
      active &&
      target.leaseId === active.leaseId &&
      target.targetId === active.target?.targetId &&
      target.surfaceId === active.target?.surfaceId &&
      target.generation === active.request.generation &&
      sameRun(target.run, active.request.run),
  );
}

function allocationFailureReason(error: unknown): FallbackReason {
  if (error && typeof error === 'object' && 'fallbackReason' in error && Object.values(FALLBACK_REASONS).includes(error.fallbackReason as FallbackReason)) {
    return error.fallbackReason as FallbackReason;
  }
  return FALLBACK_REASONS.ALLOCATION_FAILED;
}

/**
 * Owns exactly one display page at a time. A private pending reservation makes
 * allocation atomic, while public occupancy is admitted only after the
 * platform confirms that the Frontend Fiber surface is ready.
 */
export class ViewResourceBroker {
  declare readonly platform: ViewPlatform;
  declare readonly capabilityOverrides: Partial<CarrierCapabilities>;
  declare capabilities: CarrierCapabilities;
  declare readonly idFactory: () => string;
  declare readonly clock: () => number;
  declare active: Reservation | null;
  declare pending: Reservation | null;
  declare readonly latestGenerations: Map<string, number>;
  declare readonly listeners: Set<(status: ReturnType<ViewResourceBroker['handshake']>) => void>;
  declare disposing: boolean;
  constructor({ platform, capabilities, idFactory = randomUUID, clock = () => Date.now() }: { platform?: ViewPlatform; capabilities?: Partial<CarrierCapabilities>; idFactory?: () => string; clock?: () => number } = {}) {
    if (!platform || typeof platform.createPage !== 'function') {
      throw new TypeError('ViewResourceBroker requires a platform.createPage implementation');
    }
    this.platform = platform;
    // Keep caller-supplied limits and protocol overrides separate from the
    // platform's live readiness. A browser can lose its page after
    // the broker has been constructed, so a startup snapshot must never be
    // used as a durable "ready" claim.
    this.capabilityOverrides = { ...(capabilities ?? {}) };
    this.capabilities = copyCapabilities({
      ...(typeof platform.getCapabilities === 'function' ? platform.getCapabilities() : {}),
      ...this.capabilityOverrides,
    });
    this.idFactory = idFactory;
    this.clock = clock;
    this.active = null;
    this.pending = null;
    this.latestGenerations = new Map();
    this.listeners = new Set();
    this.disposing = false;
  }

  /** Subscribe to status transitions owned by this broker. */
  subscribe(listener: (status: ReturnType<ViewResourceBroker["handshake"]>) => void) {
    if (typeof listener !== 'function') throw new TypeError('broker status listener must be a function');
    this.listeners.add(listener);
    listener(this.handshake());
    return () => this.listeners.delete(listener);
  }

  notify() {
    const snapshot = this.handshake();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Status observers must not change lease admission or cleanup.
      }
    }
  }

  refreshCapabilities() {
    if (typeof this.platform.getCapabilities !== 'function') return this.capabilities;
    const live = this.platform.getCapabilities() ?? {};
    const overrides = { ...this.capabilityOverrides };
    // Readiness, page support, and GPU modes describe the current platform,
    // not broker configuration.  Let a lost window withdraw those claims.
    delete overrides.ready;
    delete overrides.supportsPage;
    delete overrides.gpuModes;
    this.capabilities = copyCapabilities({ ...live, ...overrides });
    return this.capabilities;
  }

  handshake() {
    const capabilities = this.refreshCapabilities();
    return {
      protocol: VIEW_PROTOCOL,
      protocolVersion: VIEW_PROTOCOL_VERSION,
      state: this.disposing
        ? 'stopping'
        : !capabilities.ready || !capabilities.supportsPage
          ? 'unavailable'
          : this.active
            ? 'occupied'
            : this.pending
              ? 'allocating'
            : 'ready',
      capabilities: { ...capabilities, gpuModes: [...capabilities.gpuModes] },
      occupancy: this.active
        ? {
            leaseId: this.active.leaseId,
            run: { ...this.active.request.run },
            generation: this.active.request.generation,
            ...(this.active.target?.targetId === undefined
              ? {}
              : { targetId: this.active.target.targetId }),
            ...(this.active.target?.targetId === undefined
              ? {}
              : { target: serializeTarget(this.active.target) }),
          }
        : null,
    };
  }

  get occupied() {
    return this.active !== null;
  }

  capabilityFailure(request: NormalizedLeaseRequest) {
    const capabilities = this.refreshCapabilities();
    if (this.disposing || !capabilities.ready || !capabilities.supportsPage) {
      return 'View platform is not ready';
    }
    if (capabilities.protocolVersion !== VIEW_PROTOCOL_VERSION) {
      const error = Object.assign(new Error(`View protocol ${capabilities.protocolVersion} is incompatible`), { fallbackReason: FALLBACK_REASONS.PROTOCOL_UNSUPPORTED });
      throw error;
    }
    if (!capabilities.gpuModes.includes(request.gpu)) {
      return `View does not support GPU mode ${request.gpu}`;
    }
    if (request.width > capabilities.maxWidth || request.height > capabilities.maxHeight) {
      return `requested canvas ${request.width}x${request.height} exceeds View limits`;
    }
    return null;
  }

  async allocate(input: LeaseRequest, { signal }: { signal?: AbortSignal } = {}) {
    const request = createLeaseRequest(input);
    if (request.headless) return browserFallback(FALLBACK_REASONS.HEADLESS_REQUESTED);
    if (signal?.aborted || this.disposing) return browserFallback(FALLBACK_REASONS.CANCELLED);

    const latest = this.latestGenerations.get(request.run.key);
    if (latest !== undefined && request.generation < latest) {
      return browserFallback(FALLBACK_REASONS.STALE_GENERATION, { currentGeneration: latest });
    }
    // Record a newer generation before any asynchronous platform work.  An
    // older late completion can therefore never become the active target.
    if (latest === undefined || request.generation > latest) {
      this.latestGenerations.set(request.run.key, request.generation);
    }

    try {
      const capabilityMessage = this.capabilityFailure(request);
      if (capabilityMessage) {
        return browserFallback(FALLBACK_REASONS.CAPABILITY_MISMATCH, { message: capabilityMessage });
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'fallbackReason' in error && error.fallbackReason === FALLBACK_REASONS.PROTOCOL_UNSUPPORTED) {
        return browserFallback(FALLBACK_REASONS.PROTOCOL_UNSUPPORTED, { message: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
    if (this.active || this.pending) {
      const occupied = this.active ?? this.pending;
      return browserFallback(FALLBACK_REASONS.OCCUPIED, {
        occupiedBy: { ...occupied!.request.run },
      });
    }

    const leaseId = this.idFactory();
    const controller = new AbortController();
    const reservation: Reservation = {
      leaseId,
      request,
      controller,
      state: 'allocating',
      cancelled: false,
      page: null,
      target: null,
      pageLost: null,
    };
    // Reserve allocation atomically without publishing false occupancy. The
    // platform resolves only after the display Fiber iframe is available.
    this.pending = reservation;
    this.notify();
    const onAbort = () => {
      reservation.cancelled = true;
      controller.abort();
    };
    const onPageLost = (reason?: string) => {
      if (this.active !== reservation && this.pending !== reservation) return;
      reservation.pageLost = reason ?? 'page-lost';
      reservation.state = 'lost';
      // The platform has already destroyed the page.  Drop occupancy now so
      // a new request can be admitted while old target handles fail closed.
      this.active = null;
      if (this.pending === reservation) this.pending = null;
      this.notify();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let page: ViewPlatformPage | undefined;
    try {
      page = await this.platform.createPage({
        leaseId,
        run: request.run,
        generation: request.generation,
        width: request.width,
        height: request.height,
        gpu: request.gpu,
        signal: controller.signal,
        onLost: onPageLost,
      });
      if (reservation.pageLost) {
        await disposeResource(page);
        return browserFallback(FALLBACK_REASONS.TARGET_LOST, { message: reservation.pageLost });
      }
      if (reservation.cancelled || controller.signal.aborted || this.pending !== reservation || this.disposing) {
        await disposeResource(page);
        return browserFallback(FALLBACK_REASONS.CANCELLED);
      }
      if (
        !page ||
        (typeof page.targetId !== 'string' && typeof page.targetId !== 'number') ||
        typeof page.surfaceId !== 'string' ||
        !/^[_A-Za-z][_A-Za-z0-9-]*$/.test(page.surfaceId)
      ) {
        throw new Error('platform did not return a stable page target and surface id');
      }
      reservation.page = page;
      reservation.state = 'active';
      reservation.target = Object.freeze({
        leaseId,
        targetId: String(page.targetId),
        kind: page.kind ?? 'browser-page',
        surfaceId: page.surfaceId,
        run: request.run,
        generation: request.generation,
        width: request.width,
        height: request.height,
        gpu: request.gpu,
        allocatedAt: this.clock(),
      });
      this.pending = null;
      this.active = reservation;
      this.notify();
      return viewDecision({
        target: reservation.target,
        request,
        release: (reason = 'engine-release') => this.release(reservation.target!, reason),
      });
    } catch (error) {
      if (page) await disposeResource(page).catch(() => {});
      if (reservation.cancelled || controller.signal.aborted) {
        return browserFallback(FALLBACK_REASONS.CANCELLED);
      }
      return browserFallback(allocationFailureReason(error), { message: error instanceof Error ? error.message : String(error) });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.pending === reservation) this.pending = null;
      if (this.active === reservation && reservation.state !== 'active') this.active = null;
      if (this.active === null) this.notify();
    }
  }

  /** Return the exact platform page for an in-process Engine adapter. */
  getPage(target: LeaseTarget) {
    if (!targetMatches(target, this.active) || this.active.state !== 'active') {
      throw new Error('View target is not an active lease');
    }
    // A platform resource may carry the browser Page separately so its
    // lease-owned dispose method cannot accidentally close the user's page.
    return this.active.page!.page;
  }

  /** Return the exact Engine execution realm bound to the active target. */
  getExecution(target: LeaseTarget) {
    if (!targetMatches(target, this.active) || this.active.state !== 'active') {
      throw new Error('View target is not an active lease');
    }
    const execution = this.active.page!.execution;
    if (!execution || execution.ownerPage !== this.getPage(target)) {
      throw new Error('View target does not expose an Engine execution realm');
    }
    return execution;
  }

  async release(target: LeaseTarget, reason = 'engine-release'): Promise<ReleaseResult> {
    const reservation = this.active;
    if (!reservation) return { released: false, reason: 'not-active' };
    if (!targetMatches(target, reservation)) return { released: false, reason: 'lease-mismatch' };
    if (reservation.releasePromise) return reservation.releasePromise;

    reservation.state = 'releasing';
    reservation.cancelled = true;
    reservation.controller.abort();
    this.notify();
    reservation.releasePromise = (async () => {
      try {
        await disposeResource(reservation.page);
        return { released: true, leaseId: reservation.leaseId, reason };
      } finally {
        reservation.state = 'released';
        if (this.active === reservation) {
          this.active = null;
          this.notify();
        }
      }
    })();
    return reservation.releasePromise;
  }

  async cancel(run: RunIdentity, generation: number) {
    const reservation = this.active ?? this.pending;
    if (!reservation || !sameRun(run, reservation.request.run) || reservation.request.generation !== generation) {
      return { released: false, reason: 'not-active' };
    }
    if (reservation.target) return this.release(reservation.target, 'cancelled');
    reservation.cancelled = true;
    reservation.controller.abort();
    if (this.pending === reservation) this.pending = null;
    this.notify();
    return { released: true, leaseId: reservation.leaseId, reason: 'cancelled' };
  }

  async dispose() {
    if (this.disposing) return;
    this.disposing = true;
    this.notify();
    const reservation = this.active ?? this.pending;
    if (reservation?.target) await this.release(reservation.target, 'broker-dispose');
    else if (reservation) {
      reservation.cancelled = true;
      reservation.controller.abort();
      if (this.pending === reservation) this.pending = null;
      if (this.active === reservation) this.active = null;
    }
    await this.platform.dispose?.();
  }
}

export { DEFAULT_CAPABILITIES };
