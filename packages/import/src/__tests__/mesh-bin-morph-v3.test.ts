import { packMeshBin } from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';

const attributes = {
  position: new Float32Array(9),
  normal: new Float32Array(9),
  uv: new Float32Array(6),
  tangent: new Float32Array(12),
};

describe('mesh-bin v5 morph contract', () => {
  it('round-trips bounded target streams and default weights into metadata', () => {
    const vertices = new Float32Array(3 * 12);
    const result = packMeshBin(
      {
        vertices,
        attributes,
        morphTargets: [{ position: new Float32Array(9), normal: new Float32Array(9) }],
        morphWeights: new Float32Array([0.25]),
      },
      'gltf://morph',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new DataView(result.value.buffer).getUint32(0, true)).toBe(5);
    expect(new TextDecoder().decode(result.value)).toContain('morphWeights');
  });

  it('rejects excess targets before publishing bytes', () => {
    const result = packMeshBin(
      {
        vertices: new Float32Array(3 * 12),
        attributes,
        morphTargets: Array.from({ length: 9 }, () => ({ position: new Float32Array(9) })),
      },
      'gltf://morph-invalid',
    );
    expect(result.ok).toBe(false);
  });
});
