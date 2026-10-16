import {
  DEFAULT_NET_RECOVERY_POLICY,
  DEFAULT_REPLICATION_LIMITS,
  NetError,
  createMemoryEndpointPair,
  createSessionId,
  isLegalNetSessionTransition,
  resolveNetRecoveryPolicy,
  transitionNetSessionState,
} from '@forgeax/engine-net';

const session = createSessionId(17);
if (!session.ok) throw new Error(`SessionId creation failed: ${session.error.code}`);
const policy = resolveNetRecoveryPolicy({ maxPendingPackets: 8 });
if (!policy.ok || policy.value.maxPendingPackets !== 8)
  throw new Error('public recovery policy resolution failed');
if (DEFAULT_NET_RECOVERY_POLICY.maxPendingPackets !== 32)
  throw new Error('public recovery defaults are not bounded');
if (DEFAULT_REPLICATION_LIMITS.maxMessageBytes <= 0)
  throw new Error('replication limits are not available from the public barrel');

const connecting = { kind: 'connecting', sessionId: session.value };
const resyncing = { kind: 'resyncing', sessionId: session.value, epoch: 1 };
const active = { kind: 'active', sessionId: session.value, epoch: 1, sequence: 1 };
const recovering = { kind: 'recovering', sessionId: session.value, epoch: 1, attempt: 1 };
const failed = {
  kind: 'failed',
  sessionId: session.value,
  error: new NetError({
    code: 'recovery-exhausted',
    expected: 'a recoverable session',
    hint: 'inspect the bounded recovery evidence before creating a new session',
    detail: { attempts: 5, maxAttempts: 5 },
  }),
};
const retired = { kind: 'retired', sessionId: session.value, reason: 'disposed' };
const states = [connecting, resyncing, active, recovering, failed, retired];
for (const state of states) {
  if (state.sessionId !== session.value) throw new Error(`state lost ${state.kind} identity`);
}
if (!isLegalNetSessionTransition('connecting', 'resyncing'))
  throw new Error('legal recovery transition was rejected');
if (isLegalNetSessionTransition('active', 'connecting'))
  throw new Error('illegal transition was accepted');
const transitioned = transitionNetSessionState(connecting, resyncing);
if (!transitioned.ok || transitioned.value.kind !== 'resyncing')
  throw new Error('public transition result was not accepted');
const illegal = transitionNetSessionState(active, connecting);
if (illegal.ok || illegal.error.code !== 'session-illegal-transition')
  throw new Error('illegal transition did not return a structured error');

const [authority, replica] = createMemoryEndpointPair();
if (!authority.poll().every((event) => event.kind === 'peer-connected'))
  throw new Error('memory authority did not expose its connection event');
if (!replica.poll().every((event) => event.kind === 'peer-connected'))
  throw new Error('memory replica did not expose its connection event');
console.log(`recovery session consumer passed ${states.length} lifecycle states`);
