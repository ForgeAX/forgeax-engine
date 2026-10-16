import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const encoderSource = readFileSync(
  new URL('../../../geometry/src/mesh-data.ts', import.meta.url),
  'utf8',
);
const decoderSource = readFileSync(
  new URL('../../../geometry/src/assets/mesh-binary.ts', import.meta.url),
  'utf8',
);

describe('mesh-bin consumer owner surface', () => {
  it('routes both production halves through Pack-owned facts', () => {
    expect(encoderSource).toContain("from '@forgeax/engine-pack/mesh-bin-contract'");
    expect(decoderSource).toContain("from '@forgeax/engine-pack'");
    for (const source of [encoderSource, decoderSource]) {
      expect(source).toContain('MESH_BIN_HEADER_BYTES');
      expect(source).not.toContain('const HEADER_V2_BYTES = 28');
    }
  });
});
