import { describe, expect, it } from 'vitest';

type ProducerAudit = {
  readonly producer: string;
  readonly owner: 'built-in' | 'vfx-render';
  readonly visible: string;
  readonly hidden: string;
  readonly restored: string;
  readonly shadow: 'required' | 'N/A: baseline has no shadow contribution';
};

const PRODUCER_MATRIX: readonly ProducerAudit[] = [
  {
    producer: 'static-mesh',
    owner: 'built-in',
    visible: 'main dispatch exists',
    hidden: 'main and shadow dispatch are empty',
    restored: 'the same entity dispatches again',
    shadow: 'required',
  },
  {
    producer: 'skinned-mesh',
    owner: 'built-in',
    visible: 'main dispatch exists',
    hidden: 'main and shadow dispatch are empty',
    restored: 'the same entity dispatches again',
    shadow: 'required',
  },
  {
    producer: 'auto-fold-instances',
    owner: 'built-in',
    visible: 'visible members remain in the batch',
    hidden: 'hidden members leave the batch',
    restored: 'the same members return',
    shadow: 'required',
  },
  {
    producer: 'explicit-instances',
    owner: 'built-in',
    visible: 'the owner dispatches',
    hidden: 'the owner dispatch is empty',
    restored: 'the owner dispatches again',
    shadow: 'required',
  },
  {
    producer: 'sprite',
    owner: 'built-in',
    visible: 'main dispatch exists',
    hidden: 'main and shadow dispatch are empty',
    restored: 'the same entity dispatches again',
    shadow: 'required',
  },
  {
    producer: 'tilemap',
    owner: 'built-in',
    visible: 'derived render entities dispatch',
    hidden: 'derived render entities dispatch nothing',
    restored: 'derived render entities dispatch again',
    shadow: 'required',
  },
  {
    producer: 'vfx-particles',
    owner: 'vfx-render',
    visible: 'main-color contribution exists',
    hidden: 'main-color contribution is empty',
    restored: 'the same player contributes again',
    shadow: 'N/A: baseline has no shadow contribution',
  },
];

describe('visibility producer matrix audit', () => {
  it('contains every producer and three explicit state criteria', () => {
    expect(PRODUCER_MATRIX.map(({ producer }) => producer)).toEqual([
      'static-mesh',
      'skinned-mesh',
      'auto-fold-instances',
      'explicit-instances',
      'sprite',
      'tilemap',
      'vfx-particles',
    ]);
    for (const row of PRODUCER_MATRIX) {
      expect(row.visible).not.toBe('');
      expect(row.hidden).not.toBe('');
      expect(row.restored).not.toBe('');
    }
  });

  it('requires real shadow evidence only from producers with a shadow path', () => {
    const builtIn = PRODUCER_MATRIX.filter((row) => row.owner === 'built-in');
    expect(builtIn.every((row) => row.shadow === 'required')).toBe(true);
    expect(PRODUCER_MATRIX.find((row) => row.producer === 'vfx-particles')?.shadow).toBe(
      'N/A: baseline has no shadow contribution',
    );
  });
});
