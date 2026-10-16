import type { ViewResourceBroker } from './page-broker.ts';
import type { ExecutionTarget, FallbackDecision, LeaseRequest, LeaseTarget, ReleaseResult, ViewDecision } from './carrier-contract.ts';
import type { Page } from 'playwright';
type BorrowedDecision = Omit<ViewDecision, 'carrier'> & { carrier: 'borrowed' };
type Attachment = { page: Page; execution: ExecutionTarget; close: (reason?: string) => void | Promise<unknown> };
export type ViewCarrierAdapterOptions = { broker?: ViewResourceBroker; attachTarget?: (target: LeaseTarget) => Attachment | Promise<Attachment> };
import {
  FALLBACK_REASONS,
  BROWSER_CARRIER,
  VIEW_CARRIER,
  VIEW_PROTOCOL_VERSION,
  browserFallback,
  createLeaseRequest,
} from './carrier-contract.ts';

/**
 * The narrow Engine-facing seam.  Engine owns browser attachment, navigation,
 * observation, capture, and service lifetime; this adapter only selects and
 * releases a View carrier by its authenticated target identity.
 */
export class ViewCarrierAdapter {
  declare readonly broker: ViewResourceBroker;
  declare readonly attachTarget: ViewCarrierAdapterOptions["attachTarget"];
  constructor({ broker, attachTarget }: ViewCarrierAdapterOptions = {}) {
    if (!broker || typeof broker.allocate !== 'function' || typeof broker.release !== 'function') {
      throw new TypeError('View carrier adapter requires the in-process View resource broker');
    }
    this.broker = broker;
    this.attachTarget = attachTarget;
  }

  async select(input: LeaseRequest, { signal }: { signal?: AbortSignal } = {}): Promise<BorrowedDecision | FallbackDecision> {
    const request = createLeaseRequest(input);
    // A headless request must not even touch the View broker.
    if (request.headless) return browserFallback(FALLBACK_REASONS.HEADLESS_REQUESTED);
    // The broker is the sole carrier authority. It owns admission, target
    // identity, capability checks, and the exact platform lease.
    const decision = await this.broker.allocate(request, { signal });
    return decision.carrier === VIEW_CARRIER
      ? { ...decision, carrier: 'borrowed' }
      : decision;
  }

  async release(decision: BorrowedDecision | FallbackDecision, reason = 'engine-release'): Promise<ReleaseResult> {
    if (!decision || decision.carrier !== 'borrowed') return { released: false, reason: 'not-borrowed' };
    return decision.release(reason);
  }

  /**
   * Optional local-process attachment hook. No browser connection implementation
   * is hidden here; the Engine browser layer supplies its public attachment
   * implementation and receives the exact allocated target handle.
   */
  async attach(decision: BorrowedDecision | FallbackDecision) {
    if (!decision || decision.carrier !== 'borrowed') return decision;
    if (typeof this.attachTarget !== 'function') {
      throw new Error('Engine adapter must provide attachTarget for View pages');
    }
    const attached = await this.attachTarget(decision.target);
    if (
      !attached ||
      typeof attached !== 'object' ||
      !attached.page ||
      !attached.execution ||
      typeof attached.close !== 'function'
    ) {
      throw new TypeError(
        'View attachTarget must return an explicit owner page, execution realm, and close handle',
      );
    }
    if (attached.execution.kind === 'frame') {
      const surface = attached.page.locator(attached.execution.surfaceSelector);
      const identity = await surface.evaluate((element: HTMLElement) => ({
        id: element.id,
        leaseId: element.dataset.forgeaxViewLeaseId,
        generation: element.dataset.forgeaxViewGeneration,
      }));
      if (identity.id !== decision.target.surfaceId ||
          identity.leaseId !== decision.target.leaseId ||
          identity.generation !== String(decision.target.generation)) {
        await attached.close('view-surface-identity-mismatch');
        throw new Error('View display surface no longer owns the selected lease');
      }
    }
    return {
      page: attached.page,
      target: decision.target,
      execution: attached.execution,
      close: attached.close,
    };
  }
}

export function createViewCarrierAdapter(options: ViewCarrierAdapterOptions) {
  return new ViewCarrierAdapter(options);
}

export const VIEW_ENGINE_CARRIER_CONTRACT = Object.freeze({
  carrier: 'borrowed',
  fallbackCarrier: BROWSER_CARRIER,
  protocolVersion: VIEW_PROTOCOL_VERSION,
  targetIdentity: 'leaseId + targetId + surfaceId + run identity + generation',
  ownership: 'Engine owns attachment, navigation, observation, capture, and service lifetime',
});
