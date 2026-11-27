import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { SCREEN_PROBE_RECORD_BYTES } from '../../raytracing/screen-probe-plan';
import { SCREEN_PROBE_WORLD_RECORDS_WGSL } from '../../raytracing/screen-probe-records';
import { emptyOrderProbeRecords } from './screen-probe-order.fixture';

it('clears every actual order allocation record without writing a pixel sentinel into another field', () => {
  const words = emptyOrderProbeRecords(128);
  expect(words.byteLength).toBe(128 * SCREEN_PROBE_RECORD_BYTES);
  const view = new DataView(words.buffer);
  for (let record = 0; record < 128; record++) {
    for (let offset = 0; offset < SCREEN_PROBE_RECORD_BYTES; offset += 4) {
      expect(
        view.getUint32(record * SCREEN_PROBE_RECORD_BYTES + offset, true),
        `record ${record}, byte ${offset}`,
      ).toBe(offset === 28 ? 0xffffffff : 0);
    }
  }
});

it('keeps the actual current WGSL order record stride aligned with its CPU producer', async () => {
  const compiled = (
    await compileShader(
      `${SCREEN_PROBE_WORLD_RECORDS_WGSL}
@group(0) @binding(0) var<storage, read_write> probes: array<ScreenProbe>;
@compute @workgroup_size(1) fn orderRecordAbi(){ probes[0].pixel = probes[1].pixel; }`,
      { id: 'screen-probe-order-record-abi' },
    )
  ).unwrap();
  const probes = compiled.reflection.boundGlobals.find(
    (row) => row.group === 0 && row.binding === 0,
  );
  expect(probes?.elementStride).toBe(SCREEN_PROBE_RECORD_BYTES);
  expect(emptyOrderProbeRecords(2).byteLength).toBe(2 * (probes?.elementStride ?? 0));
});
