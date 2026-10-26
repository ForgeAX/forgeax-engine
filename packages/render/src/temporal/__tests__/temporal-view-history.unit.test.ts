import { describe, expect, it } from 'vitest';
import { TemporalViewHistory } from '../frame';
import { createTemporalView } from '../view';

const view = (frameIndex: number) =>
  createTemporalView({ antialias: 'taa', width: 4, height: 4, frameIndex, historyValid: true });

describe('TemporalViewHistory', () => {
  it('promotes only a committed outcome and derives the TAA frame index from it', () => {
    const history = new TemporalViewHistory();
    expect(history.accepted).toBeUndefined();
    expect(history.frameIndex).toBe(0);

    const first = view(0);
    history.stage({ kind: 'taa', view: first });
    expect(history.accepted).toBeUndefined();
    expect(history.commit()).toBe('taa');
    expect(history.accepted).toBe(first);
    expect(history.frameIndex).toBe(1);

    // A frame without a temporal candidate keeps the accepted view and index.
    history.discard();
    expect(history.commit()).toBe('none');
    expect(history.accepted).toBe(first);
    expect(history.frameIndex).toBe(1);

    // An aborted frame never promotes its staged view.
    history.stage({ kind: 'taa', view: view(1) });
    history.discard();
    expect(history.commit()).toBe('none');
    expect(history.accepted).toBe(first);

    const off = view(0);
    history.stage({ kind: 'off', view: off });
    expect(history.commit()).toBe('off');
    expect(history.accepted).toBe(off);
    expect(history.frameIndex).toBe(0);
  });

  it('drops accepted and staged history on reset', () => {
    const history = new TemporalViewHistory();
    history.stage({ kind: 'taa', view: view(5) });
    history.commit();
    history.stage({ kind: 'taa', view: view(6) });
    history.reset();
    expect(history.accepted).toBeUndefined();
    expect(history.frameIndex).toBe(0);
    expect(history.commit()).toBe('none');
  });
});
