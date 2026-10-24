import { describe, expect, it } from 'vitest';
import { type RenderPublication, renderPublicationBytes } from '../contract';

const packet = (assets: unknown[] = [], assetPatches: unknown[] = []): RenderPublication =>
  ({
    upserts: new Uint32Array(new ArrayBuffer(64), 0, 4),
    removed: new Uint32Array(1),
    transformEntities: new Uint32Array(2),
    transforms: new Float32Array(32),
    retiredJoints: new Uint32Array(0),
    assets,
    assetPatches,
  }) as unknown as RenderPublication;

describe('renderPublicationBytes', () => {
  it('counts logical frame-column bytes, not pooled buffer capacity', () => {
    expect(renderPublicationBytes(packet())).toEqual({ columns: 16 + 4 + 8 + 128, assets: 0 });
  });

  it('adds each transferred asset buffer once', () => {
    const shared = new ArrayBuffer(256);
    const assets = [
      {
        value: {
          positions: new Float32Array(shared, 0, 8),
          indices: new Uint16Array(shared, 32, 4),
        },
      },
    ];
    const patches = [
      { fields: { color: new Float32Array(4) }, ranges: [{ bytes: new Uint8Array(10) }] },
    ];
    expect(renderPublicationBytes(packet(assets, patches))).toEqual({
      columns: 156,
      assets: 256 + 16 + 10,
    });
  });
});
