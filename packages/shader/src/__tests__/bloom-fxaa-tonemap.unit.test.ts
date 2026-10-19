import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shaderRoot = resolve(import.meta.dirname, '..');
const tonemap = readFileSync(resolve(shaderRoot, 'tonemap.wgsl'), 'utf8');
const toneMapping = readFileSync(resolve(shaderRoot, 'tone-mapping.wgsl'), 'utf8');
const outputEncoding = readFileSync(resolve(shaderRoot, 'output-encoding.wgsl'), 'utf8');
const common = readFileSync(resolve(shaderRoot, 'common.wgsl'), 'utf8');
const bloomHorizontal = readFileSync(resolve(shaderRoot, 'bloom-horizontal.wgsl'), 'utf8');
const bloomVertical = readFileSync(resolve(shaderRoot, 'bloom-vertical.wgsl'), 'utf8');
const bloomComposite = readFileSync(resolve(shaderRoot, 'bloom-composite.wgsl'), 'utf8');
const bloom = `${bloomHorizontal}\n${bloomVertical}\n${bloomComposite}`;
const fxaa = readFileSync(resolve(shaderRoot, 'fxaa.wgsl'), 'utf8');

function codeOnly(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}`);
  expect(start, `${name} definition`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('post shader color-domain contract', () => {
  it('declares Output Transform as the only display conversion owner', () => {
    const code = codeOnly(tonemap);
    expect(tonemap).toContain('Output Transform');
    expect(tonemap).toContain('fs_encode_only');
    expect(outputEncoding.match(/linearToSrgbOetf\s*\(/g)).toHaveLength(1);
    expect(tonemap).toContain('#import forgeax_view::output_encoding');
    expect(toneMapping).toContain('let exposed : vec3<f32> = sample * exposure;');
    expect(code).toContain(
      'mapTone(sample, params.exposure, params.whitePoint, params.mode, params.outputGamut)',
    );
    const mapping = functionBody(codeOnly(toneMapping), 'mapTone');
    expect(mapping.indexOf('let exposed')).toBeGreaterThanOrEqual(0);
    expect(mapping.indexOf('let exposed')).toBeLessThan(mapping.indexOf('switch (mode)'));
    expect(code).toContain('encodeFinal(mapTonemap');
  });

  it('maps every public mode before one shared OETF', () => {
    const code = codeOnly(tonemap);
    const body = functionBody(codeOnly(toneMapping), 'mapTone');
    for (const mode of [1, 2, 3, 4, 5, 6, 7]) {
      expect(body).toMatch(
        new RegExp(`case ${mode}u:\\s*\\{\\s*mapped\\s*=\\s*(?:toneMap|tonemap)`),
      );
    }
    expect(body).toMatch(
      /default:\s*\{\s*mapped\s*=\s*toneMapLinearLdr\(sample, outputGamut\);\s*\}/,
    );
    expect(functionBody(code, 'fs_main')).toContain(
      'return encodeFinal(mapTonemap(source.rgb), source.a, in.position);',
    );
    expect(functionBody(code, 'fs_main')).not.toContain('linearToSrgbOetf(');
  });

  it('exposes tone-only and encoding-only entry points for the positive LUT path', () => {
    const code = codeOnly(tonemap);
    const toneOnly = functionBody(code, 'fs_tone_only');
    const encodeOnly = functionBody(code, 'fs_encode_only');
    expect(toneOnly).toContain('mapTonemap(source.rgb)');
    expect(toneOnly).not.toContain('encodeOutput(');
    expect(encodeOnly).toContain('return encodeFinal(source.rgb, source.a, in.position);');
    expect(functionBody(code, 'encodeFinal')).toContain(
      'encodeOutput(linearColor, alpha, params.outputGamut)',
    );
    expect(functionBody(code, 'encodeFinal')).toContain('ditherUnorm8(encoded.rgb, position.xy)');
    expect(code.indexOf('fn fs_tone_only')).toBeLessThan(code.indexOf('fn fs_encode_only'));
  });

  it('keeps the sole OETF free of software precision emulation', () => {
    expect(common).not.toContain('quantizeToF16');
    expect(outputEncoding).not.toContain('quantizeToF16');
    const code = codeOnly(tonemap);
    expect(functionBody(codeOnly(toneMapping), 'mapTone')).not.toContain('quantizeToF16');
    expect(functionBody(code, 'encodeFinal')).not.toContain('quantizeToF16');
    // Fused tone/LUT work retains the two physical binary16 store boundaries.
    expect(functionBody(code, 'fs_tone_lut_encode').match(/quantizeToF16/g)).toHaveLength(2);
    expect(tonemap).not.toContain('Float16');
  });

  it('locks the sRGB OETF to the Three r184 reference literal', () => {
    const code = codeOnly(common);
    expect(code).toContain('pow(safe, vec3<f32>(0.41666))');
    expect(code).not.toContain('1.0 / 2.4');
  });

  it('preserves the Three r184 middle-gray final UNORM byte', () => {
    const linear = 0.21404;
    const encode = (exponent: number): number =>
      Math.round((1.055 * linear ** exponent - 0.055) * 255);

    expect(encode(0.41666)).toBe(128);
    expect(encode(1 / 2.4)).toBe(127);
  });

  it('keeps bloom in linear HDR while FXAA is display encoded', () => {
    expect(bloom).toContain('linearHdrColorDomain');
    expect(fxaa).toContain('display-encoded');
    expect(fxaa).not.toContain('linearLdrColorDomain');
    expect(fxaa).not.toContain('linearToSrgbOetf');
    expect(`${tonemap}\n${bloom}\n${fxaa}`).not.toContain('encodedDestinationBlend');
  });

  // Bloom's spatial response, threshold and gain are verified on real GPU output
  // against the pinned Three node by apps/parity/color-lighting/verify-render-defaults.

  it('returns display-encoded RGB from both FXAA exits through the dither gate', () => {
    const body = functionBody(codeOnly(fxaa), 'fs_main');
    expect(fxaa).toContain('struct FxaaParams');
    expect(fxaa).toMatch(/@group\(0\)\s+@binding\(2\)\s+var<uniform> params/);
    expect(body).toContain('params.ditherEnabled > 0.5');
    expect(body).toContain('select(centerColor, ditherUnorm8(centerColor, in.position.xy)');
    expect(body).toContain('select(finalColor, ditherUnorm8(finalColor, in.position.xy)');
    expect(body).not.toMatch(/linearToSrgbOetf\s*\(/);
  });

  it('dithers the final FXAA output before the 8-bit surface quantization', () => {
    const code = codeOnly(fxaa);
    const body = functionBody(code, 'fs_main');
    expect(common).toContain('fn ditherUnorm8');
    expect(common).toContain('fn ditherNoise');
    expect(code).not.toContain('fn ditherUnorm8');
    expect(code).not.toContain('fn ditherNoise');
    expect(code).toContain('in.position.xy');
    expect(body).toContain('ditherUnorm8(centerColor, in.position.xy)');
    expect(body).toContain('ditherUnorm8(finalColor, in.position.xy)');

    const quantize = (value: number, noise: number): number =>
      Math.round(Math.min(1, Math.max(0, value + (0.5 - noise) * (1 / 255))) * 255);
    expect(quantize(0.5, 0)).toBe(128);
    expect(quantize(0.5, 1)).toBe(127);
    expect(quantize(0, 0)).toBe(1);
    expect(quantize(0, 1)).toBe(0);
    expect(quantize(1, 1)).toBe(255);
  });

  it('retains FXAA luma, edge search, and subpixel contract markers', () => {
    const code = codeOnly(fxaa);
    expect(code).toContain('fn rgb2luma');
    expect(code).toContain('fn qualityStep');
    expect(code).toContain('EDGE_THRESHOLD_MIN');
    expect(code).toContain('EDGE_THRESHOLD_MAX');
    expect(code).toContain('SUBPIXEL_QUALITY');
    expect(code).toContain('let edgeHorizontal =');
    expect(code).toContain('let edgeVertical =');
    expect(code).toContain('let subPixelOffsetFinal =');
  });
});
