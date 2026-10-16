import { describe, expect, it } from 'vitest';
import type { Vec3Point } from '../procedural';
import { createProfileSweepGeometry } from '../profile-sweep';

const shape = {
  contour: [
    { x: -0.04, y: -0.08 },
    { x: 0.04, y: -0.08 },
    { x: 0.04, y: 0.08 },
    { x: -0.04, y: 0.08 },
  ],
};
describe('profile transport and physical path UV', () => {
  it('uses distance along a nonuniform path for longitudinal UV', () => {
    const mesh = createProfileSweepGeometry(
      shape,
      [
        [0, 0, 0],
        [0, 0, 1],
        [0, 0, 10],
      ],
      { up: [1, 0, 0], capped: false },
    ).unwrap();
    const uv = mesh.attributes.uv as Float32Array;
    // Four edges, six face vertices per strip: first strip endpoint is distance 1/10.
    expect(uv[5]).toBeCloseTo(0.1, 6);
    expect(uv[4 * 6 * 2 + 1]).toBeCloseTo(0.1, 6);
  });
  it.each([
    2, 64, 4096,
  ])('keeps f32 winding, finite unit normals and output costs at %i points', (count) => {
    const path = Array.from({ length: count }, (_, i): Vec3Point => [0, 0, i * 0.1]);
    const mesh = createProfileSweepGeometry(shape, path, { up: [1, 0, 0], capped: false }).unwrap();
    const positions = mesh.attributes.position as Float32Array,
      normals = mesh.attributes.normal as Float32Array;
    expect(positions.length / 3).toBe((count - 1) * 4 * 6);
    const indices = required(mesh.indices);
    for (let i = 0; i < indices.length; i += 3) {
      const a = required(indices[i]) * 3,
        b = required(indices[i + 1]) * 3,
        c = required(indices[i + 2]) * 3;
      const ab = [
        required(positions[b]) - required(positions[a]),
        required(positions[b + 1]) - required(positions[a + 1]),
        required(positions[b + 2]) - required(positions[a + 2]),
      ];
      const ac = [
        required(positions[c]) - required(positions[a]),
        required(positions[c + 1]) - required(positions[a + 1]),
        required(positions[c + 2]) - required(positions[a + 2]),
      ];
      const cross = [
        required(ab[1]) * required(ac[2]) - required(ab[2]) * required(ac[1]),
        required(ab[2]) * required(ac[0]) - required(ab[0]) * required(ac[2]),
        required(ab[0]) * required(ac[1]) - required(ab[1]) * required(ac[0]),
      ];
      expect(
        required(cross[0]) * required(normals[a]) +
          required(cross[1]) * required(normals[a + 1]) +
          required(cross[2]) * required(normals[a + 2]),
      ).toBeGreaterThan(0);
      expect(
        Math.hypot(required(normals[a]), required(normals[a + 1]), required(normals[a + 2])),
      ).toBeCloseTo(1, 5);
    }
  });
  it('closes the nonplanar asymmetric profile seam with matching ring positions', () => {
    const path = Array.from(
      { length: 65 },
      (_, i): Vec3Point => [
        Math.cos((i / 64) * 2 * Math.PI),
        Math.sin((i / 64) * 2 * Math.PI),
        0.2 * Math.sin((i / 64) * 4 * Math.PI),
      ],
    );
    path[64] = required(path[0]);
    const mesh = createProfileSweepGeometry(shape, path, { closed: true }).unwrap();
    const p = mesh.attributes.position as Float32Array;
    // Last strip upper ring's d equals first strip lower ring's a, each edge.
    for (let edge = 0; edge < 4; edge++)
      for (let axis = 0; axis < 3; axis++)
        expect(p[((63 * 4 + edge) * 6 + 5) * 3 + axis]).toBe(p[edge * 6 * 3 + axis]);
    expect((mesh.attributes.uv as Float32Array).at(-1)).toBe(1);
  });
  it('accepts a bounded acute bend, rejects duplicate points, reversal and f32 collapse explicitly', () => {
    expect(
      createProfileSweepGeometry(shape, [
        [0, 0, 0],
        [0, 0, 2],
        [1, 0, 0.4],
      ]).ok,
    ).toBe(true);
    for (const path of [
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 1],
        [0, 0, 0],
      ],
      [
        [1e20, 0, 0],
        [1e20 + 1, 0, 0],
      ],
    ] as readonly (readonly Vec3Point[])[]) {
      const result = createProfileSweepGeometry(shape, path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('asset-parse-failed');
    }
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing fixture value');
  return value;
}
