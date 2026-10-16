import { describe, expect, it } from 'vitest';
import { type BufferRecordLayout, decodeBufferRecords } from '../buffer-records';

const layout: BufferRecordLayout = {
  stride: 16,
  fields: [
    { name: 'id', offset: 0, type: 'u32', components: 1 },
    { name: 'values', offset: 4, type: 'f32', components: 3 },
  ],
};
function read() {
  const bytes = new Uint8Array(32),
    v = new DataView(bytes.buffer);
  v.setUint32(0, 0xffabcdef, true);
  v.setFloat32(4, NaN, true);
  v.setFloat32(8, Infinity, true);
  v.setFloat32(12, -Infinity, true);
  return {
    resourceId: 'output',
    kind: 'buffer' as const,
    bytes,
    provenance: {
      generation: 3,
      resourceId: 'output',
      selectedWorkIndex: 7,
      subresource: { offset: 64, size: 32 },
    },
  };
}
describe('structured GPU buffer inspection', () => {
  it('preserves unsigned IDs, nonfinite diagnostics, range indices and work provenance', () => {
    const input = read();
    const out = decodeBufferRecords(input, layout, { first: 4, count: 2 }).unwrap();
    expect(out.provenance).toEqual(input.provenance);
    expect(out.records[0]).toEqual({
      index: 4,
      fields: { id: [0xffabcdef], values: ['NaN', '+Infinity', '-Infinity'] },
    });
  });
  it('fails bounded layout/range errors and truncated readback without throwing', () => {
    for (const invalid of [
      { ...layout, stride: 3 },
      { ...layout, fields: [...layout.fields, ...layout.fields] },
      {
        ...layout,
        fields: [{ name: 'outside', offset: 12, type: 'u32' as const, components: 2 as const }],
      },
    ])
      expect(decodeBufferRecords(read(), invalid, { first: 0, count: 2 }).ok).toBe(false);
    for (const range of [
      { first: -1, count: 2 },
      { first: 0, count: 0 },
      { first: 0, count: 4097 },
      { first: 0, count: 1 },
    ])
      expect(decodeBufferRecords(read(), layout, range).ok).toBe(false);
  });
});
