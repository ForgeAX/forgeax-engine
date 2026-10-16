import { unpackMeshBin } from '@forgeax/engine-assets-runtime';
import { describe, expect, it } from 'vitest';

describe('mesh-bin v4 closed error contract', () => {
  it.each([
    new Uint8Array(10),
    new Uint8Array([2, 0, 0, 0]),
    new Uint8Array([3, 0, 0, 0]),
  ])('rejects malformed or legacy bytes with structured recovery', (bytes) => {
    const result = unpackMeshBin(bytes, 'runtime://contract');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.subject).toBe('mesh-bin');
    expect(result.error.sourceKey).toBe('runtime://contract');
    expect(result.error.expected).toContain('v4');
    expect(result.error.recovery).toContain('re-cook');
    const detail = result.error.detail;
    expect(detail).toBeDefined();
    if (
      detail === undefined ||
      !('code' in detail) ||
      detail.code !== 'mesh-bin-contract-violation'
    )
      return;
    expect(detail.sourceKey).toBe('runtime://contract');
    expect(detail.actual.byteLength).toBe(bytes.byteLength);
  });
});
