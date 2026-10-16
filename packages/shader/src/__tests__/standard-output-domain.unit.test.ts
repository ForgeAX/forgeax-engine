import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shaderRoot = resolve(import.meta.dirname, '..');
const outputEncoding = readFileSync(resolve(shaderRoot, 'output-encoding.wgsl'), 'utf8');
const tonemap = readFileSync(resolve(shaderRoot, 'tonemap.wgsl'), 'utf8');

describe('Standard output shader domain contract', () => {
  it('owns the only explicit linear-LDR to display-sRGB conversion', () => {
    expect(outputEncoding).toContain('linearToSrgbOetf');
    expect(outputEncoding.match(/linearToSrgbOetf\s*\(/g)).toHaveLength(1);
    expect(outputEncoding).toContain('fn encodeOutput');
    expect(outputEncoding).toContain('return vec4<f32>(encoded, alpha);');
    expect(tonemap).toContain('#import forgeax_view::output_encoding');
    expect(tonemap).not.toContain('linearToSrgbOetf(mapped)');
  });

  it('keeps tone mapping in linear HDR to linear LDR and preserves alpha', () => {
    expect(tonemap).toContain('fn toneMapLinearLdr');
    expect(tonemap).toContain('fn mapTonemap');
    expect(tonemap).toContain('fn fs_tone_only');
    expect(tonemap).toContain('return vec4<f32>(mapTonemap(source.rgb), source.a);');
    expect(tonemap).toContain('fn fs_encode_only');
    expect(tonemap).toContain('return encodeFinal(source.rgb, source.a, in.position);');
    expect(tonemap).not.toContain('encodedDestinationBlend');
    expect(tonemap).toContain('ditherUnorm8(encoded.rgb, position.xy)');
  });

  it('fails closed when a route has no declared output encoding owner', () => {
    const source = `${outputEncoding}\n${tonemap}`;
    expect(source.match(/fn encodeOutput/g)).toHaveLength(1);
    expect(source.match(/linearToSrgbOetf\s*\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/srgb.*attachment.*and.*explicit|explicit.*and.*srgb.*attachment/i);
  });
});
