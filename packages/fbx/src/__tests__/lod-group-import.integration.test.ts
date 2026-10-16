import { describe, expect, it } from 'vitest';
import { parseFbxLodGroup } from '../lod/parse-lod-group.js';

describe('FBX FbxLODGroup producer contract', () => {
  it('keeps child order and native distance diagnostics', () => {
    const result = parseFbxLodGroup({
      children: [{ meshIndex: 0 }, { meshIndex: 1 }, { meshIndex: 2 }],
      threshold: 25,
      mode: 'percentage',
      displayMode: 'eLODGroup',
    });
    expect(result).toMatchObject({
      ok: true,
      value: { childMeshIndices: [0, 1, 2], nativeThreshold: 25, nativeMode: 'percentage' },
    });
  });

  it('fails forced eShow/eHide because it cannot preserve single-level runtime semantics', () => {
    expect(parseFbxLodGroup({ children: [{ meshIndex: 0 }], displayMode: 'eShow' })).toMatchObject({
      ok: false,
      error: { code: 'fbx-lod-display-mode-unsupported' },
    });
  });
});
