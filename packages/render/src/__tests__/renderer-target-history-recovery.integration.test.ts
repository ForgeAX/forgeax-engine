import { describe, expect, it } from 'vitest';
import { TaaHistoryStore } from '../temporal/taa-history-store';

type RecoveryReceipt = {
  readonly deviceGeneration: number;
  readonly completed: boolean;
};

type RecoverableHistory = TaaHistoryStore & {
  recoverForGeneration(deviceGeneration: number): void;
};

function recover(store: TaaHistoryStore, deviceGeneration: number): void {
  (store as RecoverableHistory).recoverForGeneration(deviceGeneration);
}

function commit(store: TaaHistoryStore, receipt: RecoveryReceipt): void {
  const attempt = store.begin('device-generation');
  attempt.commit(receipt as never);
}

describe('M4 / m4_t2 — target history recovery keeps logical token', () => {
  it('publishes uninitialized replacement storage with neutral fallback', () => {
    const store = new TaaHistoryStore();
    const token = (
      store.inspect() as typeof store.inspect extends () => infer T ? T : never & { token: string }
    ).token;

    recover(store, 8);

    expect(store.inspect()).toMatchObject({
      token,
      deviceGeneration: 8,
      content: 'uninitialized',
      fallback: 'neutral-texture',
      valid: false,
      requestVersion: 0,
    });
  });

  it('raises history only for a matching completed receipt', () => {
    const store = new TaaHistoryStore();
    recover(store, 8);
    const before = store.inspect();

    commit(store, { deviceGeneration: 7, completed: true });
    expect(store.inspect()).toMatchObject({
      token: before.token,
      deviceGeneration: 8,
      content: 'uninitialized',
      valid: false,
      requestVersion: 0,
    });

    commit(store, { deviceGeneration: 8, completed: false });
    expect(store.inspect().valid).toBe(false);

    commit(store, { deviceGeneration: 8, completed: true });
    expect(store.inspect()).toMatchObject({
      token: before.token,
      deviceGeneration: 8,
      content: 'active',
      valid: true,
      requestVersion: 1,
    });
  });

  it('does not invent once or on-demand requests during replacement', () => {
    const store = new TaaHistoryStore();
    recover(store, 9);
    const inspection = store.inspect() as typeof store.inspect extends () => infer T
      ? T
      : never & {
          requestVersion: number;
        };

    expect(inspection.requestVersion).toBe(0);
    expect(inspection.content).toBe('uninitialized');
  });
});
