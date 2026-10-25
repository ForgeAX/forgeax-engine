import { expect, it } from 'vitest';
import { skinDemandLayout, writeSkinDemandConstants } from '../gpu-driven/skin-demand';

it('keeps visible union and late mirror separate from aligned transient Skin output', () => {
  const layout = skinDemandLayout(65, 320, 64 * 16 * 2);
  expect(layout.descriptorBase * 16).toBe(2048);
  expect(layout.hashCapacity).toBe(256);
  expect(layout.rosterCapacity).toBe(128);
  expect(layout.rosterBase).toBeGreaterThan(layout.descriptorBase);
  expect(layout.paletteBase % 4).toBe(0);
  expect(layout.paletteBase).toBeGreaterThanOrEqual(layout.candidateBase + 128);
  expect(layout.outputBytes).toBe(layout.paletteBase * 16 + 320 * 128);
  expect(layout.counterWords).toBe(260);
});

it('sizes the demand roster by joints and keeps one reference per actual candidate', () => {
  // A 1M-candidate task with 128 one-joint Skin bindings: only the reference
  // column scales with candidates, never the hash or roster.
  const visiblePrefix = 1_057_152 * 16 * 2;
  const layout = skinDemandLayout(1_000_372, 128, visiblePrefix);
  expect(layout.rosterCapacity).toBe(128);
  expect(layout.hashCapacity).toBe(256);
  expect(layout.candidateCapacity).toBe(1_048_576);
  expect(layout.candidateBase).toBe(layout.rosterBase + layout.rosterCapacity);
  expect(layout.paletteBase).toBeGreaterThanOrEqual(layout.candidateBase + 1_048_576);
  expect(layout.outputBytes - visiblePrefix).toBeLessThan(1_048_576 * 16 + 64 * 1024);
  expect(layout.outputBytes).toBeLessThan(134_217_728);
  // Distinct keys can never exceed candidates either.
  expect(skinDemandLayout(3, 4096).rosterCapacity).toBe(4);
});

it('writes only the supplied task constant window with integer roots and addresses', () => {
  const bytes = new Uint32Array(20).fill(0x12345678),
    layout = skinDemandLayout(3, 7);
  writeSkinDemandConstants(new DataView(bytes.buffer), 16, layout, 0xffffffff, 79, 3, 64);
  expect(Array.from(bytes.slice(0, 4))).toEqual(Array(4).fill(0x12345678));
  expect(Array.from(bytes.slice(16))).toEqual(Array(4).fill(0x12345678));
  expect(Array.from(bytes.slice(4, 16))).toEqual([
    0xffffffff,
    79,
    3,
    8,
    64,
    layout.descriptorBase,
    layout.rosterBase,
    layout.paletteBase,
    7,
    4,
    0,
    65535,
  ]);
});

it.each([
  -1,
  NaN,
  Infinity,
  0x100000000,
  0.5,
])('rejects invalid capacity %s before deriving addresses', (capacity) => {
  expect(() => skinDemandLayout(capacity, 1)).toThrow();
  expect(() => skinDemandLayout(1, capacity)).toThrow();
  expect(() => skinDemandLayout(1, 1, capacity)).toThrow();
});

it('rejects address overflow and mismatched extents before changing task constants', () => {
  expect(() => skinDemandLayout(0xffffffff, 1)).toThrow();
  expect(() => skinDemandLayout(1, 0xffffffff)).toThrow();
  const data = new DataView(new ArrayBuffer(48)),
    layout = skinDemandLayout(2, 2);
  expect(() => writeSkinDemandConstants(data, 0, layout, 1, 2, 3)).toThrow();
  expect(() => writeSkinDemandConstants(data, 0, layout, -1, 2, 2)).toThrow();
  expect(() => writeSkinDemandConstants(data, 0, layout, 1, 2, 2, 0xffffffff)).toThrow();
  expect(() => writeSkinDemandConstants(data, 1, layout, 1, 2, 2)).toThrow();
  expect(() => writeSkinDemandConstants(data, 4, layout, 1, 2, 2)).toThrow();
  expect(() => writeSkinDemandConstants(data, 0, layout, 1, 2, 2, 0, 0, 0)).toThrow();
  expect(() => writeSkinDemandConstants(data, 0, layout, 1, 2, 2, 0, 0, 1)).toThrow();
  expect(() => writeSkinDemandConstants(data, 0, layout, 1, 2, 2, 0, 0xffffffff)).toThrow();
  expect(Array.from(new Uint8Array(data.buffer))).toEqual(Array(48).fill(0));
});
