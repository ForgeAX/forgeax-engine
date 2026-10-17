import type { Handle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  materialSamplerHandles,
  materialTextureHandles,
} from '../recovery/render-system-candidate';
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

  it('observes empty-to-populated and same-size material handle changes on every call', () => {
    const textures = new Map<string, TextureHandle>();
    const samplers = new Map<string, Handle<'SamplerAsset', 'shared'>>();
    const material = {
      textureHandles: textures,
      samplerHandles: samplers,
      baseColorTexture: 0 as TextureHandle,
    } as unknown as MaterialSnapshot;
    const empty = materialTextureHandles(material);
    expect(empty).toEqual([]);
    expect(materialSamplerHandles(material)).toEqual([]);
    textures.set('map', 7 as TextureHandle);
    samplers.set('map', 0 as Handle<'SamplerAsset', 'shared'>);
    expect(materialTextureHandles(material)).toEqual([7]);
    expect(materialSamplerHandles(material)).toEqual([0]);
    textures.set('map', 11 as TextureHandle);
    samplers.set('map', 13 as Handle<'SamplerAsset', 'shared'>);
    expect(materialTextureHandles(material)).toEqual([11]);
    expect(materialSamplerHandles(material)).toEqual([13]);
    Object.assign(material, { baseColorTexture: 17 as TextureHandle });
    expect(materialTextureHandles(material)).toEqual([11, 17]);
    expect(empty).toEqual([]);
  });

  it.each([
    undefined,
    new Map<string, TextureHandle>(),
  ])('reads legacy texture getters once with an empty field map (%s)', (textureHandles) => {
    let reads = 0;
    const material = {
      textureHandles,
      get baseColorTexture() {
        return (++reads === 1 ? 7 : 0) as TextureHandle;
      },
    } as unknown as MaterialSnapshot;
    expect(materialTextureHandles(material)).toEqual([7]);
    expect(reads).toBe(1);
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
