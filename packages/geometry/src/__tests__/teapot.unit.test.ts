import { createTeapotGeometry } from '@forgeax/engine-geometry';
import { describe, expect, it } from 'vitest';

const THREE_COMMIT = 'ad005397bbd15b0a9fcd5159c782eba56e1cba2a';
const THREE_SOURCE = 'examples/jsm/geometries/TeapotGeometry.js';

describe('official Three.js Utah teapot parity', () => {
  it('emits the pinned topology and expected bounds', () => {
    const result = createTeapotGeometry(0.8, 18);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mesh = result.value;
    expect(mesh.kind).toBe('mesh');
    expect(mesh.indices).toBeDefined();
    if (mesh.indices === undefined) return;
    expect(mesh.indices.length).toBe(61776);
    expect(mesh.submeshes[0]?.indexCount).toBe(mesh.indices.length);
    expect(mesh.attributes.position).toBeDefined();
    expect(mesh.attributes.normal).toBeDefined();
    expect(mesh.attributes.uv).toBeDefined();
    expect(mesh.aabb?.[0]).toBeCloseTo(-1.5238096, 3);
    expect(mesh.aabb?.[3]).toBeCloseTo(1.7441221, 3);
    expect(mesh.aabb?.[1]).toBeCloseTo(-0.8, 3);
    expect(mesh.aabb?.[4]).toBeCloseTo(0.8, 3);
  });

  it('publishes upstream provenance and license facts', () => {
    const result = createTeapotGeometry();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provenance).toEqual({
      source: 'three.js',
      commit: THREE_COMMIT,
      path: THREE_SOURCE,
      license: 'MIT',
    });
  });

  it('rejects malformed parameters instead of silently approximating', () => {
    expect(createTeapotGeometry(0, 18).ok).toBe(false);
    expect(createTeapotGeometry(0.8, 1).ok).toBe(false);
    const result = createTeapotGeometry(0.8, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vertices.length).toBeGreaterThan(4 * 4 * 3);
    expect(result.value.submeshes[0]?.topology).toBe('triangle-list');
  });
});
