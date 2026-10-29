import { describe, expect, it } from 'vitest';
import {
  type RenderPublicationMessage,
  renderPublicationBytes,
  renderPublicationRecordBytes,
  renderPublicationRecordColumns,
} from '../record';

const counts = { upserts: 4, removed: 1, transforms: 2, retiredJoints: 0 };

const message = (side?: RenderPublicationMessage['side']): RenderPublicationMessage => {
  // Pooled capacity larger than the logical record.
  const record = new ArrayBuffer(4096);
  renderPublicationRecordColumns(record, counts);
  const header = new Float64Array(record, 0, 16);
  header[9] = counts.upserts;
  header[10] = counts.removed;
  header[11] = counts.transforms;
  header[12] = counts.retiredJoints;
  return {
    source: 'bytes',
    epoch: 1,
    revision: 1,
    record,
    ...(side === undefined ? {} : { side }),
  };
};

describe('renderPublicationBytes', () => {
  it('counts the logical record (header and columns), not pooled buffer capacity', () => {
    expect(renderPublicationBytes(message())).toEqual({
      columns: renderPublicationRecordBytes(counts),
      assets: 0,
    });
    expect(renderPublicationRecordBytes(counts)).toBe(128 + 4 * (4 + 1 + 2) + 64 * 2);
  });

  it('adds each transferred asset buffer once', () => {
    const shared = new ArrayBuffer(256);
    const side = {
      assets: [
        {
          handle: 1,
          revision: 1,
          value: {
            positions: new Float32Array(shared, 0, 8),
            indices: new Uint16Array(shared, 32, 4),
          },
        },
      ],
      assetPatches: [
        { fields: { color: new Float32Array(4) }, ranges: [{ bytes: new Uint8Array(10) }] },
      ],
    } as unknown as RenderPublicationMessage['side'];
    expect(renderPublicationBytes(message(side))).toEqual({
      columns: renderPublicationRecordBytes(counts),
      assets: 256 + 16 + 10,
    });
  });
});
