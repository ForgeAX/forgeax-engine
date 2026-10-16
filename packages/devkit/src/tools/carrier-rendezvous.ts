import {
  type CarrierOffer,
  type CarrierStateMachine,
  createCarrierStateMachine,
} from '@forgeax/engine-tool-runtime';

export { type CarrierProvider, createCarrierProvider } from './carrier-provider.js';

export interface CarrierRendezvousOptions {
  readonly presentation: 'hidden' | 'visible';
  readonly projectId: string;
  readonly consumerId: string;
  readonly now: number;
  readonly endpoint?: string;
  readonly ttlMs?: number;
}

export interface CarrierRendezvous extends CarrierStateMachine {
  readonly lookup: () => CarrierOffer | undefined;
  readonly lookupCount: number;
}

export function createCarrierRendezvous(options: CarrierRendezvousOptions): CarrierRendezvous {
  const machine = createCarrierStateMachine({
    projectId: options.projectId,
    consumerId: options.consumerId,
    endpoint: options.endpoint ?? 'http://127.0.0.1:5740/carrier',
    now: options.now,
    ttlMs: options.ttlMs ?? 30_000,
  });
  let lookupCount = 0;
  const lookup = (): CarrierOffer | undefined => {
    if (options.presentation !== 'visible' || machine.snapshot().state !== 'offered') return;
    lookupCount += 1;
    return machine.offer;
  };
  return {
    ...machine,
    lookup,
    get lookupCount() {
      return lookupCount;
    },
  };
}
