import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  STANDARD_OBJECT_SPACE_NORMAL_BIT,
  STANDARD_PARALLAX_DISPLACEMENT_BIT,
  STANDARD_SAMPLE_REUSE,
  STANDARD_TRIPLANAR_PROJECTION_BIT,
} from '../index';

const textureBits = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(
  (entry) => entry.type === 'texture2d',
).length;

const log2 = (bit: number) => Math.log2(bit);

describe('Standard override mask layout', () => {
  it('lays out presence, reuse selectors and projection bits contiguously without overlap', () => {
    let cursor = textureBits;
    for (const entry of STANDARD_SAMPLE_REUSE) {
      const width = Math.ceil(Math.log2(entry.sources.length + 1));
      expect(entry.shift, entry.target).toBe(cursor);
      cursor += width;
    }
    expect(log2(STANDARD_TRIPLANAR_PROJECTION_BIT)).toBe(cursor);
    expect(log2(STANDARD_OBJECT_SPACE_NORMAL_BIT)).toBe(cursor + 1);
    expect(log2(STANDARD_PARALLAX_DISPLACEMENT_BIT)).toBe(cursor + 2);
    expect(cursor + 3).toBeLessThanOrEqual(32);
  });

  it('keeps the alpha selector clear of the projection bits at its largest value', () => {
    const alpha = STANDARD_SAMPLE_REUSE.find((entry) => entry.target === 'alphaTexture');
    if (alpha === undefined) throw new Error('missing alpha reuse entry');
    const selector = (alpha.sources.length * 2 ** alpha.shift) % 2 ** 32;
    for (const bit of [
      STANDARD_TRIPLANAR_PROJECTION_BIT,
      STANDARD_OBJECT_SPACE_NORMAL_BIT,
      STANDARD_PARALLAX_DISPLACEMENT_BIT,
    ]) {
      expect(Math.floor(selector / bit) % 2).toBe(0);
    }
  });
});
