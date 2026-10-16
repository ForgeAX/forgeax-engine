import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { produceTextureSource } from '../texture/importer.js';
import type { TextureSourceDescriptor } from '../texture/source-descriptor.js';
import { parseTextureSourceDescriptor } from '../texture/source-descriptor.js';

const GUID = '019ffa97-3000-7000-8000-000000000101';
const SOURCE_KEY = 'density/volume';
const BODY_BYTES = 64 * 64 * 64;

function densityDescriptor(): TextureSourceDescriptor {
  return {
    schemaVersion: '1',
    shape: {
      viewDimension: '3d',
      extent: { width: 64, height: 64, depth: 64 },
    },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    rawSibling: 'density.raw',
  };
}

function arrayDescriptor(): TextureSourceDescriptor {
  return {
    schemaVersion: '1',
    shape: {
      viewDimension: '2d-array',
      extent: { width: 8, height: 4, layers: 3 },
    },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    rawSibling: 'array.raw',
  };
}

describe('texture source descriptor producer contract', () => {
  it('produces one 64^3 density asset from its raw sibling', async () => {
    const descriptor = densityDescriptor();
    const raw = new Uint8Array(BODY_BYTES);
    raw[0] = 17;
    raw[raw.length >>> 1] = 87;
    raw[raw.length - 1] = 231;
    const readSibling = async (uri: string) => {
      expect(uri).toBe(descriptor.rawSibling);
      return { ok: true as const, value: raw };
    };

    const result = await produceTextureSource({
      descriptor,
      guid: GUID,
      sourceKey: SOURCE_KEY,
      readSibling,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.guid).toBe(GUID);
    expect(result.value.kind).toBe('texture');
    const { data, ...metadata } = result.value.payload;
    expect(metadata).toEqual({
      kind: 'texture',
      shape: descriptor.shape,
      format: descriptor.format,
      colorSpace: 'linear',
      mips: { kind: 'none' },
    });
    expect(data).toBeInstanceOf(Uint8Array);
    expect(Buffer.compare(data, raw)).toBe(0);
    const body = result.value.artifacts.body;
    expect(body).toBeDefined();
    if (body === undefined) throw new Error('producer must emit the full texture body');
    expect(body.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.compare(body.bytes, raw)).toBe(0);
    expect(result.value.artifacts.body?.mediaType).toBe('application/x-forgeax-r8');
  });

  it('keeps array and 3d payloads equivalent without minting slice identities', async () => {
    const descriptors = [arrayDescriptor(), densityDescriptor()];
    for (const descriptor of descriptors) {
      const layoutBytes = descriptor.shape.viewDimension === '3d' ? BODY_BYTES : 8 * 4 * 3;
      const raw = new Uint8Array(layoutBytes);
      const result = await produceTextureSource({
        descriptor,
        guid: GUID,
        sourceKey: SOURCE_KEY,
        readSibling: async () => ({ ok: true as const, value: raw }),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.guid).toBe(GUID);
      expect(result.value.payload.shape).toEqual(descriptor.shape);
      const body = result.value.artifacts.body;
      expect(body).toBeDefined();
      if (body === undefined) throw new Error('producer must emit the full texture body');
      expect(body.bytes).toBeInstanceOf(Uint8Array);
      expect(Buffer.compare(body.bytes, raw)).toBe(0);
    }
  });

  it('rejects missing sibling and invalid descriptor facts structurally', async () => {
    const missing = await produceTextureSource({
      descriptor: densityDescriptor(),
      guid: GUID,
      sourceKey: SOURCE_KEY,
      readSibling: async () => ({ ok: false as const, error: new Error('missing raw sibling') }),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('source-read-failed');
      expect(missing.error.detail).toMatchObject({ sourceKey: SOURCE_KEY, sibling: 'density.raw' });
    }

    const invalid = parseTextureSourceDescriptor({
      ...densityDescriptor(),
      shape: { viewDimension: '3d', extent: { width: 64, height: 64, depth: 64 } },
      format: 'bc7-rgba-unorm',
      mips: { kind: 'none' },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe('texture-format-dimension-unsupported');
      expect(invalid.error.detail).toMatchObject({ format: 'bc7-rgba-unorm', viewDimension: '3d' });
    }
  });
});
