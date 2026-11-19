import { describe, expect, it } from 'vitest';
import { parsePlayViewports } from '../play-viewports.js';

describe('play viewports', () => {
  it('parses WxH lists and rejects tiny, duplicate, malformed or too many viewports', () => {
    expect(parsePlayViewports('1280x720,390x844')).toEqual({
      ok: true,
      value: [
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
      ],
    });
    for (const bad of ['1280', '100x720', '1280x720,1280x720', '1x1,2x2,3x3,4x4,5x5', ''])
      expect(parsePlayViewports(bad).ok, bad).toBe(false);
  });
});
