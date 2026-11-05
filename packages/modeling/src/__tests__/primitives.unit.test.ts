import { describe, expect, it } from 'vitest';
import { meshVolume } from '../geom';
import { type Model, model } from '../model';
import { type Point2, segmentsCross } from '../primitives';
import { sel } from '../selectors';
import { bounds, expectContract, faceSizes, sharpEdges } from './contract';

describe('primitives', () => {
  it('rejects separated segment bounds before reading exact orientation inputs', () => {
    let reads = 0;
    const watch = (point: Point2): Point2 =>
      new Proxy(point, {
        get(target, property, receiver) {
          if (property === '0' || property === '1') reads++;
          return Reflect.get(target, property, receiver);
        },
      });
    expect(segmentsCross(watch([0, 0]), watch([1, 1]), watch([2, 0]), watch([3, 1]))).toBe(false);
    expect(reads).toBeLessThanOrEqual(8);
  });

  it('keeps exact crossings, shared endpoints and collinear overlap at segment bounds', () => {
    expect(segmentsCross([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
    expect(segmentsCross([0, 0], [1, 0], [1, 0], [2, 1])).toBe(true);
    expect(segmentsCross([0, 0], [2, 0], [1, 0], [3, 0])).toBe(true);
    expect(segmentsCross([0, 0], [0, 2], [0, 1], [0, 3])).toBe(true);
    expect(segmentsCross([1, 1], [1, 1], [1, 1], [1, 1])).toBe(true);
    expect(segmentsCross([0, 0], [1, 0], [1 + Number.EPSILON, 0], [2, 0])).toBe(false);
    expect(segmentsCross([0, 0], [0, 1], [0, 1 + Number.EPSILON], [0, 2])).toBe(false);
    expect(
      segmentsCross([1e16, 1e16], [1e16 + 4, 1e16 + 4], [1e16, 1e16 + 4], [1e16 + 4, 1e16]),
    ).toBe(true);
  });

  it('box is a closed, outward-oriented quad mesh', () => {
    const m = model();
    expect(m.box({ size: [2, 3, 4] }).status).toBe('ok');
    const report = m.validate();
    expect(report.pass).toBe(true);
    expect(report.closed).toBe(true);
    expect(report.faces).toBe(6);
    expect(report.vertices).toBe(8);
    expect(meshVolume(m.editMesh)).toBeCloseTo(24, 12);
  });

  it('segmented box keeps closure and volume', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [2, 3, 1], center: [1, 2, 3] });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.faces).toBe(2 * (2 * 3 + 3 * 1 + 2 * 1));
    expect(report.volume).toBeCloseTo(1, 12);
  });

  it('plane lies in XY, facing +Z, open', () => {
    const m = model();
    m.plane({ width: 2, height: 1, widthSegments: 2, heightSegments: 3, center: [0, 0, 1] });
    const report = m.validate();
    expect(report.faces).toBe(6);
    expect(report.closed).toBe(false);
    expect(report.boundaryEdges).toBe(10);
    expect(m.count(sel.facing('+z', 1))).toBe(6);
    expect(bounds(m.editMesh)).toEqual([-1, -0.5, 1, 1, 0.5, 1]);
    expectContract(m);
  });

  it('cylinder has n-gon caps, sharp cap rims and the prism volume', () => {
    const m = model();
    const op = m.cylinder({
      radiusTop: 1,
      radiusBottom: 1,
      height: 2,
      radialSegments: 8,
      label: 'drum',
    });
    expect(op.roles).toEqual({ side: 8, top: 1, bottom: 1 });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo((8 / 2) * Math.sin((2 * Math.PI) / 8) * 2, 10);
    expect(m.inspect().labels).toEqual([{ label: 'drum', roles: { side: 8, top: 1, bottom: 1 } }]);
    expect(sharpEdges(m.editMesh)).toBe(16);
    expect(m.count(sel.createdBy('drum', 'top').and(sel.facing('+y', 1)))).toBe(1);
    expectContract(m);
  });

  it('cylinder rings split the side without sharpening it; open ends leave boundaries', () => {
    const m = model();
    m.cylinder({
      radiusTop: 0.5,
      radiusBottom: 1,
      height: 1,
      radialSegments: 6,
      heightSegments: 3,
    });
    expect(faceSizes(m.editMesh)).toEqual({ 4: 18, 6: 2 });
    expect(sharpEdges(m.editMesh)).toBe(12);
    const open = model();
    const op = open.cylinder({
      radiusTop: 1,
      radiusBottom: 1,
      height: 1,
      radialSegments: 6,
      openEnded: true,
    });
    expect(op.roles).toEqual({ side: 6 });
    expect(open.validate().boundaryEdges).toBe(12);
    expect(sharpEdges(open.editMesh)).toBe(0);
  });

  it('cone ends in a triangle-fan apex over an n-gon base', () => {
    const m = model();
    const op = m.cone({ radius: 1, height: 3, radialSegments: 4, label: 'tip' });
    expect(op.roles).toEqual({ side: 4, bottom: 1 });
    expect(faceSizes(m.editMesh)).toEqual({ 3: 4, 4: 1 });
    const report = m.validate();
    expect(report.closed).toBe(true);
    // Square base of diagonal 2 (area 2), height 3.
    expect(report.volume).toBeCloseTo((2 * 3) / 3, 12);
    expect(bounds(m.editMesh)[4]).toBe(1.5);
    expectContract(m);
  });

  it('sphere has quad bands, triangle-fan poles and approaches the ball volume', () => {
    const m = model();
    m.sphere({ radius: 1, widthSegments: 8, heightSegments: 4, label: 'ball' });
    expect(faceSizes(m.editMesh)).toEqual({ 3: 16, 4: 16 });
    expect(m.validate().closed).toBe(true);
    expect(m.inspect().labels).toEqual([{ label: 'ball', roles: { face: 32 } }]);
    expect(sharpEdges(m.editMesh)).toBe(0);
    expectContract(m);
    const fine = model();
    fine.sphere({ radius: 2, widthSegments: 64, heightSegments: 32, center: [1, 0, 0] });
    const volume = fine.validate().volume;
    expect(volume).toBeLessThan((4 / 3) * Math.PI * 8);
    expect(volume).toBeGreaterThan(0.99 * (4 / 3) * Math.PI * 8);
  });

  it('smooth sphere and capped cylinder export one render vertex per normal group', () => {
    const sphere = model();
    sphere.sphere({ radius: 1, widthSegments: 8, heightSegments: 4 });
    sphere.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
    const s = sphere.toMesh({ normals: { mode: 'smooth' } });
    // A planar y projection folds the lower hemisphere onto the upper one with the
    // opposite uv handedness, so the 8 equator vertices split once more.
    expect(s.ok && s.value.report.gpuVertices).toBe(8 * 3 + 2 + 8);
    const drum = model();
    drum.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 8 });
    drum.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
    const d = drum.toMesh({ normals: { mode: 'smooth' } });
    // 16 rim vertices, each split into a cap group and a side group by the sharp rim.
    expect(d.ok && d.value.report.gpuVertices).toBe(32);
  });

  it('torus lies in XY and supports a partial ring', () => {
    const m = model();
    m.torus({ radius: 2, tube: 0.5, radialSegments: 6, tubularSegments: 12 });
    const report = m.validate();
    expect(report.faces).toBe(72);
    expect(report.closed).toBe(true);
    const [x0, y0, z0, x1, y1, z1] = bounds(m.editMesh);
    // The hexagonal cross-section reaches tube * sin(60deg) along Z.
    expect(x1).toBe(2.5);
    expect(z0).toBeCloseTo(-0.5 * Math.sin(Math.PI / 3), 12);
    expect(z1).toBeCloseTo(0.5 * Math.sin(Math.PI / 3), 12);
    expect(x0).toBeCloseTo(-2.5, 12);
    expect((y1 as number) - (y0 as number)).toBeGreaterThan(4.5);
    expectContract(m);
    const half = model();
    half.torus({ radius: 2, tube: 0.5, radialSegments: 6, tubularSegments: 6, angle: 180 });
    const open = half.validate();
    expect(open.faces).toBe(36);
    expect(open.boundaryEdges).toBe(12);
    // Half a ring from +X through +Y to -X: its cross-sections end in the XZ plane.
    expect(bounds(half.editMesh)[1]).toBeCloseTo(0, 12);
    expect(bounds(half.editMesh)[4]).toBeCloseTo(2.5, 12);
  });

  it('revolve caps flat profile ends and keeps the sweep start at +Z', () => {
    const m = model();
    const op = m.revolve({
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0.5, 2],
        [0, 2],
      ],
      segments: 12,
      label: 'vase',
    });
    expect(op.roles).toEqual({ side: 24, bottom: 1, top: 1 });
    expect(m.validate().closed).toBe(true);
    expect(m.count(sel.createdBy('vase', 'bottom').and(sel.facing('-y', 1)))).toBe(1);
    expect(sharpEdges(m.editMesh)).toBe(24);
    expectContract(m);
  });

  it('revolve sweeps a partial angle into open pie-slice caps', () => {
    const m = model();
    const op = m.revolve({
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      segments: 3,
      angle: 90,
    });
    expect(op.roles).toEqual({ side: 3, bottom: 1, top: 1 });
    expect(faceSizes(m.editMesh)).toEqual({ 4: 3, 5: 2 });
    const [x0, , z0, x1, , z1] = bounds(m.editMesh);
    expect([x0, z0, x1, z1]).toEqual([0, 0, 1, 1]);
    expect(m.validate().closed).toBe(false);
  });

  it('revolve closes a profile whose last point repeats the first', () => {
    const m = model();
    m.revolve({
      points: [
        [1, 0],
        [2, 0],
        [2, 1],
        [1, 1],
        [1, 0],
      ],
      segments: 8,
    });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.faces).toBe(32);
    expect(report.volume).toBeGreaterThan(0);
  });

  it('extrudePolygon normalizes winding and keeps concave n-gon caps', () => {
    const m = model();
    const op = m.extrudePolygon({
      // Clockwise L shape; the closing duplicate point is accepted.
      points: [
        [0, 0],
        [0, 2],
        [1, 2],
        [1, 1],
        [2, 1],
        [2, 0],
        [0, 0],
      ],
      depth: 0.5,
      steps: 2,
      label: 'bracket',
    });
    expect(op.roles).toEqual({ side: 12, top: 1, bottom: 1 });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(3 * 0.5, 12);
    expect(m.count(sel.createdBy('bracket', 'top').and(sel.facing('+z', 1)))).toBe(1);
    expect(sharpEdges(m.editMesh)).toBe(12);
    expectContract(m);
  });

  it('rejects invalid magnitudes and degenerate outlines with structured errors', () => {
    const cases: [string, (m: Model) => unknown, string][] = [
      ['box', (m) => m.box({ size: [1, 0, 1] }), 'model-invalid-argument'],
      [
        'plane',
        (m) => m.plane({ width: 1, height: 1, widthSegments: 0 }),
        'model-invalid-argument',
      ],
      [
        'cylinder',
        (m) => m.cylinder({ radiusTop: 0, radiusBottom: 0, height: 1, radialSegments: 8 }),
        'model-invalid-argument',
      ],
      [
        'cylinder',
        (m) => m.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 2 }),
        'model-invalid-argument',
      ],
      [
        'cone',
        (m) => m.cone({ radius: 1, height: -1, radialSegments: 8 }),
        'model-invalid-argument',
      ],
      [
        'sphere',
        (m) => m.sphere({ radius: 1, widthSegments: 8, heightSegments: 1 }),
        'model-invalid-argument',
      ],
      [
        'torus',
        (m) => m.torus({ radius: 1, tube: 1, radialSegments: 6, tubularSegments: 8 }),
        'model-invalid-argument',
      ],
      [
        'torus',
        (m) => m.torus({ radius: 2, tube: 1, radialSegments: 6, tubularSegments: 8, angle: 0 }),
        'model-invalid-argument',
      ],
      [
        'revolve',
        (m) =>
          m.revolve({
            points: [
              [0, 0],
              [1, 1],
              [0, 2],
              [1, 3],
            ],
            segments: 8,
          }),
        'model-invalid-argument',
      ],
      [
        'revolve',
        (m) =>
          m.revolve({
            points: [
              [1, 0],
              [1, 0],
              [1, 1],
            ],
            segments: 8,
          }),
        'model-degenerate',
      ],
      [
        'revolve',
        (m) =>
          m.revolve({
            points: [
              [0, 0],
              [0, 1],
            ],
            segments: 8,
          }),
        'model-degenerate',
      ],
      [
        'extrudePolygon',
        (m) =>
          m.extrudePolygon({
            points: [
              [0, 0],
              [1, 1],
              [1, 0],
              [0, 1],
            ],
            depth: 1,
          }),
        'model-invalid-argument',
      ],
      [
        'extrudePolygon',
        (m) =>
          m.extrudePolygon({
            points: [
              [0, 0],
              [1, 0],
              [2, 0],
            ],
            depth: 1,
          }),
        'model-degenerate',
      ],
      [
        'extrudePolygon',
        (m) =>
          m.extrudePolygon({
            points: [
              [0, 0],
              [1, 0],
              [0, 1],
            ],
            depth: 0,
          }),
        'model-invalid-argument',
      ],
    ];
    for (const [op, call, code] of cases) {
      const m = model();
      call(m);
      expect([op, m.poisoned?.code]).toEqual([op, code]);
      expect(m.poisoned?.detail?.site).toEqual({ op, opIndex: 0 });
      expect(m.editMesh.faceCount).toBe(0);
    }
  });

  it('an inside-out revolve fails its outward-volume assertion with an ordering hint', () => {
    const m = model();
    const op = m.revolve({
      points: [
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ],
      segments: 8,
    });
    expect(op.status).toBe('failed');
    expect(op.error?.code).toBe('model-degenerate');
    expect(op.error?.hint).toMatch(/bottom to top/);
    expect(op.error?.detail?.volume).toBeLessThan(0);
  });

  it('extrudePolygon bridges rows of holes on aligned rays', () => {
    // A brake disc: ring 0.2 / 0.1 with three rows of twelve 3.2 mm holes; the rows on one
    // radial ray (phase 0) or a third pitch apart put other holes' vertices exactly on
    // the bridge ray and used to fail as non-simple.
    const ring = (r: number, n: number, c: readonly [number, number] = [0, 0]) =>
      Array.from({ length: n }, (_, i) => {
        const a = (2 * Math.PI * i) / n;
        return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as [number, number];
      });
    for (const phase of [0, 1 / 3, 0.2, 0.25, 0.5]) {
      const holes = [ring(0.1, 72)];
      for (let k = 0; k < 3; k++) {
        const rr = 0.1 + (0.1 * (k + 1)) / 4;
        for (let j = 0; j < 12; j++) {
          const a = (2 * Math.PI * (j + k * phase)) / 12;
          holes.push(ring(0.0032, 10, [rr * Math.cos(a), rr * Math.sin(a)]));
        }
      }
      const m = model();
      const op = m.extrudePolygon({ points: ring(0.2, 96), holes, depth: 0.01 });
      expect(op.status, `phase ${phase}`).toBe('ok');
      const report = m.validate();
      expect(report.closed).toBe(true);
      expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
      // Polygon areas: 96-gon minus 72-gon minus 36 decagons, times the depth.
      const area = (n: number, r: number) => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);
      const volume = (area(96, 0.2) - area(72, 0.1) - 36 * area(10, 0.0032)) * 0.01;
      expect(meshVolume(m.editMesh)).toBeCloseTo(volume, 12);
    }
  });
});
