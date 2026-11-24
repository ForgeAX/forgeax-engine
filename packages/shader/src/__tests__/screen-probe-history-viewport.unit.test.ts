import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { executable } from './sdf-surface-root.fixture';

const source = readFileSync(new URL('../ray-screen-probe.wgsl', import.meta.url), 'utf8');
const accepts = executable<boolean>(source, 'probeHistoryUvValid', 'uv', {});

it('rejects actual first-motion probes beyond the previous view before history taps clamp', () => {
  // Actual 6e first-motion replay: probes 0 and 3 had 49/64 and 44/64
  // retained directions, although both project above the previous viewport.
  for (const uv of [
    { x: 0.19636074226555528, y: -0.0747428369229447 },
    { x: 1.1651106966524447, y: -0.0747428369229447 },
    { x: 1.1651106966524447, y: 0.2377571379379647 },
  ]) {
    expect(accepts(uv)).toBe(false);
  }
});

it('detects restoring the old one-tile history border', () => {
  const injected = source.replace(
    'return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0;',
    'return uv.x >= -0.25 && uv.y >= -0.25 && uv.x <= 1.25 && uv.y <= 1.25;',
  );
  expect(injected).not.toBe(source);
  const acceptsOld = executable<boolean>(injected, 'probeHistoryUvValid', 'uv', {});
  const actual = { x: 1.1651106966524447, y: -0.0747428369229447 };
  expect(acceptsOld(actual)).toBe(true);
  expect(accepts(actual)).toBe(false);
});

it('retains the closed previous-view edges and valid pixel centers without a tile border', () => {
  for (const uv of [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 0.5 / 32, y: 31.5 / 32 },
    { x: 31.5 / 32, y: 0.5 / 32 },
  ]) {
    expect(accepts(uv)).toBe(true);
  }
  for (const uv of [
    { x: -(2 ** -126), y: 0.5 },
    { x: 1 + 2 ** -23, y: 0.5 },
    { x: 0.5, y: -(2 ** -126) },
    { x: 0.5, y: 1 + 2 ** -23 },
    { x: NaN, y: 0.5 },
    { x: 0.5, y: Infinity },
  ]) {
    expect(Object.is(Math.fround(uv.x), uv.x)).toBe(true);
    expect(Object.is(Math.fround(uv.y), uv.y)).toBe(true);
    expect(accepts(uv)).toBe(false);
  }
});
