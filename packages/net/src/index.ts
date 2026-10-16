// @forgeax/engine-net -- memory transport, replication session, and profile-driven ECS sync.
//
// Depends on @forgeax/engine-ecs (World, schedule), @forgeax/engine-plugin (Plugin),
// and @forgeax/engine-types (Result, errors). No WebSocket, browser, app, or runtime dependency.

// Endpoint contract (requirements AC-02, AC-13)
export type { EndpointEvent, NetEndpoint, NetEndpointConnector, PeerId } from './endpoint/endpoint';
export type { EndpointErrorCode, EndpointErrorDetail } from './endpoint/errors';
export {
  ENDPOINT_ERROR_HINTS,
  ENDPOINT_EXPECTED,
  EndpointError,
  isEndpointError,
} from './endpoint/errors';
export type { MemoryFaultController } from './endpoint/memory';
// Memory endpoint (requirements AC-03)
export {
  createMemoryEndpointConnector,
  createMemoryEndpointPair,
  createMemoryEndpointPairWithController,
} from './endpoint/memory';
export type { ReplicationVisibility } from './replication/authority';
export { AuthorityCoordinator, createAuthorityCoordinator } from './replication/authority';
export { decodeReplicationPacket, encodeReplicationPacket } from './replication/codec';
export {
  REPLICATION_PROTOCOL_PREFIX,
  REPLICATION_PROTOCOL_VERSION,
} from './replication/constants';
export {
  NetError,
  type NetErrorCode,
  type NetErrorDetail,
  type NetErrorDetailByCode,
  type NetErrorDetailFor,
} from './replication/errors';
export { validateHandshake } from './replication/handshake';
export type {
  DefineReplicationOptions,
  ReplicationLimits,
  ReplicationProfile,
} from './replication/profile';
export { DEFAULT_REPLICATION_LIMITS, defineReplication } from './replication/profile';
export type {
  ReplicationAckPacket,
  ReplicationApplicationPacket,
  ReplicationBaselinePacket,
  ReplicationComponentRecord,
  ReplicationDataPacket,
  ReplicationDataPacketBase,
  ReplicationDataPacketKind,
  ReplicationDeltaPacket,
  ReplicationEntityKind,
  ReplicationEntityRecord,
  ReplicationPacket,
  ReplicationPacketKind,
  ReplicationRejectionPacket,
  ReplicationSessionPacket,
} from './replication/protocol';
export {
  applyReplicationPacket,
  createReplicaCoordinator,
  decodeAndApplyReplicationPacket,
  ReplicaCoordinator,
} from './replication/replica';
export type {
  NetSessionConfig,
  PeerSnapshot,
  RawMessage,
  ReplicationPeerSnapshot,
  SessionSnapshot,
} from './session/net-session';
// Session (requirements AC-04)
export { NetSession } from './session/net-session';
export type {
  NetRecoveryOutcome,
  NetRecoveryPolicy,
  NetRecoverySnapshot,
  NetSessionFailure,
  NetSessionState,
  NetSessionStateKind,
  SessionId,
} from './session/recovery';
export {
  createSessionId,
  DEFAULT_NET_RECOVERY_POLICY,
  isLegalNetSessionTransition,
  isTerminalNetSessionState,
  RECOVERY_ERROR_CODES,
  resolveNetRecoveryPolicy,
  transitionNetSessionState,
  validateNetRecoveryPolicy,
} from './session/recovery';
export type { NetPluginConfig } from './session/session-plugin';
export { netPlugin } from './session/session-plugin';
