import { createBoxGeometry } from '@forgeax/engine/geometry';
import { defineFeature } from '../../lab/feature';

function isPlainData(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value !== 'object') return typeof value !== 'function';
  if (ArrayBuffer.isView(value)) return true;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return false;
  return Object.values(value).every((child) => isPlainData(child, depth + 1));
}

export default defineFeature({
  title: 'Format-independent asset POD',
  catalog: 'Format-independent asset POD',
  kind: 'headless',
  summary:
    'A runtime MeshAsset is plain data (kind tag, typed arrays, attribute map, aabb) with no glTF/FBX objects or class instances.',
  expect:
    'All checks pass: the mesh is plain data, structuredClone preserves it, and aabb matches the box extents.',
  run(checks) {
    const created = createBoxGeometry(2, 4, 6);
    checks.ok('createBoxGeometry returns ok', created.ok);
    if (!created.ok) return;
    const mesh = created.value;
    checks.equal('kind discriminant', mesh.kind, 'mesh');
    checks.ok('vertices is Float32Array', mesh.vertices instanceof Float32Array);
    checks.ok('only plain objects, arrays and typed arrays', isPlainData(mesh));
    checks.ok(
      'no source-format fields',
      !('gltf' in mesh) && !('fbx' in mesh) && !('source' in mesh),
    );
    const aabb = mesh.aabb;
    checks.ok('aabb present', aabb !== undefined);
    if (aabb) checks.equal('aabb extents', Array.from(aabb), [-1, -2, -3, 1, 2, 3]);
    const clone = structuredClone(mesh);
    checks.equal('structuredClone keeps vertex count', clone.vertices.length, mesh.vertices.length);
    checks.equal(
      'structuredClone keeps attributes',
      Object.keys(clone.attributes).sort(),
      Object.keys(mesh.attributes).sort(),
    );
    const bad = createBoxGeometry(0, 1, 1);
    checks.equal(
      'degenerate input is a structured AssetError',
      bad.ok ? 'ok' : bad.error.code,
      'asset-parse-failed',
    );
  },
});
