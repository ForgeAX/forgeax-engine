import { mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import {
  bin,
  clusterSpaceObjectAabb,
  createClusterBinScratch,
  encodeProducerBounds,
  FROXEL_TILE_PAD,
  froxelProjection,
  froxelSphereOverlaps,
  measureClusterOccupancy,
  ndcPositionToCluster,
  producerBoundsInt32Length,
  spotBinningSphere,
  writeClusterMembershipFromGrid,
} from '../cluster-binner';

describe('cluster binner structured boundaries', () => {
  it('leaves clipped finite lights out of every run while retaining boundary and no-cutoff lights', () => {
    const view = mat4.identity(mat4.create());
    const grid = { x: 8, y: 4, z: 8 };
    const near = 1,
      far = 32;
    const projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, near, far);
    const positions = [
      [0, 0, 5, 1],
      [15, 0, -4, 0.5],
      [-15, 0, -4, 0.5],
      [0, 15, -4, 0.5],
      [0, -15, -4, 0.5],
      [0, 0, -0.25, 0.125],
      [0, 0, -39, 1],
      [0, 0, 0, 1.1],
      [5, 0, -4, 1.5],
      [0, 0, -32.5, 1],
      [99, 99, 99, Infinity],
    ] as const;
    const lights = positions.map(([x, y, z, range]) => ({ position: vec3.create(x, y, z), range }));
    const scratch = createClusterBinScratch();
    const cells = grid.x * grid.y * grid.z;
    const layout = new Uint32Array(cells * 2);
    const indices = new Uint32Array(cells * lights.length);
    const writes = bin(
      lights,
      view,
      projection,
      grid,
      near,
      far,
      layout,
      indices,
      indices.length,
      scratch,
    ).unwrap();
    expect([...new Set(indices.subarray(0, writes))].sort((a, b) => a - b)).toEqual([7, 8, 9, 10]);
    for (let i = 0; i < 7; i++) expect(scratch.lightBounds[i * 6]).toBe(-1);
    for (let cell = 0; cell < cells; cell++) {
      const end = (layout[cell * 2] ?? 0) + (layout[cell * 2 + 1] ?? 0);
      expect(indices[end - 1]).toBe(10);
    }
  });
  it('gives a visible light the first slot after clipped sources even when the grid can hold only one', () => {
    const view = mat4.identity(mat4.create()),
      projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 32);
    const grid = { x: 1, y: 1, z: 1 };
    const lights = [
      vec3.create(0, 0, 4),
      vec3.create(20, 0, -3),
      vec3.create(0, 0, -4),
      vec3.create(0, 0, -5),
    ].map((position) => ({ position, range: 1 }));
    const layout = new Uint32Array(2),
      indices = new Uint32Array(1);
    expect(bin(lights, view, projection, grid, 1, 32, layout, indices, 1).unwrap()).toBe(1);
    expect(Array.from(indices)).toEqual([2]);
  });

  it('conservatively covers a scaled, rotated view and a pole inside a custom projection', () => {
    const view = mat4.identity(mat4.create());
    view[0] = 0;
    view[1] = -1;
    view[4] = 4;
    view[5] = 0;
    const projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 32);
    const aabb = clusterSpaceObjectAabb(vec3.create(0, 1.5, -4), 1, view, projection);
    expect(aabb.min[0]).toBeCloseTo(2 / 5, 5);
    const light = { position: vec3.create(0, 1.5, -4), range: 1 };
    const scratch = createClusterBinScratch();
    const grid = { x: 8, y: 4, z: 8 };
    bin(
      [light],
      view,
      projection,
      grid,
      1,
      32,
      new Uint32Array(512),
      new Uint32Array(256),
      256,
      scratch,
    );
    const payload = new Int32Array(producerBoundsInt32Length(1));
    encodeProducerBounds([light], scratch.lightBounds, view, projection, payload);
    expect(payload[5]).toBe(0);
    expect(scratch.lightBounds[0]).toBe(5);
    const custom = mat4.identity(mat4.create());
    custom[3] = 1;
    custom[15] = 0;
    custom[12] = 6;
    const crossing = clusterSpaceObjectAabb(
      vec3.create(0, 0, -4),
      1,
      mat4.identity(mat4.create()),
      custom,
    );
    expect([crossing.min[0], crossing.max[0], crossing.min[1], crossing.max[1]]).toEqual([
      -1, 1, -1, 1,
    ]);
  });

  it('writes the first K independently for irregular overlapping boxes with borrowed scratch', () => {
    const grid = { x: 7, y: 4, z: 3 },
      cells = 84,
      count = 91;
    const boxes = new Int32Array(count * 6);
    const expected = Array.from({ length: cells }, () => [] as number[]);
    for (let i = 0; i < count; i++) {
      const x = i % 7,
        y = (i * 3) % 4,
        z = (i * 7) % 3;
      const x1 = Math.min(6, x + 3),
        y1 = Math.min(3, y + 2),
        z1 = Math.min(2, z + 1);
      boxes.set([x, y, z, x1, y1, z1], i * 6);
      for (let k = z; k <= z1; k++)
        for (let j = y; j <= y1; j++)
          for (let h = x; h <= x1; h++) expected[(k * 4 + j) * 7 + h]?.push(i);
    }
    const scratch = createClusterBinScratch();
    for (const cap of [1, 7, 0, 3, 2]) {
      const gridWords = new Uint32Array(cells * 2),
        ordered: number[] = [];
      for (const [cell, lights] of expected.entries()) {
        const kept = lights.slice(0, cap);
        gridWords.set([ordered.length, kept.length], cell * 2);
        ordered.push(...kept);
      }
      const result = new Uint32Array(ordered.length + 2).fill(0xffff);
      writeClusterMembershipFromGrid(
        count,
        boxes,
        grid,
        gridWords,
        result.subarray(1, result.length - 1),
        true,
        scratch,
      );
      expect(Array.from(result)).toEqual([0xffff, ...ordered, 0xffff]);
    }
  });

  it.each([
    false,
    true,
  ])('keeps ordinary and profiled ordered writes identical, materialize=%s', (writeMembership) => {
    const grid = { x: 5, y: 3, z: 7 };
    const view = mat4.lookAt(mat4.create(), [1, 2, 3], [0, 0, -4], [0, 1, 0]);
    const projection = mat4.perspective(mat4.create(), Math.PI / 3, 1.4, 0.1, 100);
    for (const capacity of [0, 4096]) {
      for (const count of [0, 1, 8, 32]) {
        const lights = Array.from({ length: count }, (_, index) => ({
          position: vec3.create((index % 7) - 3, (index % 5) - 2, -index - 2),
          range: index % 4 === 0 ? Number.POSITIVE_INFINITY : index % 4 === 1 ? 0 : (index % 9) + 1,
        }));
        const outputs = [];
        for (const observed of [false, true]) {
          const gridBacking = new Uint32Array(grid.x * grid.y * grid.z * 2 + 4).fill(0xcafe);
          const indexBacking = new Uint32Array(4100).fill(0xbeef);
          const clusterGrid = gridBacking.subarray(2, gridBacking.length - 2);
          const indices = indexBacking.subarray(2, indexBacking.length - 2);
          const scratch = createClusterBinScratch();
          const result = bin(
            lights,
            view,
            projection,
            grid,
            0.1,
            100,
            clusterGrid,
            indices,
            capacity,
            scratch,
            observed ? (_phase, action) => action() : undefined,
            { writeMembership },
          );
          outputs.push({
            result,
            gridBacking,
            indexBacking,
            lightBounds: scratch.lightBounds.slice(),
          });
          expect(gridBacking.subarray(0, 2)).toEqual(new Uint32Array([0xcafe, 0xcafe]));
          expect(gridBacking.subarray(gridBacking.length - 2)).toEqual(
            new Uint32Array([0xcafe, 0xcafe]),
          );
          expect(indexBacking.subarray(0, 2)).toEqual(new Uint32Array([0xbeef, 0xbeef]));
          expect(indexBacking.subarray(indexBacking.length - 2)).toEqual(
            new Uint32Array([0xbeef, 0xbeef]),
          );
          if (!writeMembership) expect(indices.every((value) => value === 0xbeef)).toBe(true);
        }
        expect(outputs[0]).toEqual(outputs[1]);
      }
    }
  });

  it('caps every cluster at K = 0 for a zero-capacity list instead of failing', () => {
    const grid = { x: 4, y: 3, z: 4 };
    const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
    const projection = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100);
    const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2).fill(7);
    const lightIndexList = new Uint32Array(1).fill(9);
    const scratch = createClusterBinScratch();
    const result = bin(
      [{ position: vec3.create(0, 0, -4), range: 100 }],
      view,
      projection,
      grid,
      0.1,
      100,
      clusterGrid,
      lightIndexList,
      0,
      scratch,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(0);
    expect(scratch.clusterEntryCapK).toBe(0);
    expect(scratch.droppedClusterEntries).toBe(grid.x * grid.y * grid.z);
    expect(Array.from(clusterGrid)).toEqual(new Array(clusterGrid.length).fill(0));
    expect(Array.from(lightIndexList)).toEqual([9]);
  });
});

describe('spot binning sphere', () => {
  type Triple = [number, number, number];
  const normalize = ([x, y, z]: Triple): Triple => {
    const len = Math.hypot(x, y, z);
    return [x / len, y / len, z / len];
  };
  const cross = ([ax, ay, az]: Triple, [bx, by, bz]: Triple): Triple => [
    ay * bz - az * by,
    az * bx - ax * bz,
    ax * by - ay * bx,
  ];
  const sectorPoints = (direction: Vec3, cosOuter: number, range: number) => {
    // Orthonormal basis around the (normalized) axis.
    const a = normalize([direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0]);
    const helper: Triple = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalize(cross(a, helper));
    const w = cross(a, u);
    const theta = Math.acos(cosOuter);
    const points: Triple[] = [[0, 0, 0]];
    for (let i = 0; i <= 8; i++) {
      const phi = (theta * i) / 8;
      for (let j = 0; j < 12; j++) {
        const psi = (Math.PI * 2 * j) / 12;
        for (const t of [0.25, 0.5, 0.75, 1]) {
          const r = range * t;
          const radial = Math.sin(phi) * r;
          const axial = Math.cos(phi) * r;
          const along = (k: 0 | 1 | 2): number =>
            a[k] * axial + (u[k] * Math.cos(psi) + w[k] * Math.sin(psi)) * radial;
          points.push([along(0), along(1), along(2)]);
        }
      }
    }
    return points;
  };

  it.each([
    1, 9, 16, 30, 44.9, 45, 45.1, 60, 89.9,
  ])('contains the whole lit sector for a %f degree outer cone', (deg) => {
    const position = vec3.create(3, 10, -2);
    const direction = vec3.create(0.3, -1, 0.2);
    const cosOuter = Math.cos((deg * Math.PI) / 180);
    const range = 70;
    const center = vec3.create(0, 0, 0);
    const radius = spotBinningSphere(position, direction, cosOuter, range, center);
    expect(radius).toBeLessThanOrEqual(range);
    for (const p of sectorPoints(direction, cosOuter, range)) {
      const d = Math.hypot(
        (position[0] ?? 0) + p[0] - (center[0] ?? 0),
        (position[1] ?? 0) + p[1] - (center[1] ?? 0),
        (position[2] ?? 0) + p[2] - (center[2] ?? 0),
      );
      expect(d).toBeLessThanOrEqual(radius);
    }
  });

  it('shrinks a narrow searchlight to range / (2 cos) and keeps wide or degenerate spots on the range sphere', () => {
    const center = vec3.create(0, 0, 0);
    const narrow = spotBinningSphere(
      vec3.create(0, 0, 0),
      vec3.create(0, -1, 0),
      Math.cos((16 * Math.PI) / 180),
      70,
      center,
    );
    expect(narrow).toBeCloseTo(70 / (2 * Math.cos((16 * Math.PI) / 180)), 3);
    expect(center[1]).toBeCloseTo(-narrow / (1 + 1e-5), 3);
    for (const [cosOuter, direction, range] of [
      [-0.2, vec3.create(0, -1, 0), 10],
      [0, vec3.create(0, -1, 0), 10],
      [0.9, vec3.create(0, 0, 0), 10],
      [0.9, vec3.create(0, -1, 0), Number.POSITIVE_INFINITY],
    ] as const) {
      const out = vec3.create(9, 9, 9);
      expect(spotBinningSphere(vec3.create(1, 2, 3), direction, cosOuter, range, out)).toBe(range);
      expect(Array.from(out)).toEqual([1, 2, 3]);
    }
  });
});

describe('exact froxel culling', () => {
  const grid = { x: 16, y: 9, z: 24 };
  const near = 0.1;
  const far = 400;
  const view = mat4.lookAt(mat4.create(), [3, 20, 30], [0, 0, -10], [0, 1, 0]);
  const projection = mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, near, far);

  // Deterministic LCG so the sweep is reproducible.
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // Uniform-ish point inside a view-space sphere.
  const randomPointInSphere = (centre: Vec3, radius: number): [number, number, number] => {
    const u = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const r = radius * Math.cbrt(rand());
    const s = Math.sqrt(1 - u * u);
    return [
      (centre[0] ?? 0) + r * s * Math.cos(phi),
      (centre[1] ?? 0) + r * s * Math.sin(phi),
      (centre[2] ?? 0) + r * u,
    ];
  };
  const projectToNdc = ([px, py, pz]: readonly number[]): [number, number] => {
    const m = Array.from(projection);
    const at = (row: number): number =>
      (m[row] ?? 0) * (px ?? 0) +
      (m[row + 4] ?? 0) * (py ?? 0) +
      (m[row + 8] ?? 0) * (pz ?? 0) +
      (m[row + 12] ?? 0);
    const w = at(3);
    return [at(0) / w, at(1) / w];
  };

  it('never rejects a cell that holds a point of the sphere, under sub-pad raster jitter', () => {
    const froxel = froxelProjection(projection);
    expect(froxel).toBeDefined();
    if (froxel === undefined) return;
    for (let trial = 0; trial < 60; trial++) {
      const centre = vec3.create((rand() - 0.5) * 40, (rand() - 0.5) * 30, -rand() * 120 - 1);
      const radius = rand() * 18 + 0.5;
      for (let sample = 0; sample < 400; sample++) {
        const point = randomPointInSphere(centre, radius);
        if (point[2] >= -near) continue;
        const ndc = projectToNdc(point);
        if (Math.abs(ndc[0]) > 1 || Math.abs(ndc[1]) > 1) continue;
        // A raster projection jittered by less than FROXEL_TILE_PAD of a tile
        // (TAA) must still land in a cell that kept the light.
        const jitter = FROXEL_TILE_PAD * 0.99;
        const jittered = vec3.create(
          ndc[0] + (rand() * 2 - 1) * jitter * (2 / grid.x),
          ndc[1] + (rand() * 2 - 1) * jitter * (2 / grid.y),
          0,
        );
        const cell = ndcPositionToCluster(jittered, point[2], grid.x, grid.y, grid.z, near, far);
        expect(
          froxelSphereOverlaps(
            cell.x,
            cell.y,
            cell.z,
            centre[0] ?? 0,
            centre[1] ?? 0,
            centre[2] ?? 0,
            radius,
            froxel,
            grid.x,
            grid.y,
            grid.z,
            near,
            far,
          ),
        ).toBe(true);
      }
    }
  });

  it('rejects a cell beside the sphere and keeps infinite ranges', () => {
    const froxel = froxelProjection(projection);
    if (froxel === undefined) throw new Error('perspective expected');
    // Sphere centred in the middle of the view at depth 50, radius 2: the
    // corner cell at the same depth is far away laterally.
    const cz = Math.floor((Math.log(50 / near) / Math.log(far / near)) * grid.z);
    expect(froxelSphereOverlaps(8, 4, cz, 0, 0, -50, 2, froxel, 16, 9, 24, near, far)).toBe(true);
    expect(froxelSphereOverlaps(0, 0, cz, 0, 0, -50, 2, froxel, 16, 9, 24, near, far)).toBe(false);
    expect(
      froxelSphereOverlaps(
        0,
        0,
        0,
        0,
        0,
        -50,
        Number.POSITIVE_INFINITY,
        froxel,
        16,
        9,
        24,
        near,
        far,
      ),
    ).toBe(true);
    const ortho = mat4.create();
    ortho[14] = -0.5;
    expect(froxelProjection(ortho)).toBeUndefined();
  });

  it('measures exact occupancy as a subset of the cell box', () => {
    const lights = Array.from({ length: 48 }, (_, index) => ({
      position: vec3.create((index % 8) * 6 - 21, 1, -(Math.floor(index / 8) * 12) - 4),
      range: 16,
    }));
    const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
    const indices = new Uint32Array(1 << 18);
    const scratch = createClusterBinScratch();
    const result = bin(
      lights,
      view,
      projection,
      grid,
      near,
      far,
      clusterGrid,
      indices,
      indices.length,
      scratch,
    );
    expect(result.ok).toBe(true);
    const payload = new Int32Array(producerBoundsInt32Length(lights.length));
    encodeProducerBounds(lights, scratch.lightBounds, view, projection, payload);
    expect(payload[5]).toBe(1);
    const report = measureClusterOccupancy(lights.length, payload, grid, near, far);
    expect(report.box.entries).toBe(result.ok ? result.value : -1);
    const exact = report.exact;
    if (exact === undefined) throw new Error('exact occupancy expected for a perspective payload');
    expect(exact.entries).toBeLessThan(report.box.entries);
    expect(exact.max).toBeLessThanOrEqual(report.box.max);
    expect(report.box.histogram.reduce((a, b) => a + b, 0)).toBe(grid.x * grid.y * grid.z);
    expect(exact.histogram.reduce((a, b) => a + b, 0)).toBe(grid.x * grid.y * grid.z);
  });

  it('keeps a spot only in froxels its cone reaches', () => {
    const position = vec3.create(0, 0, -10);
    const lights = [
      {
        position,
        range: 30,
        cone: {
          apex: position,
          direction: vec3.create(1, 0, 0),
          cosOuter: Math.cos(0.2),
          range: 30,
        },
      },
    ];
    const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
    const indices = new Uint32Array(1 << 16);
    const scratch = createClusterBinScratch();
    expect(
      bin(lights, view, projection, grid, near, far, clusterGrid, indices, indices.length, scratch)
        .ok,
    ).toBe(true);
    const withCone = new Int32Array(producerBoundsInt32Length(1));
    encodeProducerBounds(lights, scratch.lightBounds, view, projection, withCone);
    const sphereOnly = new Int32Array(producerBoundsInt32Length(1));
    encodeProducerBounds(
      [{ position, range: 30 }],
      scratch.lightBounds,
      view,
      projection,
      sphereOnly,
    );
    const cone = measureClusterOccupancy(1, withCone, grid, near, far).exact;
    const sphere = measureClusterOccupancy(1, sphereOnly, grid, near, far).exact;
    if (cone === undefined || sphere === undefined) throw new Error('exact occupancy expected');
    expect(cone.entries).toBeGreaterThan(0);
    expect(cone.entries).toBeLessThan(sphere.entries);
  });
});
