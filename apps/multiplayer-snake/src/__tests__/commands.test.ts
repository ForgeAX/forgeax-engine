import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { installKeyboardInput } from '../client';
import {
  type Direction,
  decodeCommand,
  decodeDirectionCommand,
  encodeCommand,
  encodeDirectionCommand,
  processCommands,
  processJoinCommands,
} from '../shared/commands';

describe('Snake direction commands', () => {
  it('round trips an identity-free join command', () => {
    const encoded = encodeCommand({ kind: 'join' });
    expect(encoded.ok && decodeCommand(encoded.value)).toEqual({
      ok: true,
      value: { kind: 'join' },
    });
  });

  it('keeps ready distinct from peer admission', () => {
    const ready = encodeCommand({ kind: 'ready' });
    if (!ready.ok) throw ready.error;
    expect(decodeCommand(ready.value)).toEqual({ ok: true, value: { kind: 'ready' } });
    expect(processJoinCommands([{ sessionId: 1, data: ready.value }], new Set([1]))).toEqual(
      new Set(),
    );
  });
  it('sends exactly once for a valid key and zero times for an invalid key', () => {
    const sent: Uint8Array[] = [];
    const target = {
      addEventListener: (_name: string, listener: (event: KeyboardEvent) => void) => {
        (target as { listener?: typeof listener }).listener = listener;
      },
      removeEventListener: () => {},
      listener: undefined as ((event: KeyboardEvent) => void) | undefined,
    };
    const session = {
      getRecoverySnapshot: () => ({
        sessionId: 1 as never,
        state: { kind: 'active', sessionId: 1 as never, epoch: 0, sequence: 1 } as const,
        pendingPackets: 0,
        maxPendingPackets: 32,
        acknowledgedSequence: 1,
        reconnectAttempts: 0,
        epoch: 0,
        sequence: 1,
        ownedResources: { pendingConnects: 0, timers: 0, ledgers: 0, callbacks: 0 },
      }),
      sendToAuthority: (_sessionId: never, data: Uint8Array) => {
        sent.push(data);
        return ok(undefined);
      },
    };
    const evidence = { directionCommandSendCount: 0 };
    installKeyboardInput(session, target as never, evidence);
    target.listener?.({ key: 'q' } as KeyboardEvent);
    expect(evidence.directionCommandSendCount).toBe(0);
    target.listener?.({ key: 'ArrowUp' } as KeyboardEvent);
    expect(evidence.directionCommandSendCount).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it('round trips a direction command', () => {
    const encoded = encodeDirectionCommand({ direction: 'up' });
    expect(encoded.ok && decodeDirectionCommand(encoded.value)).toMatchObject({
      ok: true,
      value: { direction: 'up' },
    });
  });

  it('decodes only direction data; endpoint identity is not part of the payload', () => {
    const encoded = encodeDirectionCommand({ direction: 'right' });
    if (!encoded.ok) throw encoded.error;
    const decoded = decodeDirectionCommand(encoded.value);
    expect(decoded).toEqual({ ok: true, value: { direction: 'right' } });
    if (decoded.ok) expect(Object.keys(decoded.value)).toEqual(['direction']);
    expect(decodeDirectionCommand(new Uint8Array([1, 1, 42]))).toMatchObject({
      ok: false,
      error: { code: 'command-malformed' },
    });
  });

  it.each([
    new Uint8Array(),
    new Uint8Array([1, 0, 9]),
    new Uint8Array([1, 9]),
  ])('rejects malformed command bytes', (data) =>
    expect(decodeDirectionCommand(data)).toMatchObject({ ok: false }));

  it('rejects payloads beyond the command bound', () => {
    expect(decodeDirectionCommand(new Uint8Array(17))).toMatchObject({
      ok: false,
      error: { code: 'command-too-large' },
    });
  });

  it('keeps the first valid non-opposite command per peer', () => {
    const command = (direction: Direction) => {
      const encoded = encodeDirectionCommand({ direction });
      if (!encoded.ok) throw encoded.error;
      return encoded.value;
    };
    expect(
      processCommands(
        [
          { sessionId: 1, data: command('left') },
          { sessionId: 1, data: command('down') },
          { sessionId: 2, data: command('down') },
        ],
        new Map([
          [1, 'up'],
          [2, 'up'],
        ]),
      ),
    ).toEqual(new Map([[1, 'left']]));
  });

  it('keeps caller identity outside the decoded command payload', () => {
    const encoded = encodeDirectionCommand({ direction: 'right' });
    if (!encoded.ok) throw encoded.error;
    const decoded = decodeDirectionCommand(encoded.value);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).not.toHaveProperty('peerId');
    expect(processCommands([{ sessionId: 7, data: encoded.value }], new Map([[7, 'up']]))).toEqual(
      new Map([[7, 'right']]),
    );
  });
});
