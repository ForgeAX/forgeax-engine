import type { NetEndpoint, SessionId } from '@forgeax/engine-net';
import { createSessionId, NetSession as NetSessionClass } from '@forgeax/engine-net';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { installKeyboardInput } from '../client';

interface TestKeyboardTarget {
  readonly addEventListener: (name: string, listener: (event: KeyboardEvent) => void) => void;
  readonly removeEventListener: (name: string, listener: (event: KeyboardEvent) => void) => void;
  listener: ((event: KeyboardEvent) => void) | undefined;
}

function keyboardTarget(): TestKeyboardTarget {
  const target: TestKeyboardTarget = {
    listener: undefined,
    addEventListener: (_name, listener) => {
      target.listener = listener;
    },
    removeEventListener: (_name, listener) => {
      if (target.listener === listener) target.listener = undefined;
    },
  };
  return target;
}

function sessionId(value: number): SessionId {
  const result = createSessionId(value);
  if (!result.ok) throw result.error;
  return result.value;
}

function idleEndpoint(): NetEndpoint {
  return {
    poll: () => [],
    send: () => ok(undefined),
    disconnect: () => ok(undefined),
    close: () => ok(undefined),
  };
}

describe('Snake reconnect consumer contract', () => {
  it('does not deliver commands while the public session is recovering or resyncing', () => {
    const sent: Uint8Array[] = [];
    const target = keyboardTarget();
    const endpoint: NetEndpoint = {
      ...idleEndpoint(),
      send: (_peerId: never, data: Uint8Array) => {
        sent.push(data);
        return ok(undefined);
      },
    };
    const session = new NetSessionClass({ endpoint, sessionId: sessionId(40), maxRawMessages: 8 });
    const disposeKeyboard = installKeyboardInput(
      session,
      target as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
    );

    target.listener?.({ key: 'ArrowUp' } as KeyboardEvent);

    expect(sent).toHaveLength(0);
    disposeKeyboard();
    session.dispose();
  });

  it('uses one SessionId and accepted baseline before interaction, then disposes cleanly', () => {
    const session = new NetSessionClass({
      endpoint: idleEndpoint(),
      sessionId: sessionId(41),
      maxRawMessages: 8,
    });
    const before = session.getRecoverySnapshot();

    expect(before.sessionId).toBe(sessionId(41));
    expect(before.state.kind).toBe('resyncing');
    expect(before.ownedResources).toEqual({
      pendingConnects: 0,
      timers: 0,
      ledgers: 0,
      callbacks: 0,
    });
    expect(session.sendRaw(1 as never, new Uint8Array([1]))).toMatchObject({
      ok: false,
      error: { code: 'recovery-rejected' },
    });

    session.dispose();
    const after = session.getRecoverySnapshot();
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.state.kind).toBe('retired');
    expect(after.ownedResources).toEqual({
      pendingConnects: 0,
      timers: 0,
      ledgers: 0,
      callbacks: 0,
    });
  });

  it('requires the consumer surface to retain public snapshot fields through convergence', () => {
    const snapshotFields = [
      'sessionId',
      'state',
      'epoch',
      'sequence',
      'pendingPackets',
      'acknowledgedSequence',
      'ownedResources',
    ] as const;
    const session = new NetSessionClass({
      endpoint: idleEndpoint(),
      sessionId: sessionId(42),
      maxRawMessages: 8,
    });
    const snapshot = session.getRecoverySnapshot();

    expect(snapshotFields.every((field) => field in snapshot)).toBe(true);
    expect(snapshot.sessionId).toEqual(expect.any(Number));
    expect(snapshot.state.kind).toMatch(/connecting|resyncing|active|recovering|failed|retired/);
    session.dispose();
  });
});
