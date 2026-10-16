import { describe, expect, it } from 'vitest';
import { buildMeshCardLayout } from '../mesh-card-layout';
import { createTriangleQuery, type QueryTriangle } from '../triangle-query';

const positions = [
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
];
const indices = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6,
  1, 6, 5,
];

describe('offline card layout', () => {
  it('keeps an inner Card behind the occluder excluded by its fitted near plane', async () => {
    const p: number[] = [],
      ix: number[] = [];
    // An eight-unit width makes the sampling cells one unit deep. The upper
    // sheet at 1.55 occupies the preceding cell; 1.6 would capture it again.
    for (const [left, right, y] of [
      [0, 6, 1.55],
      [6, 8, 2.1],
      [0, 8, 0.95],
    ] as const) {
      const offset = p.length / 3;
      p.push(left, y, 0, left, y, 8, right, y, 8, right, y, 0);
      ix.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
    }
    const layout = (await buildMeshCardLayout(p, ix, { resolution: 8 })).unwrap();
    const inner = layout.cards.find((c) => c.n[1] === 1 && c.origin[1] < 1.55);
    expect(inner, 'the lower sheet needs a capture below the upper sheet').toBeDefined();
    if (!inner) return;
    expect(inner.origin[1]).toBeGreaterThan(0.95);
    expect(inner.origin[1] - inner.depth).toBeLessThan(0.95);
    const triangles: QueryTriangle[] = [];
    const vertex = (index: number): QueryTriangle[0] => [
      p[index * 3] ?? NaN,
      p[index * 3 + 1] ?? NaN,
      p[index * 3 + 2] ?? NaN,
    ];
    for (let i = 0; i < ix.length; i += 3) {
      triangles.push([vertex(ix[i] ?? -1), vertex(ix[i + 1] ?? -1), vertex(ix[i + 2] ?? -1)]);
    }
    const query = createTriangleQuery(triangles),
      hit = { primitive: -1, distance: 0, frontFace: false };
    expect(query.trace(hit, [2, inner.origin[1], 2], [0, -1, 0], 0, inner.depth)).toBe(true);
    expect(hit.primitive).toBeGreaterThanOrEqual(4);
    expect(inner.origin[1] - hit.distance).toBeCloseTo(0.95, 6);
    // Falsifier: the old half-cell extension reintroduces the excluded sheet.
    expect(query.trace(hit, [2, 1.6, 2], [0, -1, 0], 0, 2)).toBe(true);
    expect(hit.primitive).toBeLessThan(2);
  });
  it.each([
    24, 30, 32,
  ])('packs nearby islands within the Card budget at resolution %s', async (resolution) => {
    const p: number[] = [],
      ix: number[] = [];
    for (const [y, z, size] of [
      [0, 0, 1],
      [3, 0, 1],
      [21, 21, 0.5],
    ] as const) {
      const offset = p.length / 3;
      p.push(0, y, z, 0, y + size, z, 0, y + size, z + size, 0, y, z + size);
      ix.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
    }
    const layout = (await buildMeshCardLayout(p, ix, { resolution, maxCards: 1 })).unwrap();
    const front = layout.cards.filter((card) => card.n[0] === 1);
    expect(front).toHaveLength(1);
    expect(
      front.some((card) =>
        [0.5, 3.5].every(
          (y) =>
            y >= card.origin[1] &&
            y <= card.origin[1] + card.width &&
            0.5 <= card.origin[2] &&
            0.5 >= card.origin[2] - card.height,
        ),
      ),
    ).toBe(true);
  });
  it.each([
    false,
    true,
  ])('keeps separated dense surface islands when two-sided=%s', async (twoSided) => {
    const p = [0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 20, 20, 0, 21, 20, 0, 21, 21, 0, 20, 21];
    const ix = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
    const settings = {
      resolution: 32,
      maxCards: 64,
      triangleSidedness: new Uint8Array(ix.length / 3).fill(Number(twoSided)),
    };
    const layout = (await buildMeshCardLayout(p, ix, settings)).unwrap();
    const front = layout.cards.filter((card) => card.n[0] === 1);
    expect(front).toHaveLength(2);
    expect(layout.cards.filter((card) => card.n[0] === -1)).toHaveLength(twoSided ? 2 : 0);
    // Each island needs a tight projection; the empty space between them is not surface coverage.
    for (const center of [
      [0, 0.5, 0.5],
      [0, 20.5, 20.5],
    ]) {
      expect(
        front.some((card) => {
          const relative = center.map((value, axis) => value - (card.origin[axis] ?? 0));
          const project = (axis: readonly number[]) =>
            relative.reduce((sum, value, i) => sum + value * (axis[i] ?? 0), 0);
          return (
            project(card.u) >= 0 &&
            project(card.u) <= card.width &&
            project(card.v) >= 0 &&
            project(card.v) <= card.height
          );
        }),
      ).toBe(true);
    }
    expect(front.every((card) => card.width < 2 && card.height < 2)).toBe(true);
    const capped = (await buildMeshCardLayout(p, ix, { ...settings, maxCards: 1 })).unwrap();
    expect(capped.cards).toHaveLength(1);
  });

  it('keeps mixed triangle sidedness local when fitting one mesh representation', async () => {
    // The left sheet is one-sided; only the right sheet may produce a back card.
    const p = [-3, -1, 0, -1, -1, 0, -3, 1, 0, -1, 1, 0, 1, -1, 0, 3, -1, 0, 1, 1, 0, 3, 1, 0];
    const ix = [0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6];
    const layout = (
      await buildMeshCardLayout(p, ix, {
        resolution: 24,
        triangleSidedness: [0, 0, 1, 1],
      })
    ).unwrap();
    const back = layout.cards.filter((c) => c.n[2] === -1);
    expect(back).toHaveLength(1);
    expect(back[0]?.origin[0]).toBeGreaterThanOrEqual(1);
    expect(back[0]?.width).toBeLessThanOrEqual(2);
    const changed = (
      await buildMeshCardLayout(p, ix, {
        resolution: 24,
        triangleSidedness: [1, 1, 0, 0],
      })
    ).unwrap();
    expect(changed.meshDigest).toBe(layout.meshDigest);
    expect(changed.sidednessDigest).not.toBe(layout.sidednessDigest);
    expect(changed.cards.find((c) => c.n[2] === -1)?.origin[0]).toBeLessThan(0);
    for (const triangleSidedness of [[0], [0, 0, 1, 2], [0, 0, 1, NaN]])
      expect((await buildMeshCardLayout(p, ix, { triangleSidedness })).ok).toBe(false);
  });
  it('finds interior room cards when no outer projection has an admissible front face', async () => {
    const room = (
      await buildMeshCardLayout(positions, [...indices].reverse(), { resolution: 16 })
    ).unwrap();
    expect(room.cards).toHaveLength(6);
    expect(room.sampling.representedWeight).toBe(room.sampling.weightedCoverage);
  });
  it('fits all six box sides independently of any SDF or material capture', async () => {
    const result = (await buildMeshCardLayout(positions, indices, { resolution: 8 })).unwrap();
    expect(result.cards).toHaveLength(6);
    expect(result.sampling.representedWeight).toBe(result.sampling.weightedCoverage);
    expect(new Set(result.cards.map((c) => c.n.join(','))).size).toBe(6);
    for (const card of result.cards) {
      expect(card.width).toBe(2);
      expect(card.height).toBe(2);
      expect(card.depth).toBeGreaterThan(0);
      const near = card.origin.reduce((sum, x, i) => sum + x * (card.n[i] ?? NaN), 0);
      expect(near).toBeGreaterThan(1);
      expect(near - card.depth).toBeLessThan(1);
    }
    expect(await buildMeshCardLayout(positions, indices, { resolution: 8 })).toEqual(
      await buildMeshCardLayout(positions, indices, { resolution: 8 }),
    );
  });

  it('fits multiple depth layers and reports actual loss under a smaller global budget', async () => {
    const p: number[] = [],
      ix: number[] = [];
    // Three disconnected outward boxes need separate front/back depth planes.
    for (const center of [-4, 0, 4]) {
      const offset = p.length / 3;
      p.push(...positions.map((v, i) => v + (i % 3 === 2 ? center : 0)));
      ix.push(...indices.map((v) => v + offset));
    }
    const layout = (await buildMeshCardLayout(p, ix, { resolution: 24, maxCards: 24 })).unwrap();
    expect(layout.cards.filter((c) => c.n[2] === 1).length).toBe(3);
    expect(layout.cards.filter((c) => c.n[2] === -1).length).toBe(3);
    expect(layout.cards.length).toBeGreaterThan(6);
    const reduced = (await buildMeshCardLayout(p, ix, { resolution: 24, maxCards: 6 })).unwrap();
    expect(reduced.cards).toHaveLength(6);
    expect(reduced.sampling.weightedCoverage).toBe(layout.sampling.weightedCoverage);
    expect(reduced.sampling.representedWeight).toBeLessThan(layout.sampling.representedWeight);
    expect(reduced.cards).toEqual(layout.cards.slice(0, 6));
  });

  it('represents the visible top of a closed slab in an adjacent depth cell', async () => {
    const p: number[] = [],
      ix: number[] = [];
    // A lower slab is visible from the air gap, independently of the upper top.
    // Both outward top surfaces occupy consecutive cells at the fixed resolution.
    for (const [bottom, top] of [
      [0, 0.01],
      [0.2, 0.21],
    ] as const) {
      const offset = p.length / 3;
      p.push(...positions.map((v, i) => (i % 3 === 1 ? (v < 0 ? bottom : top) : v * 0.5)));
      ix.push(...indices.map((v) => v + offset));
    }
    const layout = (await buildMeshCardLayout(p, ix, { resolution: 8, maxCards: 24 })).unwrap();
    const upward = layout.cards.filter((c) => c.n[1] === 1);
    expect(
      upward.some((c) => c.origin[1] > 0.01 && c.origin[1] < 0.2 && c.origin[1] - c.depth < 0.01),
    ).toBe(true);
    expect(upward.some((c) => c.origin[1] > 0.21 && c.origin[1] - c.depth < 0.21)).toBe(true);
    expect(layout.cards.length).toBeLessThanOrEqual(24);
    const reduced = (await buildMeshCardLayout(p, ix, { resolution: 8, maxCards: 6 })).unwrap();
    expect(reduced.cards).toHaveLength(6);
    expect(reduced.sampling.weightedCoverage).toBe(layout.sampling.weightedCoverage);
    expect(reduced.sampling.representedWeight).toBeLessThan(layout.sampling.representedWeight);
  });

  it('captures the two sides of an open thin sheet and rejects malformed source', async () => {
    const p = [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0],
      ix = [0, 1, 2, 1, 3, 2];
    const one = (await buildMeshCardLayout(p, ix)).unwrap();
    const two = (
      await buildMeshCardLayout(p, ix, { triangleSidedness: new Uint8Array(ix.length / 3).fill(1) })
    ).unwrap();
    expect(one.cards).toHaveLength(1);
    expect(two.cards).toHaveLength(2);
    expect(two.cards.map((c) => c.n[2]).sort()).toEqual([-1, 1]);
    for (const settings of [{ resolution: 0 }, { maxCards: 65 }, { resolution: NaN }])
      expect((await buildMeshCardLayout(p, ix, settings)).ok).toBe(false);
    expect((await buildMeshCardLayout([NaN, ...p.slice(1)], ix)).ok).toBe(false);
    expect((await buildMeshCardLayout(p, [99, 1, 2])).ok).toBe(false);
    expect((await buildMeshCardLayout(p, [0, 0, 0])).ok).toBe(false);
  });
});
