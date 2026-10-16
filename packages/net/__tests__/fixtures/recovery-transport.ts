import { FakeClock, RecoveryResourceCounter } from './fake-clock';

export type RecoveryPacketKind = 'resume' | 'baseline' | 'delta' | 'ack' | 'reject';

export interface RecoveryPacket {
  readonly kind: RecoveryPacketKind;
  readonly sessionId: number;
  readonly epoch: number;
  readonly sequence: number;
  readonly mutationId?: string;
}

export type PacketFault = 'immediate' | 'delayed' | 'duplicate';

export interface RecoveryTransportEndpoint {
  readonly peerId: number;
  readonly closed: boolean;
  send(packet: RecoveryPacket): void;
  onPacket(listener: (packet: RecoveryPacket) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface RecoveryConnector {
  connect(signal: AbortSignal): Promise<RecoveryTransportEndpoint>;
  acceptPendingConnect(): RecoveryTransportEndpoint;
  abortPendingConnects(): void;
}

interface PendingConnect {
  readonly resolve: (endpoint: RecoveryTransportEndpoint) => void;
  readonly reject: (cause: Error) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly releasePending: () => void;
  readonly releaseListener: () => void;
}

interface DelayedPacket {
  readonly endpoint: RecoveryEndpoint;
  readonly packet: RecoveryPacket;
}

class RecoveryEndpoint implements RecoveryTransportEndpoint {
  readonly #transport: RecoveryTransportHarness;
  readonly #releaseSocket: () => void;
  readonly #packetListeners = new Map<
    (packet: RecoveryPacket) => void,
    () => void
  >();
  readonly #closeListeners = new Map<() => void, () => void>();
  readonly peerId: number;
  #closed = false;

  constructor(transport: RecoveryTransportHarness, peerId: number, releaseSocket: () => void) {
    this.#transport = transport;
    this.peerId = peerId;
    this.#releaseSocket = releaseSocket;
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(packet: RecoveryPacket): void {
    if (this.#closed) throw new Error(`endpoint ${this.peerId} is closed`);
    this.#transport.recordSent(this, packet);
  }

  onPacket(listener: (packet: RecoveryPacket) => void): () => void {
    if (this.#closed) throw new Error(`endpoint ${this.peerId} is closed`);
    const release = this.#transport.resources.acquire('listeners');
    this.#packetListeners.set(listener, release);
    return () => {
      const storedRelease = this.#packetListeners.get(listener);
      if (storedRelease === undefined) return;
      this.#packetListeners.delete(listener);
      storedRelease();
    };
  }

  onClose(listener: () => void): () => void {
    if (this.#closed) throw new Error(`endpoint ${this.peerId} is closed`);
    const release = this.#transport.resources.acquire('listeners');
    this.#closeListeners.set(listener, release);
    return () => {
      const storedRelease = this.#closeListeners.get(listener);
      if (storedRelease === undefined) return;
      this.#closeListeners.delete(listener);
      storedRelease();
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners.keys()) listener();
    for (const release of this.#packetListeners.values()) release();
    for (const release of this.#closeListeners.values()) release();
    this.#packetListeners.clear();
    this.#closeListeners.clear();
    this.#releaseSocket();
  }

  deliver(packet: RecoveryPacket): void {
    if (this.#closed) return;
    for (const listener of this.#packetListeners.keys()) listener(packet);
  }
}

export class RecoveryTransportHarness {
  readonly clock: FakeClock;
  readonly resources: RecoveryResourceCounter;
  readonly #pending: PendingConnect[] = [];
  readonly #endpoints = new Set<RecoveryEndpoint>();
  readonly #delayed: DelayedPacket[] = [];
  readonly #sent: Array<{ readonly peerId: number; readonly packet: RecoveryPacket }> = [];
  #nextPeerId = 1;

  constructor() {
    this.resources = new RecoveryResourceCounter();
    this.clock = new FakeClock(this.resources);
  }

  readonly connector: RecoveryConnector = {
    connect: (signal) => this.connect(signal),
    acceptPendingConnect: () => this.acceptPendingConnect(),
    abortPendingConnects: () => this.abortPendingConnects(),
  };

  get pendingConnectCount(): number {
    return this.#pending.length;
  }

  get sentPackets(): readonly { readonly peerId: number; readonly packet: RecoveryPacket }[] {
    return this.#sent;
  }

  connect(signal: AbortSignal): Promise<RecoveryTransportEndpoint> {
    if (signal.aborted) return Promise.reject(new Error('connect aborted before scheduling'));
    return new Promise((resolve, reject) => {
      const releasePending = this.resources.acquire('pendingConnects');
      const releaseListener = this.resources.acquire('listeners');
      const pending: PendingConnect = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          this.removePending(pending);
          reject(new Error('connect aborted'));
        },
        releasePending,
        releaseListener,
      };
      this.#pending.push(pending);
      signal.addEventListener('abort', pending.onAbort, { once: true });
    });
  }

  acceptPendingConnect(): RecoveryTransportEndpoint {
    const pending = this.#pending.shift();
    if (pending === undefined) throw new Error('no pending connection to accept');
    this.finishPending(pending);
    const endpoint = this.openEndpoint();
    pending.resolve(endpoint);
    return endpoint;
  }

  abortPendingConnects(): void {
    for (const pending of [...this.#pending]) {
      this.removePending(pending);
      pending.reject(new Error('pending connections aborted'));
    }
  }

  inject(endpoint: RecoveryTransportEndpoint, packet: RecoveryPacket, fault: PacketFault = 'immediate'): void {
    const target = this.asEndpoint(endpoint);
    if (fault === 'delayed') {
      this.#delayed.push({ endpoint: target, packet });
      return;
    }
    target.deliver(packet);
    if (fault === 'duplicate') target.deliver(packet);
  }

  injectGap(endpoint: RecoveryTransportEndpoint, packet: RecoveryPacket): void {
    this.inject(endpoint, { ...packet, sequence: packet.sequence + 1 });
  }

  injectOldEpoch(endpoint: RecoveryTransportEndpoint, packet: RecoveryPacket, epoch: number): void {
    this.inject(endpoint, { ...packet, epoch });
  }

  flushDelayed(): void {
    const delayed = this.#delayed.splice(0);
    for (const entry of delayed) entry.endpoint.deliver(entry.packet);
  }

  closeEndpoint(endpoint: RecoveryTransportEndpoint): void {
    this.asEndpoint(endpoint).close();
  }

  closeAll(): void {
    for (const endpoint of [...this.#endpoints]) endpoint.close();
    this.abortPendingConnects();
    this.flushDelayed();
  }

  recordSent(endpoint: RecoveryEndpoint, packet: RecoveryPacket): void {
    this.#sent.push({ peerId: endpoint.peerId, packet });
  }

  private openEndpoint(): RecoveryEndpoint {
    const releaseSocket = this.resources.acquire('sockets');
    const endpoint = new RecoveryEndpoint(this, this.#nextPeerId++, releaseSocket);
    this.#endpoints.add(endpoint);
    return endpoint;
  }

  private asEndpoint(endpoint: RecoveryTransportEndpoint): RecoveryEndpoint {
    if (!(endpoint instanceof RecoveryEndpoint)) throw new Error('endpoint belongs to another harness');
    return endpoint;
  }

  private finishPending(pending: PendingConnect): void {
    pending.signal.removeEventListener('abort', pending.onAbort);
    pending.releasePending();
    pending.releaseListener();
  }

  private removePending(pending: PendingConnect): void {
    const index = this.#pending.indexOf(pending);
    if (index < 0) return;
    this.#pending.splice(index, 1);
    this.finishPending(pending);
  }
}
