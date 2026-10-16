import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const frame = readFileSync(new URL('../record/volume-params.ts', import.meta.url), 'utf8');

describe('volumetric Spot frame optics', () => {
  it('passes extracted colorTimesIntensity through once', () => {
    expect(frame).toMatch(
      /const lightColor = selectedSpot\?\.color \?\? lights\.directional\?\.color/,
    );
    expect(frame).toContain('params.set(lightColor, 24);');
    expect(frame).not.toContain('channel * selectedSpot.intensity');
  });
});
