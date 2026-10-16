import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shaderRoot = resolve(import.meta.dirname, '..');
const tonemap = readFileSync(resolve(shaderRoot, 'tonemap.wgsl'), 'utf8');
const outputEncoding = readFileSync(resolve(shaderRoot, 'output-encoding.wgsl'), 'utf8');
const common = readFileSync(resolve(shaderRoot, 'common.wgsl'), 'utf8');
const bloomDownsample = readFileSync(resolve(shaderRoot, 'bloom-downsample.wgsl'), 'utf8');
const bloomUpsample = readFileSync(resolve(shaderRoot, 'bloom-upsample.wgsl'), 'utf8');
const bloomComposite = readFileSync(resolve(shaderRoot, 'bloom-composite.wgsl'), 'utf8');
const bloom = `${bloomDownsample}\n${bloomUpsample}\n${bloomComposite}`;
const fxaa = readFileSync(resolve(shaderRoot, 'fxaa.wgsl'), 'utf8');

const REC709 = [0.2126, 0.7152, 0.0722] as const;

function extractBloom(
  color: readonly [number, number, number],
  threshold: number,
  softKnee: number,
): readonly [number, number, number] {
  const c = [Math.max(color[0], 0), Math.max(color[1], 0), Math.max(color[2], 0)] as const;
  const luma = Math.max(c[0] * REC709[0] + c[1] * REC709[1] + c[2] * REC709[2], 0);
  if (threshold === 0) return c;
  const knee = threshold * softKnee;
  const response =
    knee === 0
      ? Math.max(luma - threshold, 0)
      : Math.max(
          luma - threshold,
          Math.min(2 * knee, Math.max(0, luma - threshold + knee)) ** 2 / (4 * knee),
        );
  const multiplier = response / Math.max(luma, 1e-6);
  return [c[0] * multiplier, c[1] * multiplier, c[2] * multiplier];
}

function normalizedCoverageAverage(
  source: readonly number[],
  sourceWidth: number,
  sourceHeight: number,
  destinationWidth: number,
  destinationHeight: number,
  destinationX: number,
  destinationY: number,
): number {
  const sourceMinX = (destinationX * sourceWidth) / destinationWidth;
  const sourceMaxX = ((destinationX + 1) * sourceWidth) / destinationWidth;
  const sourceMinY = (destinationY * sourceHeight) / destinationHeight;
  const sourceMaxY = ((destinationY + 1) * sourceHeight) / destinationHeight;
  let sum = 0;
  let coverage = 0;
  for (let y = Math.floor(sourceMinY); y < Math.ceil(sourceMaxY); y += 1) {
    for (let x = Math.floor(sourceMinX); x < Math.ceil(sourceMaxX); x += 1) {
      const weight =
        Math.max(0, Math.min(sourceMaxX, x + 1) - Math.max(sourceMinX, x)) *
        Math.max(0, Math.min(sourceMaxY, y + 1) - Math.max(sourceMinY, y));
      sum += (source[y * sourceWidth + x] ?? 0) * weight;
      coverage += weight;
    }
  }
  return sum / coverage;
}

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
    expect(code).toContain('let exposed : vec3<f32> = sample * params.exposure;');
    const mapping = functionBody(code, 'mapTonemap');
    expect(mapping.indexOf('let exposed')).toBeGreaterThanOrEqual(0);
    expect(mapping.indexOf('let exposed')).toBeLessThan(mapping.indexOf('switch (params.mode)'));
    expect(code).toContain('encodeFinal(mapTonemap');
  });

  it('maps every public mode before one shared OETF', () => {
    const code = codeOnly(tonemap);
    const body = functionBody(code, 'mapTonemap');
    for (const mode of [1, 2, 3, 4, 5, 6, 7]) {
      expect(body).toMatch(
        new RegExp(`case ${mode}u:\\s*\\{\\s*mapped\\s*=\\s*(?:toneMap|tonemap)`),
      );
    }
    expect(body).toMatch(/default:\s*\{\s*mapped\s*=\s*toneMapLinearLdr\(sample\);\s*\}/);
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
    expect(tonemap).not.toContain('quantizeToF16');
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

  it('locks continuous HDR extraction, normalized 13-tap reduction, and tent weights', () => {
    const exact = extractBloom([2, 1, 0.5], 0, 0.5);
    expect(exact).toEqual([2, 1, 0.5]);

    const hard = extractBloom([2, 1, 0.5], 1, 0);
    expect(hard[0] / hard[1]).toBeCloseTo(2, 10);
    expect(hard[1] / hard[2]).toBeCloseTo(2, 10);

    const soft = extractBloom([2, 1, 0.5], 1, 0.5);
    expect(soft[0] / soft[1]).toBeCloseTo(2, 10);
    expect(soft[1] / soft[2]).toBeCloseTo(2, 10);
    expect(soft.every((channel) => channel >= 0)).toBe(true);

    const fixedWeights = [
      0.125,
      ...Array.from({ length: 4 }, () => 0.0625),
      ...Array.from({ length: 4 }, () => 0.03125),
      ...Array.from({ length: 4 }, () => 0.125),
    ];
    expect(fixedWeights).toHaveLength(13);
    expect(fixedWeights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12);

    const tentWeights = [1, 2, 1, 2, 4, 2, 1, 2, 1].map((weight) => weight / 16);
    expect(tentWeights.reduce((sum, weight) => sum + weight, 0)).toBe(1);

    const downsampleBody = functionBody(codeOnly(bloomDownsample), 'fixedDownsample');
    expect(downsampleBody.match(/textureSampleLevel\(/g)).toHaveLength(13);
    expect(codeOnly(bloomDownsample)).toContain('textureLoad(src');
    expect(codeOnly(bloomDownsample)).toContain('let sourceMin =');
    expect(codeOnly(bloomDownsample)).toContain('let sourceMax =');
    expect(codeOnly(bloomDownsample)).toContain('let weight =');
    expect(codeOnly(bloomDownsample)).toContain('coverage = coverage + weight');
    expect(codeOnly(bloomDownsample)).toContain('sum / max(coverage, 1e-6)');
    expect(codeOnly(bloomDownsample)).toContain('let q = clamp(luma + (knee - threshold)');
    expect(codeOnly(bloomDownsample)).toContain('let response = max(luma - threshold, soft)');
    expect(codeOnly(bloomDownsample)).not.toContain('1.0005');
    expect(codeOnly(bloomDownsample)).toContain('let isD0 = params.level == 0.0');
    expect(functionBody(codeOnly(bloomDownsample), 'fs_main')).toContain('if isD0');
    expect(functionBody(codeOnly(bloomDownsample), 'fs_main')).not.toContain(
      'select(fixedDownsample(in.uv), loadCoveredAverage(pixel), isD0)',
    );
    expect(extractBloom([65504, 65504, 65504], 65504, 0)).toEqual([0, 0, 0]);
    expect(normalizedCoverageAverage([0, 6, 0], 3, 1, 2, 1, 0, 0)).toBeCloseTo(2, 12);
    expect(normalizedCoverageAverage([0, 6, 0], 3, 1, 2, 1, 1, 0)).toBeCloseTo(2, 12);
    expect(normalizedCoverageAverage([0, 1, 2, 3, 4, 5], 3, 2, 2, 2, 0, 1)).toBeCloseTo(
      3.3333333333333335,
      12,
    );
    expect(codeOnly(bloomUpsample)).toContain('textureDimensions(coarse)');
    expect(codeOnly(bloomUpsample)).toContain('mix(currentColor, reconstructed, scatter)');
    expect(codeOnly(bloomComposite)).toContain('let sceneSample : vec4<f32>');
    expect(codeOnly(bloomComposite)).toContain('sceneSample.rgb');
    expect(codeOnly(bloomComposite)).toContain(
      'return vec4<f32>(clampLinearHdr(result), sceneSample.a)',
    );
  });

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
