import { readFileSync } from 'node:fs';
import { isSupportedVariantDefines } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { supportedVariantDefines } from '../supported-variant-defines.js';

function originalRows(axes: readonly string[]): Record<string, boolean>[] {
  return Array.from({ length: 1 << axes.length }, (_, offset) => {
    const mask = (1 << axes.length) - 1 - offset;
    return Object.fromEntries(
      axes.map((axis, index) => [axis, Boolean(mask & (1 << (axes.length - 1 - index)))]),
    );
  }).filter(isSupportedVariantDefines);
}

it('preserves the complete descending row order and owning refusals for every axis subset', () => {
  const axes = [
    'STORAGE_BUFFER_AVAILABLE',
    'WATER_WAVES_AVAILABLE',
    'WATER_INFO_RGBA16',
    'STANDARD_LEAN_INPUTS',
    'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
    'COVERAGE_ONLY',
    'LOD_DITHER',
    'CLIPPING_PLANES',
  ];
  for (let selection = 0; selection < 1 << axes.length; selection++) {
    const selected = axes.filter((_, index) => selection & (1 << index));
    expect(supportedVariantDefines(selected)).toEqual(originalRows(selected));
  }
  const repeated = ['WATER_WAVES_AVAILABLE', 'STORAGE_BUFFER_AVAILABLE', 'WATER_WAVES_AVAILABLE'];
  expect(supportedVariantDefines(repeated)).toEqual(originalRows(repeated));
});

it('retains the exact Standard matrix and all four maintained lean Water lanes', () => {
  const source = readFileSync(
    new URL('../../../shader/src/default-standard-pbr.wgsl', import.meta.url),
    'utf8',
  );
  const axes = [...source.matchAll(/^#pragma variant_axis (\w+)$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  const rows = supportedVariantDefines(axes);
  expect(rows).toHaveLength(7312);
  expect(rows.every(isSupportedVariantDefines)).toBe(true);
  const lean = rows.filter((row) => row.STANDARD_LEAN_INPUTS === true);
  for (const waves of [true, false]) {
    for (const rgba16 of [true, false]) {
      expect(
        lean.filter(
          (row) => row.WATER_WAVES_AVAILABLE === waves && row.WATER_INFO_RGBA16 === rgba16,
        ),
      ).toHaveLength(288);
    }
  }
});
