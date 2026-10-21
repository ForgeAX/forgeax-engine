# @forgeax/engine-net

> **Socket open is not authority.** A transport attachment is only a way to
> carry bytes. The realm-neutral `NetSession` contract remains non-authoritative
> until a fresh protocol-v2 baseline is accepted.

`@forgeax/engine-net` owns the application-session vocabulary, replication
packet schema, codec limits, and structured errors. WebSocket mechanics belong
to `@forgeax/engine-net-websocket`; gameplay meaning belongs to the consumer.
Reconnect, ACK ledger, resync, packet-loss recovery, and terminal cleanup are
described by the public contract below.
Socket-specific retry or automatic recovery remains a session policy concern;
the WebSocket package only supplies the endpoint and connector mechanics.

## First entry

Use the public barrel to discover the contract:

```ts
import {
  DEFAULT_NET_RECOVERY_POLICY,
  NetSession,
  createSessionId,
  resolveNetRecoveryPolicy,
} from '@forgeax/engine-net';

const sessionId = createSessionId(17).unwrap();
const policy = resolveNetRecoveryPolicy().unwrap();
const session = new NetSession({ endpoint, maxRawMessages: 32 });
```

`SessionId` is application identity. `PeerId` is transport identity and may
change when a socket is replaced. Never use a reopened socket or a new
`PeerId` as evidence that stale local state is authoritative.

## Lifecycle contract

`NetSessionState` is a closed union owned by one logical session:

| State | Meaning | Legal next states |
|:--|:--|:--|
| `connecting` | Initial endpoint attachment is pending. | `resyncing`, `failed`, `retired` |
| `resyncing` | A transport exists, but no fresh baseline is accepted yet. | `active`, `recovering`, `failed`, `retired` |
| `active` | The current epoch and ordered projection are accepted. | `recovering`, `failed`, `retired` |
| `recovering` | The session is replacing transport state under finite bounds. | `resyncing`, `failed`, `retired` |
| `failed` | Terminal protocol, apply, or recovery failure is observable. | `retired` |
| `retired` | The session owns no further work. | `retired` |

`isLegalNetSessionTransition` checks a transition without changing state;
`isTerminalNetSessionState` names the `failed`/`retired` states whose only exit is retirement.
`transitionNetSessionState` returns a `Result`, rejects a different
`SessionId`, and reports `session-illegal-transition` instead of silently
accepting an invalid replacement.

## Replication coordinator boundary

`AuthorityCoordinator` adopts one entity-to-identity/component-signature map per `SessionId` only
when packet encoding succeeds. A failed publication consumes neither an identity
nor a tick, epoch, sequence, or component baseline. Every candidate identity is
established before any entity reference is projected.

`createReplicaCoordinator(world, profile)` consumes validated data packets and
owns the replica projection. Endpoint attachment, disconnect, retry and resource
accounting belong to `NetSession`. Unresolved cross-packet references are rejected
before World mutation; a later baseline cannot revive a deferred write.

## Finite recovery policy

`DEFAULT_NET_RECOVERY_POLICY` is deterministic and finite:

| Field | Default | Bound |
|:--|--:|:--|
| `maxSessions` | `64` | Positive safe integer; concurrent accepted endpoint attachments |
| `maxPendingPackets` | `32` | Positive safe integer per session |
| `ackTimeoutMs` | `250` | Positive safe integer |
| `maxPacketRetries` | `3` | Positive safe integer |
| `maxReconnectAttempts` | `5` | Positive safe integer |
| `reconnectDeadlineMs` | `10000` | Positive safe integer |
| `reconnectDelaysMs` | `[0, 100, 200, 400, 800]` | Non-negative safe integers |

`resolveNetRecoveryPolicy` merges overrides and validates the complete result.
Invalid bounds return `recovery-policy-invalid` with `.detail.field` and
`.detail.reason`. No transport package selects these limits or owns a retry
ledger. `NetEndpointConnector.connect(signal)` is the only realm-neutral
replacement-endpoint capability.

`maxSessions` bounds this NetSession's admitted peer attachments, including peers
that have not announced a logical SessionId yet. Each attachment can bind one
logical session through the existing session map. An excess `peer-connected`
event reports `session-capacity-exceeded` and disconnects only that peer; it owns
no mapping, publication or raw-message queue. Disconnecting an accepted peer
frees its slot. Repeated connect events for an accepted peer are idempotent and
do not request a fresh baseline. Transport listeners still own their own socket
and pre-poll queue limits; this is not a global transport connection limit.

If a peer disconnect operation fails, `getRecoverySnapshot().lastError` retains
the structured EndpointError. The peer is still excluded from the session, and
its remaining bytes cannot enter application or replication state. This applies
to admission refusal, peer rejection and ACK retry exhaustion; healthy peers
continue. The returned receive error describes the original session failure.

One recovery budget runs from `recover()` or a detected disconnect until an accepted
replacement baseline. It covers connector latency, retry delays and resync; a
replacement disconnect before its baseline retains both the attempt count and
deadline. The initial connector opens epoch zero, while replacements resume the
announced session at a newer epoch. Recovery clears the old replica projection,
and old-epoch packets cannot activate the session or cancel its deadline.
Only an accepted fresh baseline grants a new budget to a later recovery.
Exhaustion aborts pending connection work, closes a late successful endpoint,
and clears all owned timers; deadline failures include `detail.deadlineMs`.

## Protocol-v2 packet contract

`ReplicationPacket` is the single machine-readable wire/schema authority. Each
encoded packet begins with the fixed `FXRP2` prefix and a newline. The public
union has exactly these kinds:

| Kind | Required identity | Payload rule |
|:--|:--|:--|
| `session-open` | `sessionId`, `epoch`, `sequence: 0` | Opens an application session. |
| `session-resume` | `sessionId`, `epoch`, `sequence: 0` | Requests the same application session after transport replacement. |
| `baseline` | `sessionId`, `epoch`, `sequence: 1` | Complete authority projection; required first data packet of an epoch. |
| `delta` | `sessionId`, `epoch`, positive `sequence` | Ordered projection after the accepted baseline. |
| `ack` | `sessionId`, `epoch`, `acknowledgedSequence` | Cumulative contiguous watermark. |
| `application` | `sessionId`, `epoch`, `payload` | Bounded opaque bytes in an accepted logical session. |
| `rejection` | `sessionId`, `epoch`, `sequence` | Structured rejection of a packet kind with a reason. |

Data packets also carry the safe-integer `tick`, profile `fingerprint`, and
projected `entities`. Entity kinds are the closed `upsert` and `despawn`
union. Protocol v1, a wrong prefix, malformed fields, unsafe identity values,
an invalid baseline sequence, and limit violations fail before dispatch.

```ts
import {
  decodeReplicationPacket,
  encodeReplicationPacket,
} from '@forgeax/engine-net';

const encoded = encodeReplicationPacket(packet, profile.limits);
if (!encoded.ok) {
  // Inspect encoded.error.code, expected, hint, and narrowed detail.
  return encoded;
}
const decoded = decodeReplicationPacket(encoded.value, profile.limits);
```

`ReplicationLimits` bound message bytes, entities, component operations,
strings, buffers, and arrays. Typed arrays are represented by an allowlisted
canonical tag and revived only after validation. There is no compatibility
decoder or second batch envelope.

## Application messages

`sendToAuthority(sessionId, bytes)` and `sendToSession(sessionId, bytes)` carry
opaque application bytes in the existing protocol-v2 `application` packet.
The replica must have accepted a baseline; the authority must have received that
session's baseline ACK. The authority's `getReplicationSnapshot()` exposes this
readiness through `acknowledgedSequence >= 1`. A transport connection or a
`session-open` announcement alone does not authorize application sends.

The packet carries the current logical identity and epoch. Receive validates the
actual endpoint peer, identity and accepted epoch before exposing a copied
`Uint8Array` through `drainRawMessages()`. Payload bytes are never decoded again,
even when they contain another valid `FXRP2` packet. Foreign identities and old
epochs are rejected without retiring the current stream. Application packets do
not enter ECS apply, ACK accounting, replication retry or automatic replay.

The attached profile's `maxMessageBytes` bounds the complete encoded packet;
`maxBufferBytes` and `maxArrayElements` bound its byte payload. `maxRawMessages`
bounds the receive queue. Both directions reject over-budget sends. Epoch
replacement, peer retirement, recovery and disposal clear their queued application
bytes. A replication-attached authority rejects malformed wire and incoming
baseline/delta packets instead of exposing them as application input. A malformed
replica stream retains the existing terminal-failure behavior. Endpoint-only
sessions retain their original raw receive surface.

## Receiver visibility

Attach one synchronous receiver policy to the authority session:

```ts
import { AuthorityCoordinator, NetSession, type ReplicationVisibility } from '@forgeax/engine/net';

const visibility: ReplicationVisibility = (entity, sessionId) =>
  admittedPlayers.get(sessionId)?.visibleEntities.has(entity) ?? false;
const session = new NetSession({ endpoint, maxRawMessages: 32 });
session.attachAuthority(new AuthorityCoordinator(world, profile), visibility);
```

The policy is pure game code and runs once per Profile candidate per receiver per
publication. It only narrows the Profile query. Read current ownership, team,
distance, or explicit visibility facts there; no renderer or camera state is
required. Omitting the policy selects all Profile entities for every receiver.

| Change | Packet and replica result |
|:--|:--|
| Initial connection | Replica announces its logical identity automatically; every authority waits for that announcement before evaluating or sending data. A transport connection alone establishes neither the logical identity nor the resume epoch. Each receiver starts with its own sequence-one baseline, including an empty baseline. |
| Becomes visible | Complete component upsert with a fresh receiver-local network identity. |
| Remains visible | Changed-component delta; component removal retains the ordinary removal operation. |
| Becomes hidden | Despawn in that receiver's delta; other receivers keep their own state. |
| Hidden reference | With a visibility policy, scalar references outside the visible Profile become `null`, and those array entries are removed; revealing a target restores references in the same packet. Without a policy, the existing unresolved-reference rejection remains. |
| Late join or explicit resync | Full current baseline for that receiver; established peers retain their epochs and deltas. |
| Authority or policy reattachment | Every connected receiver receives a newly evaluated baseline at a newer epoch, so an already accepted stream cannot retain revoked entities. |
| Transport replacement | Disconnect drops that receiver's signatures and ACK ledger. Replica clearing resets ordering; the replacement announces the same `SessionId` and receives a newly evaluated baseline at the resume epoch. |

> [!IMPORTANT]
> Logical identity announcement is routing, not authentication. The game's
> admission policy owns trusted player identities. Two live announced peers
> cannot attach the same `SessionId`; the rejected announcement leaves the
> current attachment intact.

`AuthorityCoordinator.publish(sessionId, visibility)` and
`publishFull(sessionId, visibility)` expose the same projection for direct
consumers. `idFor(entity, sessionId)` reads its receiver-local network identity;
`forgetSession(sessionId)` releases direct-consumer state. `resumeSession(sessionId, epoch)` starts a fresh projection at a monotonic
recovery epoch. Session integration
owns that release automatically on disconnect, replacement, failure and disposal.
A full resync bumps only that receiver's epoch. Encoding failure adopts no
candidate identity, sequence, tick or component signature.

ACKs must match the sending transport peer, logical session, current epoch and
published sequence. A stale or foreign ACK cannot drain another peer's ledger.
`maxPendingPackets` bounds each receiver independently; a stalled receiver
returns ordinary backpressure while healthy peers still publish. A transport
write failure schedules a new baseline before that receiver's next delta.

`receiveEvents()` first applies received ACKs, then advances pending publication
retries from the injected clock. After `ackTimeoutMs`, it resends the same owned
bytes in sequence order without advancing the projection, epoch or sequence.
Each entry retains its own `maxPacketRetries` budget in the existing ACK ledger;
an epoch replacement, cumulative ACK, disconnect or disposal retires that work.
An exhausted entry returns `ack-retry-exhausted` with its peer, session, epoch and
sequence, disconnects only that peer, and leaves other receivers live. Missing ACKs
are transport loss: they do not send a protocol `rejection`, so a replica can use
its existing bounded connector recovery. Invalid protocol data still produces a
terminal rejection; retry and recovery budgets are unchanged.
Hosts must keep polling and handle this per-peer failure without retiring their
whole authority. This policy adds no background timers or application replay.

`NetEndpoint.disconnect(peerId)` severs one transport connection; `close()` retires
the whole endpoint, including a listener. Memory and WebSocket adapters expose the
same terminal peer event. Endpoint decorators must forward both operations.
No delayed message follows that peer's terminal event. Session packet handling
requires a connected peer; a rejection must match its current session and epoch.
On an authority, a valid rejection retires only that receiver.

`getReplicationSnapshot()` is the authority's per-peer diagnostic roster
(`peerId`, `sessionId`, `epoch`, `sequence`, `acknowledgedSequence`,
`pendingPackets`). Its rows are independent sequence spaces.
`getRecoverySnapshot()` retains single-session recovery evidence; for an authority,
`pendingPackets` is the largest peer backlog, `acknowledgedSequence` is the smallest
peer watermark, and `ownedResources.ledgers` counts nonempty peer ledgers. Its
`epoch`/`sequence` describe the last sent publication; use the roster to diagnose
individual receivers.

Run the receiver regression and real-socket checks, then the optional performance
consumer after building the package closure:

```bash
pnpm --filter @forgeax/engine-net exec vitest run --config vitest.config.ts
pnpm --filter @forgeax/engine-net-websocket exec vitest run --config vitest.config.ts
node packages/net/__tests__/fixtures/peer-visibility-performance.mjs artifacts/g25 <baseline-sha>
```

The diagnostic compares the exact baseline coordinator/codec source with the
current built barrel: 128/512 entities, 1/8/32 receivers, 100%/25%/10% visibility,
40 warmup and 100 measured alternating AB/BA samples. It records CPU and wall
p50/p95, exact outgoing bytes and raw samples. Each entity's `x` changes every publication;
World writes are outside the timed interval, encoding is inside, sockets and
replica application are outside. This measures publication, not whole-game FPS
or network round-trip latency. All-visible publication performs independent
receiver projection and encoding; bandwidth savings require a smaller visible
set. Hardware timings are diagnostic evidence, not a portable CI threshold.

## Structured failure and recovery guidance

Expected failures are `Result` values with `.code`, `.expected`, `.hint`, and
code-narrowed `.detail`. Branch on the code; do not parse error messages.

Construct transport failures with `new EndpointError({ code, detail })`. The Net
owner supplies `.expected`, `.hint`, and the message from the closed code policy;
all memory, WebSocket, and WeChat adapters use that same policy. The former
`ENDPOINT_EXPECTED` and `ENDPOINT_ERROR_HINTS` exports are removed. Keep contextual
facts in the code-specific detail; session `NetError` diagnostics remain contextual.

| Code | Meaning | Next action |
|:--|:--|:--|
| `protocol-unsupported-version` | The peer sent a version other than `2`. | Align the peer build before sending bytes. |
| `session-illegal-transition` | A state replacement is not legal for this session. | Wait for the current state or retire the session. |
| `recovery-policy-invalid` | A configured bound is invalid. | Fix the named field and resolve the policy again. |
| `recovery-rejected` | The authority rejected recovery. | Inspect `.detail.reason`, then dispose or fix admission. |
| `recovery-exhausted` | Finite attempts or deadline were exhausted. | Inspect accounting and create a new session only after terminal retirement. |
| `apply-invariant-failed` | Validated ECS application failed. | Treat the coordinator as terminal; never retry the fatal apply. |

The session snapshot shape is `NetRecoverySnapshot`: it reports `state`, the
stable `sessionId`, `pendingPackets`, `maxPendingPackets`,
`acknowledgedSequence`, `epoch`, `sequence`, `reconnectAttempts`, the latest
structured error, and `ownedResources`. `ownedResources` counts pending
connects, timers, ledgers, and callbacks; every terminal and disposed path
must report zero. `NetRecoveryOutcome` gives stable results for repeated
recovery calls: `started`, `already-recovering`, `already-active`, or `retired`.

## Runnable public evidence

Run the built public-barrel consumers from the repository root:

```bash
node packages/net/__tests__/fixtures/protocol-v2-consumer.mjs
node packages/net/__tests__/fixtures/recovery-session-consumer.mjs
```

The protocol fixture round-trips every packet kind and rejects protocol v1.
The recovery fixture checks every lifecycle state, transition validation,
bounded defaults, and deterministic memory endpoint behavior. These fixtures
import only the shipped `@forgeax/engine-net` barrel.

## Existing ECS replication seam

`defineReplication` selects the portable ECS query, ordered component list,
limits, and profile fingerprint. `AuthorityCoordinator` publishes baseline and
delta `ReplicationPacket` data; `ReplicaCoordinator` validates profile,
identity, ordering, schema, and same-packet references before World mutation.
Local ECS `EntityHandle` values never cross the wire.

```ts
import {
  AuthorityCoordinator,
  ReplicaCoordinator,
  defineReplication,
} from '@forgeax/engine-net';
```

Immediate unresolved-reference rejection remains the one policy: a reference
must already exist or be created in the same data packet. No cross-packet
reference queue is retained.

`ReplicaCoordinator.apply`, `applyReplicationPacket` and
`decodeAndApplyReplicationPacket` return the packet-order result in their `Result`:
`accepted`, `duplicate`, or `ignored-old-epoch`. A duplicate returns success
without World mutation; an old epoch returns success without reviving work; a
gap or invalid new baseline returns a structured error before mutation. The
coordinator never closes a transport. `NetSession` owns endpoint closure,
terminal failure, connector cancellation, and plugin teardown.

## Entry points

| Export | Purpose |
|:--|:--|
| `NetSessionState`, `SessionId`, `NetRecoverySnapshot` | Session identity, lifecycle, and observable accounting types |
| `NetRecoveryPolicy`, `DEFAULT_NET_RECOVERY_POLICY` | Finite deterministic recovery bounds |
| `NetEndpointConnector` | Realm-neutral replacement endpoint capability |
| `ReplicationPacket` | Single protocol-v2 packet/schema union |
| `encodeReplicationPacket`, `decodeReplicationPacket` | Prefix, schema, typed-data, and limit validation |
| `NetError`, `EndpointError` | Closed structured expected failures |
| `NetEndpoint`, `PeerId` | Transport-only bytes and peer lifecycle |
| `NetSession`, `netPlugin` | World-facing session integration |
| `ReplicationVisibility`, `ReplicationPeerSnapshot` | Receiver policy and per-peer publication evidence |
| `defineReplication`, `ReplicationProfile` | Portable ECS replication contract |
| `AuthorityCoordinator`, `ReplicaCoordinator` | Authority publication and atomic replica apply |

## Source map

- Session policy and public lifecycle: `src/session/recovery.ts`
- Endpoint capability and memory transport: `src/endpoint/`
- Packet manifest, codec, and structured errors: `src/replication/`
- Deterministic public consumers: `__tests__/fixtures/`

Encoding and decoding apply the same maximum message size to every protocol-v2
kind, including session controls, acknowledgments and rejections. Application
payload and replication-entity budgets share one packet admission path; decoding
still rejects oversized bytes before parsing. Nested component arrays are walked
once, preserving their existing string, buffer and element limits.

`NetSession.dispose()` publishes its terminal `retired` state before cancelling
connectors or closing endpoints. Recovery admission and repeated disposal read
that same lifecycle, including synchronous cleanup callbacks.
