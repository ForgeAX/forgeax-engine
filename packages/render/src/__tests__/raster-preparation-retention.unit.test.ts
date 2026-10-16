import { describe, expect, it } from 'vitest';
import { gpuDrivenDrawEntityKeys } from '../extract/gpu-driven';
import {
  type PreparedProductionPlan,
  suppressedPrimitiveWords,
} from '../gpu-driven/production-raster-prepare';

describe('raster preparation retention', () => {
  it('retains exactly the safe numeric entities admitted by draw keys', () => {
    const keys = new Set([
      '12:7:0',
      '12:8:1',
      '-9:7:0',
      'NaN:7:0',
      'Infinity:7:0',
      ':7:0',
      'missing',
      '9007199254740992:0:0',
      '1e2:0:0',
    ]);
    const first = gpuDrivenDrawEntityKeys(keys);
    expect([...first]).toEqual([12, -9, 100]);
    keys.clear();
    keys.add('27:8:0');
    expect([...first]).toEqual([12, -9, 100]);
    expect([...gpuDrivenDrawEntityKeys(keys)]).toEqual([27]);
  });

  it('suppresses partial admission with invocation-local state during nested evaluation', () => {
    const row = (entityKey: number) => ({ worldKey: 0, slot: { snapshot: { entityKey } } });
    const facts = new Map([
      [
        1,
        new Map([
          [0, row(10)],
          [1, row(11)],
        ]),
      ],
      [33, new Map([[0, row(12)]])],
    ]);
    const prepared = { batchRows: [{ facts }] } as unknown as PreparedProductionPlan;
    let nested: Uint32Array | undefined;
    const active = {
      has(entity: number) {
        if (entity === 10) nested = suppressedPrimitiveWords(prepared, new Set([10, 11]), 64);
        return entity === 10 || entity === 12;
      },
    } as unknown as ReadonlySet<number>;
    expect([...suppressedPrimitiveWords(prepared, active, 64)]).toEqual([2, 0]);
    expect(nested === undefined ? undefined : [...nested]).toEqual([0, 2]);
    expect([...suppressedPrimitiveWords(prepared, new Set([10, 11, 12]), 64)]).toEqual([0, 0]);
  });
});
