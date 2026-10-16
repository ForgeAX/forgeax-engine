import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { encodeTape, halfToFloat, tapeDigest } from '@forgeax/engine-rhi-debug';
import { describe, expect, it } from 'vitest';
import { runCliRhiDebugOperation } from '../rhi-debug/cli-context';

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';

function f16(value: number): number {
  for (let bits = 0; bits < 0x7c00; bits++) if (halfToFloat(bits) === value) return bits;
  throw new Error(`${value} is not an exact half`);
}

describe.skipIf(SKIP_DAWN)('forgeax rhi read on Dawn', () => {
  it('reads a probe atlas buffer as records, tile stats and a PNG through the CLI host', async () => {
    // A 4x2 rgba16float probe atlas (two 2x2 octahedral tiles) in a storage buffer.
    const atlas = new Uint8Array(64);
    const view = new DataView(atlas.buffer);
    for (let texel = 0; texel < 8; texel++) {
      const tile = texel % 4 < 2 ? 0 : 1;
      const value = tile === 0 ? 0.5 : 4;
      for (let c = 0; c < 4; c++)
        view.setUint16(texel * 8 + c * 2, f16(c === 3 ? 1 : value * (c + 1)), true);
    }
    const hash = tapeDigest(atlas);
    const bytes = encodeTape({
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 1, blobCount: 1 },
      bootstrap: [
        {
          handleId: 'buffer:probes',
          kind: 'buffer',
          create: {
            kind: 'createBuffer',
            handleId: 'buffer:probes',
            desc: { size: 64, usage: 0x8c },
          },
          initialData: [{ hash, byteOffset: 0, byteLength: 64 }],
        },
        {
          // A MAP_READ | COPY_DST staging buffer: never a copy source.
          handleId: 'buffer:staging',
          kind: 'buffer',
          create: {
            kind: 'createBuffer',
            handleId: 'buffer:staging',
            desc: { size: 64, usage: 0x9 },
          },
          initialData: [],
        },
      ],
      events: [{ kind: 'frameMark', frameIdx: 0 }],
      blobs: [{ hash, bytes: atlas, compression: 'none' }],
    }).unwrap();
    const root = await mkdtemp(join(tmpdir(), 'rhi-read-'));
    const path = join(root, 'frame.rhitape');
    const png = join(root, 'out', 'tile1.png');
    try {
      await writeFile(path, bytes);
      const result = await runCliRhiDebugOperation('rhi.read', {
        artifact: path,
        reads: [
          {
            resourceId: 'buffer:probes',
            subresource: { offset: 32, size: 16 },
            records: {
              layout: {
                stride: 8,
                fields: [{ name: 'irradiance', offset: 0, type: 'f16', components: 4 }],
              },
              first: 0,
              count: 2,
            },
          },
          {
            // Records select their own rows: no subresource restating the byte window.
            resourceId: 'buffer:probes',
            records: {
              layout: {
                stride: 8,
                fields: [{ name: 'irradiance', offset: 0, type: 'f16', components: 4 }],
              },
              first: 5,
              count: 2,
            },
          },
          {
            resourceId: 'buffer:probes',
            subresource: { offset: 32, size: 16 },
            records: {
              layout: { stride: 8, fields: [{ name: 'x', offset: 0, type: 'u32', components: 1 }] },
              first: 1,
              count: 2,
            },
          },
          { resourceId: 'buffer:staging' },
          {
            resourceId: 'buffer:probes',
            image: {
              format: 'rgba16float',
              width: 4,
              height: 2,
              tile: { tileWidth: 2, tileHeight: 2, index: 1 },
              range: [0, 16],
              png,
            },
          },
        ],
      });
      if (!result.ok) throw new Error(result.error.hint);
      const [records, recordRows, outside, staging, image] = result.value.reads;
      expect(staging).toMatchObject({
        ok: false,
        error: { code: 'readback-unsupported', detail: { resourceId: 'buffer:staging' } },
      });
      expect(recordRows).toMatchObject({
        ok: true,
        value: {
          byteLength: 16,
          records: [
            { index: 5, fields: { irradiance: [0.5, 1, 1.5, 1] } },
            { index: 6, fields: { irradiance: [4, 8, 12, 1] } },
          ],
        },
      });
      expect(outside).toMatchObject({ ok: false, error: { code: 'read-request-invalid' } });
      expect(records).toMatchObject({
        ok: true,
        value: {
          byteLength: 16,
          provenance: { resourceId: 'buffer:probes' },
          records: [
            { index: 0, fields: { irradiance: [0.5, 1, 1.5, 1] } },
            { index: 1, fields: { irradiance: [0.5, 1, 1.5, 1] } },
          ],
        },
      });
      expect(image).toMatchObject({
        ok: true,
        value: {
          byteLength: 64,
          digest: hash,
          image: {
            width: 2,
            height: 2,
            png,
            stats: { min: [4, 8, 12, 1], max: [4, 8, 12, 1], nonFinite: 0 },
          },
        },
      });
      const file = new Uint8Array(await readFile(png));
      const idat = new DataView(file.buffer, file.byteOffset).getUint32(33);
      const rows = inflateSync(file.subarray(41, 41 + idat));
      // range [0, 16]: 4 -> 64, 8 -> 128, 12 -> 191; alpha 1 -> 255.
      expect(Array.from(rows.subarray(0, 9))).toEqual([0, 64, 128, 191, 255, 64, 128, 191, 255]);
      // The CLI replay device enables timestamps; a pass-free frame times nothing.
      expect(await runCliRhiDebugOperation('rhi.timing', { artifact: path })).toMatchObject({
        ok: true,
        value: { timing: { passes: [], totalGpuNanoseconds: 0 } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('names the native provider when a tape with acceleration structures meets Dawn', async () => {
    if (process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native') return;
    const bytes = encodeTape({
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 2, blobCount: 0 },
      bootstrap: [],
      events: [
        { kind: 'createTlas', handleId: 'tlas:scene', desc: { maxInstances: 1 } },
        { kind: 'frameMark', frameIdx: 0 },
      ],
      blobs: [],
    }).unwrap();
    const root = await mkdtemp(join(tmpdir(), 'rhi-read-as-'));
    const path = join(root, 'frame.rhitape');
    try {
      await writeFile(path, bytes);
      const result = await runCliRhiDebugOperation('rhi.read', {
        artifact: path,
        reads: [{ resourceId: 'tlas:scene' }],
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'replay-backend-unavailable', detail: { stage: 'provider' } },
      });
      if (!result.ok) expect(result.error.hint).toContain('FORGEAX_WEBGPU_NODE=wgpu-native');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
