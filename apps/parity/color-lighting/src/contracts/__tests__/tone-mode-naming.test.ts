import { describe, expect, it } from 'vitest';
import {
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_REINHARD,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine-render';
import { THREE_R184_TONE_MODES } from '../../analytic/three-r184-tonemap';

function tonemapToU32(mode: string): number {
  switch (mode) {
    case 'linear':
      return TONEMAP_LINEAR;
    case 'reinhard':
      return TONEMAP_REINHARD;
    case 'cineon':
      return TONEMAP_CINEON;
    case 'aces-filmic':
      return TONEMAP_ACES_FILMIC;
    case 'agx':
      return TONEMAP_AGX;
    case 'neutral':
      return TONEMAP_NEUTRAL;
    default:
      throw new Error(`unknown tone mode: ${mode}`);
  }
}

function tonemapFromF32(value: number): string {
  switch (value) {
    case TONEMAP_LINEAR:
      return 'linear';
    case TONEMAP_REINHARD:
      return 'reinhard';
    case TONEMAP_CINEON:
      return 'cineon';
    case TONEMAP_ACES_FILMIC:
      return 'aces-filmic';
    case TONEMAP_AGX:
      return 'agx';
    case TONEMAP_NEUTRAL:
      return 'neutral';
    case TONEMAP_REINHARD_EXTENDED:
      return 'reinhard-extended';
    default:
      return 'none';
  }
}

describe('public tone mode naming', () => {
  it('maps every Three r184 name to one public numeric mode', () => {
    const expected = {
      linear: TONEMAP_LINEAR,
      reinhard: TONEMAP_REINHARD,
      cineon: TONEMAP_CINEON,
      'aces-filmic': TONEMAP_ACES_FILMIC,
      agx: TONEMAP_AGX,
      neutral: TONEMAP_NEUTRAL,
    } as const;
    for (const mode of THREE_R184_TONE_MODES) {
      expect(tonemapToU32(mode)).toBe(expected[mode]);
      expect(tonemapFromF32(expected[mode])).toBe(mode);
    }
  });

  it('does not reuse a Three name for the Forge extended curve', () => {
    expect(TONEMAP_REINHARD_EXTENDED).not.toBe(TONEMAP_REINHARD);
    expect(tonemapFromF32(TONEMAP_REINHARD_EXTENDED)).toBe('reinhard-extended');
  });

  it('fails explicitly for an unknown public mode', () => {
    expect(() => tonemapToU32('unknown' as never)).toThrow();
  });
});
