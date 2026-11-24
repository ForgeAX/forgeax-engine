import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import { WORLD_CARD_RADIANCE_WGSL, worldTraversalWgsl } from '../../raytracing/world-traversal';
import {
  controlledCardFacingSource,
  packControlledCardFacingProbe,
} from './screen-probe-card-facing.fixture';

it('composes both controlled Hit suffixes while retaining full actual radiance and resolve bytes', async () => {
  for (const exact of [false, true]) {
    const control = controlledCardFacingSource(exact);
    expect(control.source).toContain(WORLD_CARD_RADIANCE_WGSL);
    expect(control.source.endsWith(control.tail)).toBe(true);
    expect(control.identity.receiverQualified).toBe(false);
    const compiled = (
      await compileShader(control.source, { id: `post-hit-card-facing-${exact}` })
    ).unwrap();
    expect(compiled.reflection.boundGlobals.find((row) => row.binding === 8)?.elementStride).toBe(
      96,
    );
  }
  const bytes = packControlledCardFacingProbe();
  expect(bytes.byteLength).toBe(96);
  expect(Array.from(new Float32Array(bytes.buffer, 0, 8))).toEqual([0, 0, 0, 1, 0, 0, 1, 0]);
  const words = new Uint32Array(bytes.buffer);
  expect(words[11]).toBe(0xffff_ffff);
  expect(words[15]).toBe(0xffff_ffff);
  expect(Array.from(words.subarray(16))).toEqual(new Array(8).fill(0));
});

it('rejects the old prefix and missing or duplicated splice markers', () => {
  const source = screenProbeWorldWgsl('global-sdf');
  const control = controlledCardFacingSource(false);
  expect(() =>
    controlledCardFacingSource(
      false,
      worldTraversalWgsl('global-sdf') + source.slice(control.prefix.length),
    ),
  ).toThrow();
  const marker = ' let status=hit.state.x;';
  expect(() => controlledCardFacingSource(false, source.replace(marker, ''))).toThrow();
  expect(() =>
    controlledCardFacingSource(false, source.replace(marker, marker + marker)),
  ).toThrow();
  const entry = '@compute @workgroup_size(64) fn traceWorldProbes(';
  expect(() => controlledCardFacingSource(false, source.replace(entry, entry + entry))).toThrow();
});
