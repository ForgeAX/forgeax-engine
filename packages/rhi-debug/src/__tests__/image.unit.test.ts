import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBufferRecords } from '../buffer-records';
import type { WorkEntry } from '../frame-model';
import { decodeImage, encodePng, extractTile, imageStats, readbackImage, toRgba8 } from '../image';
import { bindingReadRequest } from '../replay/batch';
import type { ReplayReadbackResult } from '../replay/readback';

function f16(value: number): number {
  if (value === 0) return 0;
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  const bits = view.getUint32(0);
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  return ((bits >>> 16) & 0x8000) | (exponent << 10) | ((bits >>> 13) & 0x3ff);
}

function bufferRead(bytes: Uint8Array): ReplayReadbackResult {
  return {
    resourceId: 'buffer:probes',
    kind: 'buffer',
    bytes,
    provenance: { generation: 1, resourceId: 'buffer:probes', subresource: null },
  };
}

describe('image decode', () => {
  it('decodes a padded storage-buffer region as rgba16float texels', () => {
    // 2x2 texels, 8 bytes each, rows padded to 24 bytes after a 4-byte header.
    const bytes = new Uint8Array(4 + 24 * 2);
    const view = new DataView(bytes.buffer);
    const texels = [
      [1, 2, 3, 1],
      [0.5, 0.25, 4, 1],
      [-1, 8, 0, 0.5],
      [16, 0, 2, 1],
    ];
    texels.forEach((texel, index) => {
      const base = 4 + Math.floor(index / 2) * 24 + (index % 2) * 8;
      for (const [c, value] of texel.entries()) view.setUint16(base + c * 2, f16(value), true);
    });
    const image = readbackImage(bufferRead(bytes), {
      format: 'rgba16float',
      width: 2,
      height: 2,
      offset: 4,
      bytesPerRow: 24,
    });
    if (!image.ok) throw new Error(image.error.hint);
    expect(Array.from(image.value.data)).toEqual(texels.flat());
    expect(imageStats(image.value)).toEqual({
      min: [-1, 0, 0, 0.5],
      max: [16, 8, 4, 1],
      mean: [16.5 / 4, 10.25 / 4, 9 / 4, 3.5 / 4],
      nonFinite: 0,
    });
  });

  it('unpacks shared-exponent and small-float HDR formats', () => {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    // rgb9e5: mantissas 256, 128, 64 with exponent 16 -> 2^(16-15-9) * m.
    view.setUint32(0, 256 | (128 << 9) | (64 << 18) | (16 << 27), true);
    const shared = decodeImage(bytes, { format: 'rgb9e5ufloat', width: 1, height: 1 });
    if (!shared.ok) throw new Error(shared.error.hint);
    expect(Array.from(shared.value.data)).toEqual([1, 0.5, 0.25, 1]);
    // rg11b10: 1.0 = exponent 15, mantissa 0.
    view.setUint32(4, (15 << 6) | ((16 << 6) << 11) | ((14 << 5) << 22), true);
    const small = decodeImage(bytes, { format: 'rg11b10ufloat', width: 1, height: 1, offset: 4 });
    if (!small.ok) throw new Error(small.error.hint);
    expect(Array.from(small.value.data)).toEqual([1, 2, 0.5, 1]);
  });

  it('rejects undecodable formats and short ranges with structured errors', () => {
    expect(
      decodeImage(new Uint8Array(16), { format: 'bc7-rgba-unorm', width: 1, height: 1 }),
    ).toMatchObject({ ok: false, error: { code: 'readback-failed' } });
    expect(
      decodeImage(new Uint8Array(15), { format: 'rgba32float', width: 1, height: 1 }),
    ).toMatchObject({ ok: false, error: { code: 'readback-failed' } });
    expect(readbackImage(bufferRead(new Uint8Array(16)))).toMatchObject({ ok: false });
  });

  it('extracts one bordered octahedral tile from a row-major probe atlas', () => {
    // 4 tiles of 4x4 in a 8x8 r32float atlas; texel value = tile * 100 + y * 10 + x.
    const bytes = new Uint8Array(8 * 8 * 4);
    const view = new DataView(bytes.buffer);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const tile = Math.floor(y / 4) * 2 + Math.floor(x / 4);
        view.setFloat32((y * 8 + x) * 4, tile * 100 + (y % 4) * 10 + (x % 4), true);
      }
    const atlas = decodeImage(bytes, { format: 'r32float', width: 8, height: 8 });
    if (!atlas.ok) throw new Error(atlas.error.hint);
    const tile = extractTile(atlas.value, { tileWidth: 4, tileHeight: 4, index: 3, border: 1 });
    if (!tile.ok) throw new Error(tile.error.hint);
    expect([tile.value.width, tile.value.height]).toEqual([2, 2]);
    expect(Array.from(tile.value.data).filter((_, i) => i % 4 === 0)).toEqual([311, 312, 321, 322]);
    expect(extractTile(atlas.value, { tileWidth: 4, tileHeight: 4, index: 4 })).toMatchObject({
      ok: false,
    });
  });

  it('counts non-finite texels outside the statistics and maps HDR for display', () => {
    const image = {
      width: 3,
      height: 1,
      data: new Float32Array([Number.NaN, 0, 0, 1, 1, 3, 0.5, 1, 0.25, 0, -1, 2]),
    };
    expect(imageStats(image)).toMatchObject({ nonFinite: 1, max: [1, 3, 0.5, 2] });
    expect(Array.from(toRgba8(image))).toEqual([0, 0, 0, 255, 255, 255, 128, 255, 64, 0, 0, 255]);
    expect(Array.from(toRgba8(image, { tonemap: 'reinhard', exposure: 2 })).slice(4, 8)).toEqual([
      170, 219, 128, 255,
    ]);
    expect(Array.from(toRgba8(image, { range: [-1, 3] })).slice(8, 12)).toEqual([80, 64, 0, 255]);
  });

  it('encodes a deterministic, valid RGBA8 PNG', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 9]);
    const png = encodePng(2, 2, rgba);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(encodePng(2, 2, rgba)).toEqual(png);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(2);
    const idatLength = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(Array.from(raw)).toEqual([0, ...rgba.subarray(0, 8), 0, ...rgba.subarray(8)]);
  });
});

describe('GI buffer reads', () => {
  it('decodes packed f16 record fields beside 32-bit ids', () => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 7, true);
    for (const [i, value] of [0.5, -2, 1024, 0.125].entries())
      view.setUint16(4 + i * 2, f16(value), true);
    const records = decodeBufferRecords(
      bufferRead(bytes),
      {
        stride: 16,
        fields: [
          { name: 'probe', offset: 0, type: 'u32', components: 1 },
          { name: 'irradiance', offset: 4, type: 'f16', components: 4 },
        ],
      },
      { first: 0, count: 1 },
    );
    if (!records.ok) throw new Error(records.error.hint);
    expect(records.value.records[0]?.fields).toEqual({
      probe: [7],
      irradiance: [0.5, -2, 1024, 0.125],
    });
  });

  it('resolves a work binding into its bound buffer window', () => {
    const work = {
      workIndex: 4,
      bindings: [
        {
          groupIndex: 1,
          binding: 2,
          bindGroupId: 'group:1',
          resourceId: 'buffer:probes',
          resourceKind: 'buffer',
          bufferOffset: 256,
          bufferSize: 1024,
          dynamicOffset: 512,
        },
        {
          groupIndex: 0,
          binding: 0,
          bindGroupId: 'group:0',
          resourceId: 'view:atlas',
          resourceKind: 'texture-view',
          bufferOffset: null,
          bufferSize: null,
          dynamicOffset: null,
        },
      ],
    } as unknown as WorkEntry;
    expect(bindingReadRequest(work, 1, 2)).toEqual({
      ok: true,
      value: {
        resourceId: 'buffer:probes',
        workIndex: 4,
        subresource: { offset: 768, size: 1024 },
      },
    });
    expect(bindingReadRequest(work, 0, 0)).toEqual({
      ok: true,
      value: { resourceId: 'view:atlas', workIndex: 4 },
    });
    expect(bindingReadRequest(work, 3, 0)).toMatchObject({
      ok: false,
      error: { code: 'readback-failed' },
    });
  });

  it.each([
    { size: 1280, dynamic: null, offset: 0 },
    { size: 256, dynamic: 512, offset: 512 },
  ])('preserves size and dynamic offset when the static buffer offset is omitted: %o', (row) => {
    // The Sponza gather binds 1280 bytes of View buffer:163 without an explicit
    // offset. Reading the whole 66560-byte allocation loses the actual window.
    const work = {
      workIndex: 521,
      bindings: [
        {
          groupIndex: 0,
          binding: 8,
          resourceId: 'buffer:view-window',
          resourceKind: 'buffer',
          bufferOffset: null,
          bufferSize: row.size,
          dynamicOffset: row.dynamic,
        },
      ],
    } as unknown as WorkEntry;
    expect(bindingReadRequest(work, 0, 8).unwrap()).toEqual({
      resourceId: 'buffer:view-window',
      workIndex: 521,
      subresource: { offset: row.offset, size: row.size },
    });
  });
});
