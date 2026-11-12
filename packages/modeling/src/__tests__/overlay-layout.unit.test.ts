import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { OVERLAY_KINDS, overlayMesh, projectOverlay } from '../diagnostics';
import { model } from '../model';
import { sel } from '../selectors';
import { coloredMesh } from '../surface-analysis';

/**
 * Overlays and analysis views draw through the ordinary unlit pipeline, so they carry
 * Geometry's canonical vertex layout (one attribute map, no parallel line layout).
 */
describe('overlay vertex layout', () => {
  it('every overlay kind and analysis mesh carries the canonical layout and packs', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'body' });
    m.markSharp(sel.edges.all());
    m.markSeam(sel.edges.all());
    const meshes: MeshAsset[] = OVERLAY_KINDS.map((kind) => {
      const overlay = projectOverlay(m.editMesh, kind);
      if (!overlay.ok) throw overlay.error;
      return overlay.value.mesh;
    });
    const lines = overlayMesh(
      { position: new Float32Array([0, 0, 0, 1, 0, 0]), color: new Float32Array(8).fill(1) },
      'line-list',
    );
    const colored = coloredMesh({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      colors: new Float32Array(12).fill(1),
      triangles: 1,
    });
    if (!lines.ok || !colored.ok) throw new Error('overlay');
    meshes.push(lines.value, colored.value);
    for (const mesh of meshes) {
      const keys = deriveVertexLayoutProjection(mesh.attributes).attributes.map((a) => a.key);
      for (const key of Object.keys(DEFAULT_VERTEX_ATTRIBUTE_MAP)) expect(keys).toContain(key);
      expect(keys).toContain('color');
      const count = (mesh.attributes.position as Float32Array).length / 3;
      expect(packInterleavedVertexAttributes(mesh.attributes, count).ok).toBe(true);
    }
  });
});
