import { EditMesh } from '@forgeax/engine-modeling';
import {
  type QuadRemeshOptions as PublicOptions,
  quadRemesh as quadRemeshPublic,
} from '@forgeax/engine-modeling/quad';
import { describe, expect, it } from 'vitest';

describe('quad subpath public API', () => {
  it('exports the supported quad subpath API', () => {
    const mesh = new EditMesh();
    const a = mesh.addVertex(0, 0, 0);
    const b = mesh.addVertex(1, 0, 0);
    const c = mesh.addVertex(0, 1, 0);
    const added = mesh.addFace([a, b, c], 0);
    if (!added.ok) throw new Error(`addFace failed: ${added.error.code}`);
    const options: PublicOptions = {};
    const result = quadRemeshPublic(mesh, mesh.faces(), options);
    expect(result.ok).toBe(true);
  });
});
