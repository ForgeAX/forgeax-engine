import type { Handle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { materialSamplerHandles } from '../recovery/render-system-candidate';
import { materialTextureHandlesForResidency } from '../render-system';
import type { MaterialSnapshot } from '../render-system-extract';

type TextureHandle = Handle<'TextureAsset', 'shared'>;

describe('material texture residency handles', () => {
  it('preserves ordering, duplicate replacement and high fanout without sharing result storage', () => {
    const values = [
      NaN,
      NaN,
      -0,
      0,
      undefined,
      ...Array.from({ length: 256 }, (_, i) => i + 1),
      1,
      20,
    ];
    const expected = new Map<number, TextureHandle>();
    for (const value of values)
      if (value !== undefined && Number(value) !== 0)
        expected.set(Number(value), value as TextureHandle);
    const first = materialTextureHandlesForResidency(values as Array<TextureHandle | undefined>);
    expect(first).toEqual([...expected.values()]);
    const next = materialTextureHandlesForResidency([7 as TextureHandle]);
    expect(next).toEqual([7]);
    expect(first).toEqual([...expected.values()]);
    const material = {
      samplerHandles: new Map([
        ['zero', 0],
        ['first', 7],
        ['duplicate', 7],
        ['other', 11],
      ]),
    } as unknown as MaterialSnapshot;
    expect(materialSamplerHandles(material)).toEqual([0, 7, 11]);
  });

  it('retains both numeric observations and closes a raw iterator on failure', () => {
    const trace: string[] = [];
    let reads = 0;
    const value = {
      valueOf() {
        trace.push('value');
        if (++reads === 2) throw Error('second read');
        return 7;
      },
    } as unknown as TextureHandle;
    function* candidates() {
      try {
        trace.push('yield');
        yield value;
      } finally {
        trace.push('close');
      }
    }
    expect(() => materialTextureHandlesForResidency(candidates())).toThrow('second read');
    expect(trace).toEqual(['yield', 'value', 'value', 'close']);
  });

  it('drops the zero missing-reference sentinel before GPU resolution', () => {
    const missing = 0 as TextureHandle;
    const first = 7 as TextureHandle;
    const duplicate = 7 as TextureHandle;
    const second = 11 as TextureHandle;

    expect(
      materialTextureHandlesForResidency([undefined, missing, first, duplicate, second]),
    ).toEqual([first, second]);
  });
});
