import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shader = readFileSync(resolve(import.meta.dirname, '../standard-surface.wgsl'), 'utf8');

describe('transparent PBR color domain contract', () => {
  it('mixes transparent source and destination in the linear domain', () => {
    expect(shader).toContain('blendLinearTransparent');
    expect(shader).toContain('linearColorDomain');
  });

  it('does not contain a direct encoded-destination blend path', () => {
    expect(shader).not.toContain('encodedDestinationBlend');
  });

  it('keeps HDR transparent output linear until the tone stage', () => {
    expect(shader).toContain('linearHdrColorDomain');
    expect(shader).toContain('toneStageInput');
  });

  it('keeps transparent PBR on the shared Directional factor path', () => {
    expect(shader).toContain('lighting_directional');
    expect(shader.match(/evalDirectionalShadowFactorAtPixel\(/g)).toHaveLength(1);
    expect(shader).toContain('directionalBase');
    expect(shader).toContain('directionalClearcoat');
  });
});
