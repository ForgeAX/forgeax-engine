import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  SCREEN_PROBE_FRAME_BYTES,
  SCREEN_PROBE_RECORD_BYTES,
} from '../../raytracing/screen-probe-plan';
import { SCREEN_PROBE_WORLD_RECORDS_WGSL } from '../../raytracing/screen-probe-records';
import { packCardSamplingInputs } from './screen-probe-card-sampling.fixture';

it('packs two actual Probe records and the complete frame with the maintained query policy', async () => {
  const compiled = (
    await compileShader(
      `${SCREEN_PROBE_WORLD_RECORDS_WGSL}
@group(0) @binding(8) var<storage,read_write> probes:array<ScreenProbe>;
@group(0) @binding(9) var<uniform> frame:ScreenProbeFrame;
@compute @workgroup_size(1) fn verify(){probes[1].pixel=frame.extent.x;}`,
      { id: 'card-sampling-record-abi' },
    )
  ).unwrap();
  const probe = compiled.reflection.boundGlobals.find((row) => row.binding === 8);
  expect(probe?.elementStride).toBe(SCREEN_PROBE_RECORD_BYTES);
  const input = packCardSamplingInputs();
  expect(input.probes.byteLength).toBe(2 * SCREEN_PROBE_RECORD_BYTES);
  expect(input.frame.byteLength).toBe(SCREEN_PROBE_FRAME_BYTES);
  // The captured old 64B allocation cannot even hold one current 96B record.
  expect(64).toBeLessThan(probe?.elementStride ?? 0);
  for (const [i, x] of [-0.1, 0.1].entries()) {
    const data = new DataView(
      input.probes.buffer,
      i * SCREEN_PROBE_RECORD_BYTES,
      SCREEN_PROBE_RECORD_BYTES,
    );
    expect(data.getFloat32(0, true)).toBe(Math.fround(x));
    expect(data.getFloat32(4, true)).toBe(-0.25);
    expect(data.getFloat32(8, true)).toBe(1);
    expect(data.getUint32(28, true)).toBe(i);
    expect(data.getUint32(44, true)).toBe(0xffff_ffff);
    expect(data.getUint32(60, true)).toBe(0xffff_ffff);
    expect(
      Array.from(new Uint32Array(input.probes.buffer, i * SCREEN_PROBE_RECORD_BYTES + 64, 8)),
    ).toEqual(new Array(8).fill(0));
  }
  const frame = new DataView(input.frame.buffer);
  expect(Array.from(new Uint32Array(input.frame.buffer, 0, 8))).toEqual([2, 1, 2, 1, 2, 0, 8, 0]);
  expect(frame.getFloat32(60, true)).toBe(4);
  expect(frame.getUint32(80, true)).toBe(256);
  expect(frame.getFloat32(84, true)).toBe(1);
  expect(new DataView(new ArrayBuffer(96)).getUint32(80, true)).toBe(0);
});
