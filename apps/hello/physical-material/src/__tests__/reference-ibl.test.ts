import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { srgbChannelToLinear } from '@forgeax/engine-types';
// @ts-expect-error Reference evaluator is an offline JavaScript module.
import { diffuseIblReference, integrateDiffuseEnvironment } from '../../evidence/reference-ibl.mjs';

describe('physical reference diffuse radiance', () => {
  it('returns the albedo under unit Lambert-normalized irradiance', () => {
    expect(diffuseIblReference([0.6, 0.2, 0.1], [1, 1, 1])).toEqual([0.6, 0.2, 0.1]);
  });
  it('scales linearly with lighting and never couples color channels', () => {
    const base = diffuseIblReference([0.6, 0.2, 0.1], [0.2, 0.3, 0.4]);
    const double = diffuseIblReference([0.6, 0.2, 0.1], [0.4, 0.6, 0.8]);
    base.forEach((value: number, channel: number) => expect(double[channel]).toBeCloseTo(value * 2, 12));
    expect(diffuseIblReference([0.6, 0.2, 0.1], [0, 1, 0])).toEqual([0, 0.2, 0]);
  });
});

describe('source environment quadrature', () => {
  const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  function fixture(sample: (x: number, y: number) => number[]) {
    const width = 256;
    const height = 128;
    const data = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...sample(x, y), 1], (y * width + x) * 4);
    return { width, height, data };
  }
  it('integrates unit radiance to unit E/pi for every axis', () => {
    const result = integrateDiffuseEnvironment(fixture(() => [1, 1, 1]), normals);
    for (const value of result.flat()) expect(value).toBeCloseTo(1, 3);
  });
  it('preserves channel isolation and absolute intensity', () => {
    const result = integrateDiffuseEnvironment(fixture(() => [0, 2, 0]), normals);
    for (const rgb of result) {
      expect(rgb[0]).toBe(0);
      expect(rgb[1]).toBeCloseTo(2, 3);
      expect(rgb[2]).toBe(0);
    }
  });
  it('distinguishes illuminated and opposing hemispheres', () => {
    const result = integrateDiffuseEnvironment(fixture((_x, y) => y >= 64 ? [1, 0, 0] : [0, 0, 0]), normals);
    expect(result[2][0]).toBeCloseTo(1, 3);
    expect(result[3][0]).toBe(0);
    expect(result[0][0]).toBeCloseTo(0.5, 3);
  });
});

it('reproduces the committed HDR oracle from its frozen source inputs', () => {
  const generator = fileURLToPath(new URL('../../evidence/reference-generator.mjs', import.meta.url));
  expect(execFileSync(process.execPath, [generator, '--check'], { encoding: 'utf8' })).toContain('reference artifact verified: 16 rows');
});

it('projects authored sRGB into the IBL reference domain without changing direct reference inputs', () => {
  const generatorSource = readFileSync(
    new URL('../../evidence/reference-generator.mjs', import.meta.url),
    'utf8',
  );
  const input = JSON.parse(
    readFileSync(new URL('../../evidence/case-input.json', import.meta.url), 'utf8'),
  ) as { material: { baseColor: number[] } };
  const artifact = JSON.parse(
    readFileSync(new URL('../../evidence/reference-linear-hdr.json', import.meta.url), 'utf8'),
  ) as { artifactId: string; revision: string };
  const authoredRed = input.material.baseColor[0];
  if (authoredRed === undefined) throw new Error('physical material fixture is missing baseColor.r');

  expect(generatorSource).toContain("import { srgbChannelToLinear } from '@forgeax/engine-types'");
  expect(generatorSource).toContain('const iblMaterialFixture = {');
  expect(generatorSource).toContain('integrateEnvironment(normal, view, iblMaterialFixture, environmentRadiance)');
  expect(generatorSource).toContain('const baseLobe = materialFixture.baseColor');
  expect(authoredRed).toBe(0.62);
  expect(srgbChannelToLinear(authoredRed)).toBeCloseTo(0.34239164, 8);
  expect(artifact).toMatchObject({
    artifactId: 'physical-material-reference-v5',
    revision: 'physical-material-reference-r5',
  });
});
