import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MESH_PER_ENTITY_STRIDE } from '../record/mesh-ssbo';

const ownerSource = readFileSync(new URL('../record/mesh-ssbo.ts', import.meta.url), 'utf8');
const hdrpSource = readFileSync(new URL('../hdrp-buffers.ts', import.meta.url), 'utf8');

describe('mesh dynamic-offset stride surface', () => {
  it('keeps the HDRP storage binding on the mesh-SSBO owner', () => {
    expect(MESH_PER_ENTITY_STRIDE).toBe(256);
    expect(ownerSource.match(/export const MESH_PER_ENTITY_STRIDE\s*=\s*256/g)).toHaveLength(1);
    expect(hdrpSource).toContain('MESH_PER_ENTITY_STRIDE');
    expect(hdrpSource).not.toContain('MESH_SSBO_PER_ENTITY_STRIDE');
    expect(hdrpSource).not.toMatch(/const MESH_PER_ENTITY_STRIDE\s*=/);
  });
});
