// @forgeax/engine-net -- NetSession host-neutral World integration.

import { err, ok, type Result } from '@forgeax/engine-types';
import type {
  EndpointEvent,
  NetEndpoint,
  NetEndpointConnector,
  PeerId,
} from '../endpoint/endpoint';
import { type EndpointError, isEndpointError } from '../endpoint/errors';
import type { AuthorityCoordinator, ReplicationVisibility } from '../replication/authority';
import { decodeReplicationPacket, encodeReplicationPacket } from '../replication/codec';
import { NetError } from '../replication/errors';
import { DEFAULT_REPLICATION_LIMITS, type ReplicationLimits } from '../replication/profile';
import type {
  ReplicationAckPacket,
  ReplicationApplicationPacket,
  ReplicationDataPacket,
  ReplicationSessionPacket,
} from '../replication/protocol';
import { applyReplicationPacket, type ReplicaCoordinator } from '../replication/replica';
import {
  createSessionId,
  DEFAULT_NET_RECOVERY_POLICY,
  isTerminalNetSessionState,
  type NetRecoveryOutcome,
  type NetRecoveryPolicy,
  type NetRecoverySnapshot,
  type NetSessionFailure,
  type NetSessionState,
  resolveNetRecoveryPolicy,
  type SessionId,
  transitionNetSessionState,
} from './recovery';

export interface PeerSnapshot {
  readonly peerIds: ReadonlyArray<PeerId>;
  readonly connected: boolean;
}

export interface SessionSnapshot {
  readonly sessionIds: ReadonlyArray<SessionId>;
  readonly connected: boolean;
}

export interface NetSessionClock {
  readonly now: () => number;
  readonly schedule: (delayMs: number, callback: () => void) => { cancel(): void };
}

export type NetSessionResourceCounts = NetRecoverySnapshot['ownedResources'];

export interface NetSessionConfig {
  readonly endpoint?: NetEndpoint;
  readonly connector?: NetEndpointConnector;
  readonly sessionId?: SessionId | number;
  readonly recovery?: Partial<NetRecoveryPolicy>;
  readonly clock?: NetSessionClock;
  readonly maxRawMessages: number;
}

export interface ReplicationPeerSnapshot {
  readonly peerId: PeerId;
  readonly sessionId: SessionId;
  readonly epoch: number;
  readonly sequence: number;
  readonly acknowledgedSequence: number;
  readonly pendingPackets: number;
}

interface PeerPublication {
  readonly sessionId: SessionId;
  epoch: number;
  sequence: number;
  acknowledgedSequence: number;
  readonly ledger: Map<number, { readonly bytes: Uint8Array; retries: number; retryAt: number }>;
}

export interface RawMessage {
  readonly peerId: PeerId;
  readonly sessionId: SessionId;
  readonly data: Uint8Array;
}

const defaultClock: NetSessionClock = {
  now: () => Date.now(),
  schedule: (delayMs, callback) => {
    const id = globalThis.setTimeout(callback, delayMs);
    return { cancel: () => globalThis.clearTimeout(id) };
  },
};

function recoveryFailure(reason: string): NetError {
  return new NetError({
    code: 'recovery-rejected',
    expected: 'a recoverable NetSession lifecycle operation',
    hint: 'inspect the current snapshot and retire the session after terminal failure',
    detail: { reason },
  });
}

function initialState(sessionId: SessionId, endpoint: NetEndpoint | undefined): NetSessionState {
  return endpoint === undefined
    ? { kind: 'connecting', sessionId }
    : { kind: 'resyncing', sessionId, epoch: 0 };
}

export class NetSession {
  #endpoint: NetEndpoint | undefined;
  readonly #connector: NetEndpointConnector | undefined;
  readonly #clock: NetSessionClock;
  readonly #policy: NetRecoveryPolicy;
  readonly #sessionId: SessionId;
  readonly #peerIds = new Set<PeerId>();
  readonly #sessionPeers = new Map<SessionId, PeerId>();
  readonly #announcedPeers = new Set<PeerId>();
  #sessionAnnounced = false;
  #rawMessages: RawMessage[] = [];
  readonly #maxRawMessages: number;
  #authority: AuthorityCoordinator | undefined;
  readonly #pendingFullPeers = new Set<PeerId>();
  #replica:
    | { readonly coordinator: ReplicaCoordinator; readonly limits: ReplicationLimits }
    | undefined;
  #state: NetSessionState;
  #lastError: NetSessionFailure | undefined;
  #epoch = 0;
  #sequence = 0;
  #acknowledgedSequence = 0;
  #reconnectAttempts = 0;
  #pendingConnect: AbortController | undefined;
  #retryTimer: { cancel(): void } | undefined;
  #deadlineTimer: { cancel(): void } | undefined;
  readonly #publications = new Map<PeerId, PeerPublication>();
  #visibility: ReplicationVisibility | undefined;
  #deferredEvents: EndpointEvent[] = [];
  #deferReplicaMessages = false;

  constructor(config: NetSessionConfig) {
    this.#endpoint = config.endpoint;
    this.#connector = config.connector;
    this.#clock = config.clock ?? defaultClock;
    this.#maxRawMessages = config.maxRawMessages;
    const resolvedSessionId = this.#resolveSessionId(config.sessionId);
    this.#sessionId = resolvedSessionId.ok ? resolvedSessionId.value : (1 as SessionId);
    const policy = resolveNetRecoveryPolicy(config.recovery);
    this.#policy = policy.ok ? policy.value : DEFAULT_NET_RECOVERY_POLICY;
    this.#state = initialState(this.#sessionId, this.#endpoint);
    if (!resolvedSessionId.ok) this.#setFailure(resolvedSessionId.error);
    else if (!policy.ok) this.#setFailure(policy.error);
  }

  #resolveSessionId(value: SessionId | number | undefined): Result<SessionId, NetError> {
    return createSessionId(value ?? 1);
  }

  #setState(next: NetSessionState): void {
    const transition = transitionNetSessionState(this.#state, next);
    if (transition.ok) {
      this.#state = transition.value;
      return;
    }
    this.#setFailure(transition.error);
  }

  #setFailure(failure: NetSessionFailure): void {
    this.#lastError = failure;
    if (!isTerminalNetSessionState(this.#state))
      this.#setState({ kind: 'failed', sessionId: this.#sessionId, error: failure });
    this.#clearPublications();
    this.#authority = undefined;
    this.#peerIds.clear();
    this.#sessionPeers.clear();
    this.#announcedPeers.clear();
    this.#sessionAnnounced = false;
    this.#pendingFullPeers.clear();
    this.#rawMessages = [];
    this.#deferredEvents = [];
    this.#deferReplicaMessages = false;
    this.#clearRecoveryWork();
    this.#endpoint?.close();
  }

  #clearAttemptWork(): void {
    this.#retryTimer?.cancel();
    this.#retryTimer = undefined;
    const pending = this.#pendingConnect;
    this.#pendingConnect = undefined;
    pending?.abort();
  }

  #clearRecoveryWork(): void {
    this.#clearAttemptWork();
    this.#deadlineTimer?.cancel();
    this.#deadlineTimer = undefined;
    this.#clearPublications();
  }

  #exhaustRecovery(deadlineMs?: number): void {
    this.#setFailure(
      new NetError({
        code: 'recovery-exhausted',
        expected:
          deadlineMs === undefined
            ? 'reconnect attempts within the configured finite bound'
            : `an accepted replacement baseline within ${deadlineMs}ms`,
        hint: 'inspect the endpoint failure and create a new session after exhaustion',
        detail: {
          attempts: this.#reconnectAttempts,
          maxAttempts: this.#policy.maxReconnectAttempts,
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
        },
      }),
    );
  }

  #beginRecovery(): void {
    this.#clearAttemptWork();
    // Replacement transport is still part of the same recovery until a fresh
    // baseline is accepted. Dropping it must not renew either finite budget.
    if (this.#deadlineTimer === undefined) {
      this.#reconnectAttempts = 0;
      this.#deadlineTimer = this.#clock.schedule(this.#policy.reconnectDeadlineMs, () => {
        this.#deadlineTimer = undefined;
        if (this.#state.kind === 'recovering' || this.#state.kind === 'resyncing')
          this.#exhaustRecovery(this.#policy.reconnectDeadlineMs);
      });
    }
    const previousEndpoint = this.#endpoint;
    this.#endpoint = undefined;
    previousEndpoint?.close();
    this.#replica?.coordinator.clear();
    if (
      this.#state.kind === 'connecting' ||
      this.#state.kind === 'active' ||
      this.#state.kind === 'resyncing'
    )
      this.#setState({
        kind: 'recovering',
        sessionId: this.#sessionId,
        epoch: this.#epoch,
        attempt: this.#reconnectAttempts,
      });
    this.#clearPublications();
    this.#sequence = 0;
    this.#acknowledgedSequence = 0;
    this.#peerIds.clear();
    this.#sessionPeers.clear();
    this.#announcedPeers.clear();
    this.#pendingFullPeers.clear();
    this.#rawMessages = [];
    this.#deferredEvents = [];
    this.#deferReplicaMessages = false;
  }

  #attemptRecovery(): void {
    if (this.#state.kind !== 'recovering' || this.#pendingConnect) return;
    if (this.#reconnectAttempts >= this.#policy.maxReconnectAttempts) {
      this.#exhaustRecovery();
      return;
    }
    this.#reconnectAttempts += 1;
    this.#setState({
      kind: 'recovering',
      sessionId: this.#sessionId,
      epoch: this.#epoch,
      attempt: this.#reconnectAttempts,
    });
    if (this.#connector === undefined) {
      if (this.#reconnectAttempts >= this.#policy.maxReconnectAttempts) this.#attemptRecovery();
      return;
    }
    const controller = new AbortController();
    this.#pendingConnect = controller;
    try {
      void this.#connector.connect(controller.signal).then(
        (result) => this.#connected(controller, result),
        (cause: unknown) => this.#connectFailed(controller, cause),
      );
    } catch (cause) {
      this.#connectFailed(controller, cause);
    }
  }

  #connected(controller: AbortController, result: Result<NetEndpoint, EndpointError>): void {
    if (this.#pendingConnect !== controller) {
      if (result.ok) result.value.close();
      return;
    }
    if (!result.ok) {
      this.#connectFailed(controller, result.error);
      return;
    }
    this.#pendingConnect = undefined;
    if (this.#state.kind !== 'recovering') {
      if (result.ok) result.value.close();
      return;
    }
    this.#endpoint?.close();
    this.#endpoint = result.value;
    this.#lastError = undefined;
    // The first connector opens epoch zero; only an announced session resumes.
    if (this.#sessionAnnounced) this.#epoch += 1;
    this.#sequence = 0;
    this.#acknowledgedSequence = 0;
    this.#clearPublications();
    // Keep the replacement endpoint's first message behind one receive tick.
    // A connector may deliver peer-connected and the fresh baseline in the
    // same poll; exposing resyncing for one frame makes the lifecycle state
    // observable and prevents a baseline from being consumed in the connect
    // callback's first update.
    this.#deferReplicaMessages = this.#replica !== undefined;
    this.#setState({ kind: 'resyncing', sessionId: this.#sessionId, epoch: this.#epoch });
  }

  #connectFailed(controller: AbortController, cause: unknown): void {
    if (this.#pendingConnect !== controller) return;
    this.#pendingConnect = undefined;
    if (this.#state.kind !== 'recovering') return;
    const failure: NetSessionFailure =
      cause instanceof NetError
        ? (cause as unknown as NetError)
        : isEndpointError(cause)
          ? cause
          : recoveryFailure('connector attempt failed');
    if (this.#reconnectAttempts >= this.#policy.maxReconnectAttempts) {
      this.#exhaustRecovery();
      return;
    }
    this.#lastError = failure;
    this.advanceRecovery();
  }

  #handleAck(peerId: PeerId, packet: ReplicationAckPacket): void {
    const publication = this.#publications.get(peerId);
    if (publication === undefined) return;
    if (packet.sessionId !== publication.sessionId) return;
    if (packet.epoch !== publication.epoch || packet.acknowledgedSequence > publication.sequence)
      return;
    publication.acknowledgedSequence = Math.max(
      publication.acknowledgedSequence,
      packet.acknowledgedSequence,
    );
    for (const sequence of publication.ledger.keys())
      if (sequence <= publication.acknowledgedSequence) publication.ledger.delete(sequence);
    return;
  }

  #receiveMessage(peerId: PeerId, data: Uint8Array, errors: NetError[]): void {
    if (
      !this.#peerIds.has(peerId) ||
      this.#state.kind === 'recovering' ||
      isTerminalNetSessionState(this.#state)
    )
      return;
    const limits = this.#replica?.limits ?? this.#authority?.limits ?? DEFAULT_REPLICATION_LIMITS;
    const decoded = decodeReplicationPacket(data, limits);
    if (!decoded.ok) {
      if (this.#replica === undefined && this.#authority === undefined) {
        this.#queueRawMessage(peerId, data);
        return;
      }
      errors.push(decoded.error);
      if (this.#replica !== undefined) this.#setFailure(decoded.error);
      return;
    }
    const packet = decoded.value;
    switch (packet.kind) {
      case 'application':
        this.#receiveApplication(peerId, packet, errors);
        return;
      case 'session-open':
      case 'session-resume': {
        const attached = this.#sessionPeers.get(packet.sessionId);
        if (attached !== undefined && attached !== peerId && this.#announcedPeers.has(attached)) {
          errors.push(recoveryFailure('SessionId is already attached to another live peer'));
          return;
        }
        this.#bindSession(packet.sessionId, peerId);
        if (packet.kind === 'session-resume' && !this.#announcedPeers.has(peerId)) {
          this.#authority?.resumeSession(packet.sessionId, packet.epoch);
          this.#pendingFullPeers.add(peerId);
        }
        this.#announcedPeers.add(peerId);
        return;
      }
      case 'ack':
        this.#handleAck(peerId, packet);
        return;
      case 'rejection': {
        const publication = this.#publications.get(peerId);
        if (
          this.#sessionPeers.get(packet.sessionId) !== peerId ||
          (this.#replica !== undefined && packet.epoch !== this.#epoch) ||
          (this.#authority !== undefined && publication?.epoch !== packet.epoch)
        )
          return;
        const failure = recoveryFailure(`peer rejected ${packet.rejectedKind}: ${packet.reason}`);
        errors.push(failure);
        if (this.#authority !== undefined) {
          this.#lastError = failure;
          this.#disconnectPeer(peerId);
        } else this.#setFailure(failure);
        return;
      }
      case 'baseline':
      case 'delta':
        this.#receiveDataPacket(peerId, data, packet, errors);
        return;
    }
  }

  #receiveApplication(
    peerId: PeerId,
    packet: ReplicationApplicationPacket,
    errors: NetError[],
  ): void {
    const publication = this.#publications.get(peerId);
    const accepted =
      this.#peerIds.has(peerId) &&
      this.#sessionPeers.get(packet.sessionId) === peerId &&
      (this.#replica !== undefined
        ? this.#state.kind === 'active' &&
          packet.sessionId === this.#sessionId &&
          packet.epoch === this.#epoch
        : this.#authority !== undefined &&
          this.#announcedPeers.has(peerId) &&
          publication !== undefined &&
          publication.sessionId === packet.sessionId &&
          publication.epoch === packet.epoch &&
          publication.acknowledgedSequence >= 1);
    if (!accepted) {
      errors.push(recoveryFailure('application message does not match an accepted session epoch'));
      return;
    }
    this.#queueRawMessage(peerId, new Uint8Array(packet.payload));
  }

  #receiveDataPacket(
    peerId: PeerId,
    data: Uint8Array,
    packet: ReplicationDataPacket,
    errors: NetError[],
  ): void {
    if (this.#replica === undefined) {
      if (this.#authority === undefined) this.#queueRawMessage(peerId, data);
      else errors.push(recoveryFailure('an authority cannot receive replica data packets'));
      return;
    }
    // The session retains the resumed epoch even after clearing its projection.
    // Retired transport data cannot establish the replacement baseline.
    if (this.#state.kind === 'resyncing' && packet.epoch < this.#epoch) return;
    const applied = applyReplicationPacket(this.#replica.coordinator, packet);
    if (!applied.ok) {
      errors.push(applied.error);
      this.#setFailure(applied.error);
      return;
    }
    const packetOutcome = applied.value;
    if (packetOutcome === 'accepted') {
      this.#deadlineTimer?.cancel();
      this.#deadlineTimer = undefined;
      if (packet.epoch !== this.#epoch)
        this.#rawMessages = this.#rawMessages.filter((message) => message.peerId !== peerId);
      this.#epoch = packet.epoch;
      this.#sequence = packet.sequence;
      this.#acknowledgedSequence = packet.sequence;
      this.#setState({
        kind: 'active',
        sessionId: this.#sessionId,
        epoch: this.#epoch,
        sequence: this.#sequence,
      });
    }
    if (packetOutcome === 'accepted' || packetOutcome === 'duplicate')
      this.#sendReplicationAck(peerId, packet);
  }

  receiveEvents(): readonly NetError[] {
    const errors: NetError[] = [];
    if (isTerminalNetSessionState(this.#state)) return errors;
    const events = [...this.#deferredEvents, ...(this.#endpoint?.poll() ?? [])];
    this.#deferredEvents = [];
    const deferMessages = this.#deferReplicaMessages;
    this.#deferReplicaMessages = false;
    for (const event of events) {
      if (isTerminalNetSessionState(this.#state)) break;
      if (event.kind === 'peer-connected') {
        if (this.#peerIds.has(event.peerId)) continue;
        if (this.#peerIds.size >= this.#policy.maxSessions) {
          const failure = new NetError({
            code: 'session-capacity-exceeded',
            expected: 'concurrent session attachments within maxSessions',
            hint: 'wait for an existing attachment to disconnect before connecting again',
            detail: {
              peerId: event.peerId,
              attachedPeers: this.#peerIds.size,
              maxSessions: this.#policy.maxSessions,
            },
          });
          this.#lastError = failure;
          errors.push(failure);
          this.#disconnectPeer(event.peerId);
          continue;
        }
        this.#peerIds.add(event.peerId);
        if (this.#replica !== undefined) {
          this.#bindSession(this.#sessionId, event.peerId);
          const announced = this.#announceSession(event.peerId);
          if (!announced.ok) this.#lastError = announced.error;
        } else if (this.#visibility === undefined)
          this.#bindSession(this.#sessionForPeer(event.peerId), event.peerId);
        this.#pendingFullPeers.add(event.peerId);
      } else if (event.kind === 'peer-disconnected') {
        const attached = this.#peerIds.has(event.peerId);
        this.#forgetPeer(event.peerId);
        // A refused extra peer cannot retire a healthy replica attachment.
        // With no attachment, a close before the first connect event still
        // enters recovery (some endpoints only publish that terminal event).
        if (this.#replica !== undefined && (attached || this.#peerIds.size === 0)) {
          this.#beginRecovery();
          this.advanceRecovery();
        }
      } else if (deferMessages) {
        this.#deferredEvents.push(event);
      } else this.#receiveMessage(event.peerId, event.data, errors);
    }
    this.#retryPublications(errors);
    return errors;
  }

  #retryPublications(errors: NetError[]): void {
    if (
      this.#authority === undefined ||
      this.#endpoint === undefined ||
      isTerminalNetSessionState(this.#state)
    )
      return;
    const now = this.#clock.now();
    for (const [peerId, publication] of this.#publications) {
      for (const [sequence, pending] of publication.ledger) {
        if (now < pending.retryAt) continue;
        if (pending.retries >= this.#policy.maxPacketRetries) {
          const failure = new NetError({
            code: 'ack-retry-exhausted',
            expected: 'a cumulative ACK within the configured packet retry budget',
            hint: 'the failed peer was disconnected; other sessions can continue',
            detail: {
              peerId,
              sessionId: publication.sessionId,
              epoch: publication.epoch,
              sequence,
              retries: pending.retries,
              maxRetries: this.#policy.maxPacketRetries,
            },
          });
          this.#lastError = failure;
          errors.push(failure);
          // Missing ACKs are transport loss, not invalid replica data. Closing
          // only this peer lets its existing connector use bounded recovery.
          this.#disconnectPeer(peerId);
          break;
        }
        pending.retries++;
        pending.retryAt = now + this.#policy.ackTimeoutMs;
        const sent = this.#endpoint.send(peerId, pending.bytes);
        if (!sent.ok) {
          this.#lastError = sent.error;
          if (sent.error.code === 'connection-closed' || sent.error.code === 'peer-not-found') {
            this.#forgetPeer(peerId);
            break;
          }
        }
      }
    }
  }

  drainRawMessages(): RawMessage[] {
    return this.#rawMessages.splice(0);
  }

  getPeerSnapshot(): PeerSnapshot {
    const peerIds = [...this.#peerIds].sort((left, right) => left - right);
    return { peerIds, connected: peerIds.length > 0 };
  }

  getSessionSnapshot(): SessionSnapshot {
    const sessionIds = [...this.#sessionPeers.keys()].sort((left, right) => left - right);
    return { sessionIds, connected: sessionIds.length > 0 };
  }

  getReplicationSnapshot(): readonly ReplicationPeerSnapshot[] {
    return [...this.#publications]
      .map(([peerId, publication]) => ({
        peerId,
        sessionId: publication.sessionId,
        epoch: publication.epoch,
        sequence: publication.sequence,
        acknowledgedSequence: publication.acknowledgedSequence,
        pendingPackets: publication.ledger.size,
      }))
      .sort((left, right) => left.peerId - right.peerId);
  }

  /** Return lifecycle, epoch, sequence, ledger, and owned-resource evidence. */
  getRecoverySnapshot(): NetRecoverySnapshot {
    return {
      sessionId: this.#sessionId,
      state: this.#state,
      pendingPackets: Math.max(
        0,
        ...[...this.#publications.values()].map((peer) => peer.ledger.size),
      ),
      maxPendingPackets: this.#policy.maxPendingPackets,
      acknowledgedSequence:
        this.#publications.size === 0
          ? this.#acknowledgedSequence
          : Math.min(...[...this.#publications.values()].map((peer) => peer.acknowledgedSequence)),
      reconnectAttempts: this.#reconnectAttempts,
      epoch: this.#epoch,
      sequence: this.#sequence,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      ownedResources: {
        pendingConnects: this.#pendingConnect === undefined ? 0 : 1,
        timers: Number(this.#retryTimer !== undefined) + Number(this.#deadlineTimer !== undefined),
        ledgers: [...this.#publications.values()].filter((peer) => peer.ledger.size > 0).length,
        callbacks: 0,
      },
    };
  }

  getResourceSnapshot(): NetSessionResourceCounts {
    return this.getRecoverySnapshot().ownedResources;
  }

  recover(): NetRecoveryOutcome {
    if (isTerminalNetSessionState(this.#state))
      return { kind: 'retired', sessionId: this.#sessionId };
    if (this.#state.kind === 'recovering')
      return { kind: 'already-recovering', sessionId: this.#sessionId };
    this.#beginRecovery();
    return { kind: 'started', sessionId: this.#sessionId };
  }

  advanceRecovery(): void {
    if (this.#state.kind !== 'recovering') return;
    const delay =
      this.#policy.reconnectDelaysMs[
        Math.min(this.#reconnectAttempts, this.#policy.reconnectDelaysMs.length - 1)
      ];
    if (delay === undefined || delay === 0) this.#attemptRecovery();
    else {
      this.#retryTimer?.cancel();
      this.#retryTimer = this.#clock.schedule(delay, () => {
        this.#retryTimer = undefined;
        this.#attemptRecovery();
      });
    }
  }

  sendRaw(peerId: PeerId, data: Uint8Array): Result<void, EndpointError | NetError> {
    if (this.#state.kind !== 'active') return err(recoveryFailure('session is not active'));
    return this.#sendToPeer(peerId, data);
  }

  /** Send opaque application bytes after the replica has accepted its baseline. */
  sendToAuthority(sessionId: SessionId, data: Uint8Array): Result<void, EndpointError | NetError> {
    if (sessionId !== this.#sessionId)
      return err(recoveryFailure('session id does not belong to this NetSession'));
    if (this.#replica === undefined || this.#state.kind !== 'active')
      return err(recoveryFailure('replica has not accepted a baseline'));
    const peerId = this.#peerForSession(sessionId);
    if (peerId === undefined) return err(recoveryFailure('authority peer is not connected'));
    const encoded = encodeReplicationPacket(
      { version: 2, kind: 'application', sessionId, epoch: this.#epoch, payload: Array.from(data) },
      this.#replica.limits,
    );
    return encoded.ok ? this.#sendToPeer(peerId, encoded.value) : encoded;
  }

  /** Send opaque application bytes after this logical session has acknowledged its baseline. */
  sendToSession(sessionId: SessionId, data: Uint8Array): Result<void, EndpointError | NetError> {
    if (isTerminalNetSessionState(this.#state))
      return err(recoveryFailure('session is not connected to the authority'));
    const peerId = this.#peerForSession(sessionId);
    if (peerId === undefined) return err(recoveryFailure('logical session is not connected'));
    const publication = this.#publications.get(peerId);
    if (
      this.#authority === undefined ||
      !this.#announcedPeers.has(peerId) ||
      publication === undefined ||
      publication.sessionId !== sessionId ||
      publication.acknowledgedSequence < 1
    )
      return err(recoveryFailure('logical session has not acknowledged a baseline'));
    const encoded = encodeReplicationPacket(
      {
        version: 2,
        kind: 'application',
        sessionId,
        epoch: publication.epoch,
        payload: Array.from(data),
      },
      this.#authority.limits,
    );
    return encoded.ok ? this.#sendToPeer(peerId, encoded.value) : encoded;
  }

  attachAuthority(authority: AuthorityCoordinator, visibility?: ReplicationVisibility): void {
    if (this.#authority !== authority)
      for (const publication of this.#publications.values()) {
        this.#authority?.forgetSession(publication.sessionId);
        authority.resumeSession(publication.sessionId, publication.epoch + 1);
      }
    this.#authority = authority;
    this.#visibility = visibility;
    for (const peerId of this.#peerIds) this.#pendingFullPeers.add(peerId);
  }

  requestFullBaseline(peerId: PeerId): void {
    if (this.#peerIds.has(peerId)) this.#pendingFullPeers.add(peerId);
  }

  requestFullBaselineForSession(sessionId: SessionId): void {
    const peerId = this.#sessionPeers.get(sessionId);
    if (peerId !== undefined) this.requestFullBaseline(peerId);
  }

  attachReplica(coordinator: ReplicaCoordinator, limits: ReplicationLimits): void {
    this.#replica = { coordinator, limits };
    for (const peerId of this.#peerIds) {
      this.#bindSession(this.#sessionId, peerId);
      const announced = this.#announceSession(peerId);
      if (!announced.ok) this.#lastError = announced.error;
    }
  }

  #ledgerBoundError(): NetError {
    return new NetError({
      code: 'recovery-rejected',
      expected: 'published packets within the configured finite ACK bound',
      hint: 'wait for a cumulative ACK before publishing more packets',
      detail: { reason: 'ACK ledger bound reached' },
    });
  }

  #clearPublications(): void {
    for (const publication of this.#publications.values())
      this.#authority?.forgetSession(publication.sessionId);
    this.#publications.clear();
  }

  publish(): Result<void, NetError | EndpointError> {
    if (
      this.#authority === undefined ||
      this.#endpoint === undefined ||
      isTerminalNetSessionState(this.#state)
    )
      return ok(undefined);
    let failure: NetError | EndpointError | undefined;
    for (const peerId of [...this.#peerIds]) {
      // Socket-open precedes logical session-open/resume. Publishing under the
      // provisional transport identity can leak an epoch-zero baseline on resume.
      if (!this.#announcedPeers.has(peerId)) continue;
      const sessionId = this.#sessionForPeer(peerId);
      let publication = this.#publications.get(peerId);
      if (publication === undefined) {
        publication = {
          sessionId,
          epoch: 0,
          sequence: 0,
          acknowledgedSequence: 0,
          ledger: new Map(),
        };
        this.#publications.set(peerId, publication);
      }
      const full = this.#pendingFullPeers.has(peerId);
      if (!full && publication.ledger.size >= this.#policy.maxPendingPackets) {
        failure ??= this.#ledgerBoundError();
        continue;
      }
      const published = full
        ? this.#authority.publishFull(sessionId, this.#visibility)
        : this.#authority.publish(sessionId, this.#visibility);
      if (!published.ok) {
        failure ??= published.error;
        continue;
      }
      const packet = published.value;
      const sent = this.#endpoint.send(peerId, packet.bytes);
      if (!sent.ok) {
        if (sent.error.code === 'connection-closed') this.#forgetPeer(peerId);
        else {
          // Projection has advanced; a failed transport write must next send
          // a fresh baseline rather than an unobservable sequence gap.
          this.#pendingFullPeers.add(peerId);
          failure ??= sent.error;
        }
        continue;
      }
      if (packet.epoch !== publication.epoch) {
        this.#rawMessages = this.#rawMessages.filter((message) => message.peerId !== peerId);
        publication.ledger.clear();
        publication.acknowledgedSequence = 0;
      }
      publication.epoch = packet.epoch;
      publication.sequence = packet.sequence;
      publication.ledger.set(packet.sequence, {
        bytes: packet.bytes,
        retries: 0,
        retryAt: this.#clock.now() + this.#policy.ackTimeoutMs,
      });
      this.#epoch = packet.epoch;
      this.#sequence = packet.sequence;
      this.#pendingFullPeers.delete(peerId);
    }
    return failure === undefined ? ok(undefined) : err(failure);
  }

  dispose(): void {
    if (this.#state.kind === 'retired') return;
    this.#setState({ kind: 'retired', sessionId: this.#sessionId, reason: 'disposed' });
    this.#clearRecoveryWork();
    this.#endpoint?.close();
    this.#endpoint = undefined;
    this.#replica?.coordinator.clear();
    this.#replica = undefined;
    this.#clearPublications();
    this.#authority = undefined;
    this.#peerIds.clear();
    this.#sessionPeers.clear();
    this.#announcedPeers.clear();
    this.#sessionAnnounced = false;
    this.#pendingFullPeers.clear();
    this.#rawMessages = [];
    this.#deferredEvents = [];
    this.#deferReplicaMessages = false;
  }

  #queueRawMessage(peerId: PeerId, data: Uint8Array): void {
    if (this.#rawMessages.length >= this.#maxRawMessages) return;
    this.#rawMessages.push({
      peerId,
      sessionId: this.#sessionForPeer(peerId),
      data: new Uint8Array(data),
    });
  }

  #sessionForPeer(peerId: PeerId): SessionId {
    for (const [sessionId, mappedPeerId] of this.#sessionPeers)
      if (mappedPeerId === peerId) return sessionId;
    if (this.#replica !== undefined) {
      this.#bindSession(this.#sessionId, peerId);
      return this.#sessionId;
    }
    const created = createSessionId(peerId);
    const sessionId = created.ok ? created.value : this.#sessionId;
    // A policy-equipped authority binds only an announced logical identity.
    if (this.#visibility === undefined) this.#bindSession(sessionId, peerId);
    return sessionId;
  }

  #bindSession(sessionId: SessionId, peerId: PeerId): void {
    for (const [mappedSessionId, mappedPeerId] of this.#sessionPeers)
      if (mappedSessionId === sessionId || mappedPeerId === peerId) {
        if (mappedSessionId !== sessionId || mappedPeerId !== peerId) {
          this.#rawMessages = this.#rawMessages.filter(
            (message) => message.peerId !== mappedPeerId,
          );
          const old = this.#publications.get(mappedPeerId);
          if (old !== undefined) {
            if (mappedPeerId === peerId) this.#authority?.rebindSession(old.sessionId, sessionId);
            else this.#authority?.forgetSession(old.sessionId);
          }
          this.#publications.delete(mappedPeerId);
          this.#pendingFullPeers.add(mappedPeerId);
        }
        this.#sessionPeers.delete(mappedSessionId);
      }
    this.#sessionPeers.set(sessionId, peerId);
  }

  #disconnectPeer(peerId: PeerId): void {
    const disconnected = this.#endpoint?.disconnect(peerId);
    if (disconnected !== undefined && !disconnected.ok) this.#lastError = disconnected.error;
    this.#forgetPeer(peerId);
  }

  #forgetPeer(peerId: PeerId): void {
    this.#rawMessages = this.#rawMessages.filter((message) => message.peerId !== peerId);
    const publication = this.#publications.get(peerId);
    if (publication !== undefined) this.#authority?.forgetSession(publication.sessionId);
    this.#publications.delete(peerId);
    this.#peerIds.delete(peerId);
    for (const [sessionId, mappedPeerId] of this.#sessionPeers)
      if (mappedPeerId === peerId) this.#sessionPeers.delete(sessionId);
    this.#announcedPeers.delete(peerId);
    this.#pendingFullPeers.delete(peerId);
  }

  #peerForSession(sessionId: SessionId): PeerId | undefined {
    const mapped = this.#sessionPeers.get(sessionId);
    if (mapped !== undefined && this.#peerIds.has(mapped)) return mapped;
    if (this.#replica !== undefined && this.#peerIds.size === 1) {
      const peerId = [...this.#peerIds][0];
      if (peerId !== undefined) {
        this.#bindSession(sessionId, peerId);
        return peerId;
      }
    }
    return undefined;
  }

  #announceSession(peerId: PeerId): Result<void, EndpointError | NetError> {
    if (this.#announcedPeers.has(peerId)) return ok(undefined);
    const packet: ReplicationSessionPacket = {
      version: 2,
      kind: this.#sessionAnnounced ? 'session-resume' : 'session-open',
      sessionId: this.#sessionId,
      epoch: this.#epoch,
      sequence: 0,
    };
    const encoded = encodeReplicationPacket(packet, DEFAULT_REPLICATION_LIMITS);
    if (!encoded.ok) return err(encoded.error);
    const sent = this.#sendToPeer(peerId, encoded.value);
    if (!sent.ok) return sent;
    this.#announcedPeers.add(peerId);
    this.#sessionAnnounced = true;
    return ok(undefined);
  }

  #sendToPeer(peerId: PeerId, data: Uint8Array): Result<void, EndpointError | NetError> {
    const result = this.#endpoint?.send(peerId, data);
    if (result === undefined) return err(recoveryFailure('session has no endpoint'));
    return result.ok ? ok(undefined) : err(result.error);
  }

  /** ACK accepted data at the session boundary; consumers should not reimplement this wire step. */
  #sendReplicationAck(peerId: PeerId, packet: ReplicationDataPacket): void {
    const encoded = encodeReplicationPacket(
      {
        version: 2,
        kind: 'ack',
        sessionId: packet.sessionId,
        epoch: packet.epoch,
        acknowledgedSequence: packet.sequence,
      },
      DEFAULT_REPLICATION_LIMITS,
    );
    if (!encoded.ok) {
      this.#setFailure(encoded.error);
      return;
    }
    const sent = this.#sendToPeer(peerId, encoded.value);
    if (!sent.ok) this.#lastError = sent.error;
  }
}
