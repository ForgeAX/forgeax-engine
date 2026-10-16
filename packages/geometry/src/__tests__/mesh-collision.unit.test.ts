import { describe, expect, test } from 'vitest';
import { decodeMeshBinary, normalizeMeshPayload } from '../assets/mesh-binary';
import { createBoxGeometry } from '../box';
import { buildMeshCollision, validateMeshCollisionAttachment } from '../mesh-collision';
import { packMeshBin } from '../mesh-data';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
const mesh = () => createBoxGeometry(1, 1, 1).unwrap();
describe('G28 collision production and portable asset admission', () => {
  test('welds UV/material seams without dropping triangle coverage', () => {
    const source = mesh();
    const output = buildMeshCollision(source).unwrap();
    expect(output.positions.length).toBe(8 * 3);
    expect(output.indices.length).toBe(12 * 3);
    output.positions[0] = 100;
    expect((required(source.attributes.position) as Float32Array)[0]).not.toBe(100);
  });
  test('bounds source triangle work even when excess sections are degenerate', () => {
    const source = mesh();
    const indices = new Uint32Array(3_145_731);
    indices.set(required(source.indices));
    expect(
      buildMeshCollision({
        ...source,
        indices,
        submeshes: [
          { ...required(source.submeshes[0]), indexOffset: 0, indexCount: 36 },
          { ...required(source.submeshes[0]), indexOffset: 36, indexCount: 3_145_692 },
          { ...required(source.submeshes[0]), indexOffset: 3_145_728, indexCount: 3 },
        ],
      }).ok,
    ).toBe(false);
  });
  test('omitted degenerate sections cannot enlarge the native hull point cloud', () => {
    const source = mesh();
    const sourcePositions = required(source.attributes.position) as Float32Array;
    const positions = new Float32Array(sourcePositions.length + 3);
    positions.set(sourcePositions);
    positions.set([100, 100, 100], positions.length - 3);
    const indices = new Uint32Array(39);
    indices.set(required(source.indices));
    indices.set([24, 24, 24], 36);
    const output = buildMeshCollision({
      ...source,
      attributes: { ...source.attributes, position: positions },
      indices,
      submeshes: [{ ...required(source.submeshes[0]), indexCount: 39 }],
    }).unwrap();
    expect(output.positions.length).toBe(8 * 3);
    expect(Math.max(...output.positions)).toBe(0.5);
    expect(output.indices.length).toBe(36);
  });
  test('survives binary cook and actual JSON transport, rejects stale geometry', () => {
    const source = mesh();
    const collision = buildMeshCollision(source).unwrap();
    const cooked = { ...source, collision };
    const binary = packMeshBin(cooked, 'mesh/collision').unwrap();
    const decoded = required(decodeMeshBinary(binary, []));
    expect(decoded.collision).toEqual(collision);
    const json = JSON.parse(
      JSON.stringify({
        ...cooked,
        vertices: [...cooked.vertices],
        attributes: Object.fromEntries(
          Object.entries(cooked.attributes).map(([name, values]) => [
            name,
            Array.from(required(values)),
          ]),
        ),
        indices: [...required(cooked.indices)],
        aabb: [...required(cooked.aabb)],
        collision: { positions: [...collision.positions], indices: [...collision.indices] },
      }),
    );
    expect(normalizeMeshPayload(json, [])?.collision).toEqual(collision);
    json.collision.indices[0] = -1;
    expect(normalizeMeshPayload(json, [])).toBeUndefined();
    collision.positions[0] = 99;
    expect(validateMeshCollisionAttachment(source, collision).ok).toBe(false);
    expect(packMeshBin(cooked, 'stale').ok).toBe(false);
  });
  test.each([
    'skin',
    'morph',
    'line',
    'nan',
    'index',
    'empty',
    'missing-position',
  ] as const)('refuses %s instead of guessing', (kind) => {
    const source = mesh();
    const malformed =
      kind === 'missing-position'
        ? { ...source, attributes: {} }
        : kind === 'skin'
          ? { ...source, attributes: { ...source.attributes, skinIndex: new Uint16Array(4) } }
          : kind === 'morph'
            ? { ...source, morphTargets: [{ position: new Float32Array(3) }] }
            : kind === 'line'
              ? {
                  ...source,
                  submeshes: [{ ...required(source.submeshes[0]), topology: 'line-list' as const }],
                }
              : kind === 'empty'
                ? { ...source, submeshes: [] }
                : source;
    if (kind === 'nan') (required(malformed.attributes.position) as Float32Array)[0] = NaN;
    if (kind === 'index') required(malformed.indices)[0] = 60000;
    expect(buildMeshCollision(malformed).ok).toBe(false);
  });
});
