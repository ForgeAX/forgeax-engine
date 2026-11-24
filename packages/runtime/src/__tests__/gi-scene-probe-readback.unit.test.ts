import { expect, it } from 'vitest';
import {
  requireSceneProbeReadback,
  type SceneProbeReadback,
  sceneProbeReadbackLayout,
} from './gi-scene-probe-readback.fixture';

const previous = {
  gather: 'irradiance-field',
  state: 'ready',
  generation: 3,
  submittedFrames: 105,
};
const current = { ...previous, submittedFrames: 106 };
const sample = (): SceneProbeReadback => ({
  meta: new Uint8Array(1344 * 16),
  list: new Uint8Array(1344 * 4),
  metaIdentity: 7,
  listIdentity: 8,
  count: 1344,
  capacity: 1344,
});

it('bounds the actual 1344-probe metadata and list to 860160 bytes across 32 frames', () => {
  const layout = sceneProbeReadbackLayout(previous, current, 1344, 1344);
  expect(layout).toEqual({ metaBytes: 21504, listBytes: 5376 });
  expect((layout.metaBytes + layout.listBytes) * 32).toBe(860160);
  expect(() => sceneProbeReadbackLayout(previous, current, 2048, 2048)).toThrow('raw cap');
});

it('rejects stale, missing, preparing, skipped, and changed-generation producers before lookup', () => {
  for (const state of [
    previous,
    { ...current, state: 'preparing' },
    { ...current, generation: 4 },
    { ...current, generation: 4, submittedFrames: 0 },
    { ...current, generation: 4, submittedFrames: 1 },
    { ...current, submittedFrames: 107 },
    { ...current, gather: 'screen-probe' },
  ])
    expect(() => sceneProbeReadbackLayout(previous, state, 1344, 1344)).toThrow();
  expect(() => sceneProbeReadbackLayout(undefined, current, 1344, 1344)).toThrow();
  expect(() => sceneProbeReadbackLayout(previous, current, 1343, 1344)).toThrow();
});

it('preserves unsigned update bits, relocation state, offsets, and list flags without interpreting success', () => {
  const first = sample();
  const meta = new DataView(first.meta.buffer);
  const list = new DataView(first.list.buffer);
  meta.setUint32(0, 0xffffffff, true);
  meta.setUint32(4, 3, true);
  meta.setUint32(8, 0x80000000, true);
  list.setUint32(0, 0xc000053f, true);
  const second = { ...first, meta: first.meta.slice(), list: first.list.slice() };
  // Zero increment or a reset is evidence, not a failed or successful lighting assertion.
  new DataView(second.meta.buffer).setUint32(0, 0, true);
  requireSceneProbeReadback(undefined, first);
  requireSceneProbeReadback(first, second);
  expect(new DataView(first.meta.buffer).getUint32(0, true)).toBe(0xffffffff);
  expect(new DataView(second.meta.buffer).getUint32(4, true)).toBe(3);
  expect(new DataView(second.meta.buffer).getUint32(8, true)).toBe(0x80000000);
  expect(new DataView(second.list.buffer).getUint32(0, true)).toBe(0xc000053f);
});

it('rejects changed, aliased, absent, or truncated resource identities and extents', () => {
  const first = sample();
  for (const second of [
    { ...first, metaIdentity: 9 },
    { ...first, listIdentity: 9 },
    { ...first, metaIdentity: 0 },
    { ...first, metaIdentity: first.listIdentity },
    { ...first, meta: first.meta.subarray(16) },
    { ...first, list: first.list.subarray(4) },
  ])
    expect(() => requireSceneProbeReadback(first, second)).toThrow();
});
