import { describe, expect, it } from 'vitest';
import {
  decodeMeshBinHeader,
  MESH_BIN_HEADER_BYTES,
  MESH_BIN_VERSION,
} from '../mesh-bin-contract.js';

describe('mesh-bin v5 wire contract', () => {
  it('owns a fixed header and rejects legacy versions at the contract boundary', () => {
    expect(MESH_BIN_VERSION).toBe(5);
    expect(MESH_BIN_HEADER_BYTES).toBeGreaterThan(28);
    expect(decodeMeshBinHeader(new Uint8Array(MESH_BIN_HEADER_BYTES))).toMatchObject({
      ok: false,
      error: { code: 'mesh-bin-version-unsupported' },
    });
  });

  it('reports truncated headers as structured failures with recovery context', () => {
    const result = decodeMeshBinHeader(new Uint8Array(MESH_BIN_HEADER_BYTES - 1), 'mesh/source');
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'mesh-bin-header-truncated',
        subject: 'mesh-bin',
        sourceKey: 'mesh/source',
        expected: expect.any(String),
        actual: expect.any(String),
        recovery: expect.stringContaining('re-cook'),
      },
    });
  });
});
