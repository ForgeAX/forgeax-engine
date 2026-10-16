import { describe, expect, it } from 'vitest';
import { buildMeshAsset } from '../to-asset-pack.js';

const GUID_A = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const GUID_B = '019e2cc6-0c86-79da-aa76-b0984c86d45d';

function mesh(guid: string) {
  return buildMeshAsset(
    {
      sourceIndex: guid === GUID_A ? 0 : 1,
      vertices: new Float32Array([0, 0, 0]),
      indices: new Uint16Array([0]),
      attributes: {},
      submeshes: [],
    },
    guid,
  );
}

describe('FBX asset-local artifacts', () => {
  it('allows two assets to own the same local key without sharing refs or bytes', () => {
    const first = mesh(GUID_A) as unknown as Record<string, unknown>;
    const second = mesh(GUID_B) as unknown as Record<string, unknown>;
    const firstBody = (first.artifacts as Record<string, Record<string, unknown>>).body;
    const secondBody = (second.artifacts as Record<string, Record<string, unknown>>).body;
    expect(firstBody).toBeDefined();
    expect(secondBody).toBeDefined();
    if (firstBody === undefined || secondBody === undefined) return;

    expect(first.refs).toEqual([]);
    expect(second.refs).toEqual([]);
    expect(firstBody.mediaType).toBe('application/x-forgeax-mesh');
    expect(secondBody.mediaType).toBe('application/x-forgeax-mesh');
    expect(firstBody.bytes).toBeInstanceOf(Uint8Array);
    expect(secondBody.bytes).toBeInstanceOf(Uint8Array);
    expect(firstBody).not.toHaveProperty('path');
    expect(firstBody).not.toHaveProperty('integrity');
  });
});
