// @forgeax/engine-net -- memory endpoint implementation.
// Deterministic memory backend for the NetEndpoint contract.
// (requirements AC-03, plan-strategy D-3)

import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import type { EndpointEvent, NetEndpoint, NetEndpointConnector, PeerId } from './endpoint';
import type { EndpointError as EndpointErrorType } from './errors';
import { EndpointError } from './errors';

interface InternalState {
  delayNext: boolean;
  duplicateNext: boolean;
  malformNext: boolean;
}

class MemoryEndpoint implements NetEndpoint {
  readonly _peerId: PeerId;
  _remote: MemoryEndpoint | null = null;
  _closed = false;
  _remoteConnected = false;
  _incoming: EndpointEvent[] = [];
  _delayed: EndpointEvent[] = [];
  _state: InternalState = { delayNext: false, duplicateNext: false, malformNext: false };

  constructor(peerId: PeerId) {
    this._peerId = peerId;
  }

  poll(): EndpointEvent[] {
    if (this._closed) return [];
    const events = this._incoming.splice(0);
    this._incoming = this._delayed.splice(0);
    return events;
  }

  send(peerId: PeerId, data: Uint8Array): Result<void, EndpointErrorType> {
    if (this._closed) {
      return err(
        new EndpointError({
          code: 'already-closed',
          detail: { cause: 'endpoint is closed' },
        }),
      );
    }
    if (!this._remote || this._remote._peerId !== peerId) {
      return err(
        new EndpointError({
          code: 'peer-not-found',
          detail: { peerId },
        }),
      );
    }
    if (!this._remoteConnected) {
      return err(
        new EndpointError({
          code: 'connection-closed',
          detail: { peerId },
        }),
      );
    }

    const deliver = (bytes: Uint8Array) => {
      if (this._state.delayNext) {
        this._remote?._delayed.push({ kind: 'message', peerId: this._peerId, data: bytes });
        this._state.delayNext = false;
      } else {
        this._remote?._incoming.push({ kind: 'message', peerId: this._peerId, data: bytes });
      }
    };

    if (this._state.malformNext) {
      const corrupted = new Uint8Array(data);
      if (corrupted.length > 0) {
        const firstByte = corrupted[0];
        if (firstByte !== undefined) corrupted[0] = firstByte ^ 0xff;
      }
      deliver(corrupted);
      this._state.malformNext = false;
    } else {
      deliver(data);
      if (this._state.duplicateNext) {
        this._state.duplicateNext = false;
        if (this._state.delayNext) {
          this._remote?._delayed.push({ kind: 'message', peerId: this._peerId, data });
          this._state.delayNext = false;
        } else {
          this._remote?._incoming.push({ kind: 'message', peerId: this._peerId, data });
        }
      }
    }

    return ok(undefined);
  }

  disconnect(peerId: PeerId): Result<void, EndpointErrorType> {
    if (!this._remote || this._remote._peerId !== peerId)
      return err(
        new EndpointError({
          code: 'peer-not-found',
          detail: { peerId },
        }),
      );
    if (this._closed || !this._remoteConnected)
      return err(
        new EndpointError({
          code: 'connection-closed',
          detail: { peerId },
        }),
      );
    this._remoteConnected = false;
    this._delayed = [];
    this._incoming.push({ kind: 'peer-disconnected', peerId });
    if (!this._remote._closed) {
      this._remote._remoteConnected = false;
      this._remote._delayed = [];
      this._remote._incoming.push({ kind: 'peer-disconnected', peerId: this._peerId });
    }
    return ok(undefined);
  }

  close(): Result<void, EndpointErrorType> {
    if (this._closed) {
      return err(
        new EndpointError({
          code: 'already-closed',
          detail: { cause: 'endpoint is already closed' },
        }),
      );
    }
    if (this._remote && this._remoteConnected) this.disconnect(this._remote._peerId);
    this._closed = true;
    return ok(undefined);
  }

  _forceDisconnect(): void {
    if (this._remote && this._remoteConnected) this.disconnect(this._remote._peerId);
  }
}

export function createMemoryEndpointPair(): [NetEndpoint, NetEndpoint] {
  const epA = new MemoryEndpoint(1 as PeerId);
  const epB = new MemoryEndpoint(2 as PeerId);
  epA._remote = epB;
  epB._remote = epA;
  epA._remoteConnected = true;
  epB._remoteConnected = true;
  epA._incoming.push({ kind: 'peer-connected', peerId: 2 as PeerId });
  epB._incoming.push({ kind: 'peer-connected', peerId: 1 as PeerId });
  return [epA, epB];
}

export interface MemoryFaultController {
  delayNextDelivery(ms: number): void;
  duplicateNextDelivery(): void;
  malformNextDelivery(): void;
  disconnectPeer(endpoint: NetEndpoint): void;
}

export function createMemoryEndpointPairWithController(): {
  readonly endpoints: [NetEndpoint, NetEndpoint];
  readonly controller: MemoryFaultController;
} {
  const [epA, epB] = createMemoryEndpointPair();

  const controller: MemoryFaultController = {
    delayNextDelivery(_ms: number): void {
      (epA as MemoryEndpoint)._state.delayNext = true;
    },
    duplicateNextDelivery(): void {
      (epA as MemoryEndpoint)._state.duplicateNext = true;
    },
    malformNextDelivery(): void {
      (epA as MemoryEndpoint)._state.malformNext = true;
    },
    disconnectPeer(endpoint: NetEndpoint): void {
      (endpoint as MemoryEndpoint)._forceDisconnect();
    },
  };

  return { endpoints: [epA, epB], controller };
}

/** Create a replaceable, realm-neutral connector over a deterministic endpoint factory. */
export function createMemoryEndpointConnector(
  createEndpoint: () => NetEndpoint,
): NetEndpointConnector {
  return {
    connect(signal) {
      if (signal.aborted)
        return Promise.resolve(
          err(
            new EndpointError({
              code: 'connection-failed',
              detail: { address: 'memory', cause: 'connect aborted' },
            }),
          ),
        );
      return Promise.resolve(ok(createEndpoint()));
    },
  };
}
