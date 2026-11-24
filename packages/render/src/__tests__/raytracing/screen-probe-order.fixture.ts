import { SCREEN_PROBE_RECORD_BYTES } from '../../raytracing/screen-probe-plan';

/** Physical allocation is cleared even when the advertised adaptive capacity is zero. */
export function emptyOrderProbeRecords(count: number): Uint32Array {
  const words = new Uint32Array((count * SCREEN_PROBE_RECORD_BYTES) / 4);
  for (let i = 0; i < count; i++) words[(i * SCREEN_PROBE_RECORD_BYTES) / 4 + 7] = 0xffffffff;
  return words;
}
