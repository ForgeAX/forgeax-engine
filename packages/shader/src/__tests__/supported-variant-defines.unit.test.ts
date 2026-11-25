import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ShaderVariantDomain, supportedVariantDefines } from '../supported-variant-defines.js';
import { isSupportedVariantDefines } from '../variant-permutation-rules.js';

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
    expect([...supportedVariantDefines(selected)]).toEqual(originalRows(selected));
  }
  const repeated = ['WATER_WAVES_AVAILABLE', 'STORAGE_BUFFER_AVAILABLE', 'WATER_WAVES_AVAILABLE'];
  expect([...supportedVariantDefines(repeated)]).toEqual(originalRows(repeated));
});

it('retains the exact Standard matrix and all four maintained lean Water lanes', () => {
  const source = readFileSync(new URL('../default-standard-pbr.wgsl', import.meta.url), 'utf8');
  const axes = [...source.matchAll(/^#pragma variant_axis (\w+)$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  const rows = [...supportedVariantDefines(axes)];
  const constrained = [...supportedVariantDefines(axes, { STORAGE_BUFFER_AVAILABLE: false })];
  expect(constrained).toEqual(rows.filter((row) => row.STORAGE_BUFFER_AVAILABLE === false));
  expect(rows).toHaveLength(13000);
  expect(rows.every(isSupportedVariantDefines)).toBe(true);
  const withoutSsr = rows.filter((row) => !row.FORWARD_INLINE_SSR);
  const withSsr = rows.filter((row) => row.FORWARD_INLINE_SSR);
  expect(withoutSsr).toHaveLength(11272);
  expect(withSsr).toHaveLength(1728);
  const withoutSsrKeys = new Set(withoutSsr.map((row) => JSON.stringify(row)));
  for (const row of withSsr) {
    expect(row.EXTENDED_LIGHTING_AVAILABLE).toBe(true);
    expect(row.REFLECTION_FALLBACK_AVAILABLE).toBe(false);
    expect(row.VISIBLE_SURFACE_AVAILABLE).toBe(false);
    expect(withoutSsrKeys.has(JSON.stringify({ ...row, FORWARD_INLINE_SSR: false }))).toBe(true);
  }
  const added = rows.filter((row) => !row.DIRECTIONAL_SHADOW_SIMPLE && row.LEAN_LIGHTING);
  expect(added.filter((row) => !row.FORWARD_INLINE_SSR)).toHaveLength(320);
  expect(added.filter((row) => row.FORWARD_INLINE_SSR)).toHaveLength(80);
  const simpleShadowKeys = new Set(
    rows.filter((row) => row.DIRECTIONAL_SHADOW_SIMPLE).map((row) => JSON.stringify(row)),
  );
  for (const row of added)
    expect(simpleShadowKeys.has(JSON.stringify({ ...row, DIRECTIONAL_SHADOW_SIMPLE: true }))).toBe(
      true,
    );
  const lean = rows.filter((row) => row.STANDARD_LEAN_INPUTS === true);
  for (const waves of [true, false]) {
    for (const rgba16 of [true, false]) {
      const lane = lean.filter(
        (row) => row.WATER_WAVES_AVAILABLE === waves && row.WATER_INFO_RGBA16 === rgba16,
      );
      expect(lane.filter((row) => !row.FORWARD_INLINE_SSR)).toHaveLength(640);
      expect(lane.filter((row) => row.FORWARD_INLINE_SSR)).toHaveLength(96);
    }
  }
});

it('selects the same legal row as exhaustive scoring for every partial assignment', () => {
  const axes = [
    'PROBE_BLEND_AVAILABLE',
    'STORAGE_BUFFER_AVAILABLE',
    'CLUSTER_FORWARD_AVAILABLE',
    'CUSTOM_A',
    'CUSTOM_B',
  ];
  const domain = new ShaderVariantDomain(axes);
  const preferences = [
    ['PROBE_BLEND_AVAILABLE', true, 2],
    ['STORAGE_BUFFER_AVAILABLE', false, 2],
    ['CLUSTER_FORWARD_AVAILABLE', false, 1],
  ] as const;
  const rows = [...supportedVariantDefines(axes)]
    .map((defines) => ({
      defines,
      key: axes.every((axis) => defines[axis])
        ? ''
        : [...axes]
            .sort()
            .map((axis) => `${axis}=${defines[axis]}`)
            .join('+'),
      score: preferences.reduce(
        (sum, [axis, value, weight]) => sum + (defines[axis] === value ? weight : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  for (let code = 0; code < 3 ** axes.length; code++) {
    const constraints: Record<string, boolean> = {};
    let digits = code;
    for (const axis of axes) {
      const digit = digits % 3;
      if (digit !== 0) constraints[axis] = digit === 2;
      digits = Math.floor(digits / 3);
    }
    const expected = rows.find(({ defines }) =>
      Object.entries(constraints).every(([axis, value]) => defines[axis] === value),
    );
    expect(domain.preferred(constraints, preferences)).toEqual(expected?.defines);
  }
});
