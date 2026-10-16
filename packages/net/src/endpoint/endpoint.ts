// @forgeax/engine-net -- transport-only endpoint contract.
//
// NetEndpoint is the minimum transport seam: complete bytes, actual PeerId,
// and connect/disconnect lifecycle. No ECS, profile, or codec dependency.
// Reliable ordered delivery per peer or explicit connection failure.
// (requirements AC-02, plan-strategy D-3)

import type { Result } from '@forgeax/engine-types';
import type { EndpointError } from './errors';

// ---------------------------------------------------------------------------
// PeerId -- opaque, branded peer identity (transport-level, not NetEntityId)
// ---------------------------------------------------------------------------

declare const __peerIdBrand: unique symbol;

/** Opaque transport-level peer identity. Never a plain number. */
export type PeerId = number & { readonly [__peerIdBrand]: true };

// ---------------------------------------------------------------------------
// Endpoint events
// ---------------------------------------------------------------------------

/** Transport-level event emitted by NetEndpoint.poll(). */
export type EndpointEvent =
  | { readonly kind: 'peer-connected'; readonly peerId: PeerId }
  | { readonly kind: 'peer-disconnected'; readonly peerId: PeerId }
  | { readonly kind: 'message'; readonly peerId: PeerId; readonly data: Uint8Array };

// ---------------------------------------------------------------------------
// NetEndpoint -- transport-only contract
// ---------------------------------------------------------------------------

/**
 * Transport-only endpoint contract.
 *
 * Delivers complete Uint8Array messages with actual PeerId and connect/disconnect
 * lifecycle. Reliable ordered delivery per peer or explicit connection failure.
 * No ECS, profile, or codec knowledge.
 */
export interface NetEndpoint {
  /** Poll for pending events (connect, disconnect, message). Returns empty array when idle. */
  poll(): EndpointEvent[];

  /** Send a complete message to a connected peer. Returns structured error on failure. */
  send(peerId: PeerId, data: Uint8Array): Result<void, EndpointError>;

  /** Disconnect one peer without closing other peers or the listener. Both ends observe a terminal event, with no subsequent messages from that peer. */
  disconnect(peerId: PeerId): Result<void, EndpointError>;

  /** Close the endpoint. No further send/poll should succeed after close. */
  close(): Result<void, EndpointError>;
}

/**
 * Realm-neutral capability for creating a replacement endpoint.
 * Session policy, retry bounds, and replication semantics remain in net.
 */
export interface NetEndpointConnector {
  connect(signal: AbortSignal): Promise<Result<NetEndpoint, EndpointError>>;
}
