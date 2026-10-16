import { describe, expect, it } from 'vitest';
import { createNavigationGraph, createNavigationGrid } from '../index';

describe('navigation paths', () => {
  it('routes around a wall without crossing blocked cells', () => {
    const blocked = new Uint8Array(25);
    for (const id of [2, 7, 12, 17]) blocked[id] = 1;
    const graph = createNavigationGrid({ width: 5, height: 5, blocked }).unwrap();
    const path = graph.findPath(0, 4).unwrap();
    expect(path.cost).toBe(12);
    expect(path.nodes[0]).toBe(0);
    expect(path.nodes.at(-1)).toBe(4);
    expect(path.nodes.some((id) => blocked[id] === 1)).toBe(false);
  });
  it('finds optimal paths even with edges cheaper than geometric distance', () => {
    const graph = createNavigationGraph({
      positions: [0, 0, 0, 1, 0, 0, 100, 0, 0],
      edges: [
        { from: 0, to: 1, cost: 5 },
        { from: 0, to: 2, cost: 1 },
        { from: 2, to: 1, cost: 1 },
      ],
    }).unwrap();
    expect(graph.findPath(0, 1).unwrap().nodes).toEqual([0, 2, 1]);
    expect(graph.findPath(0, 1).unwrap().cost).toBe(2);
  });
});

describe('query invariants', () => {
  it('preserves search efficiency when traversal units exceed geometric units', () => {
    const graph = createNavigationGrid({
      width: 64,
      height: 64,
      weights: new Float32Array(64 * 64).fill(1000),
    }).unwrap();
    const path = graph.findPath(0, 64 * 64 - 1).unwrap();
    expect(path.cost).toBe(126000);
    // At most twice the shortest route length, independent of machine wall time.
    expect(path.visited).toBeLessThan(256);
  });
  it('keeps coincident and subnormal coordinates safe at extreme valid costs', () => {
    const coincident = createNavigationGraph({
      positions: [0, 0, 0, 0, 0, 0],
      edges: [{ from: 0, to: 1, cost: 0 }],
    }).unwrap();
    expect(coincident.findPath(0, 1).unwrap().cost).toBe(0);
    const cost = Number.MAX_VALUE / 1_048_576;
    const tiny = createNavigationGraph({
      positions: [0, 0, 0, 2 ** -149, 0, 0],
      edges: [{ from: 0, to: 1, cost }],
    }).unwrap();
    expect(tiny.findPath(0, 1).unwrap().cost).toBe(cost);
  });
  it('does not cut diagonally between blocked cells', () => {
    const graph = createNavigationGrid({
      width: 2,
      height: 2,
      diagonal: true,
      blocked: [0, 1, 1, 0],
    }).unwrap();
    const result = graph.findPath(0, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('navigation-unreachable');
  });
  it('supports XY/XZ, cell size, origin, diagonal distance and entering weights', () => {
    const grid = createNavigationGrid({
      width: 2,
      height: 2,
      diagonal: false,
      plane: 'xy',
      cellSize: 2,
      origin: [10, 20, 30],
      weights: [1, 0.1, 1, 0.1],
    }).unwrap();
    const path = grid.findPath(0, 3).unwrap();
    expect(path.cost).toBeCloseTo(0.4);
    expect([...path.points]).toEqual([10, 20, 30, 12, 20, 30, 12, 22, 30]);
    const diagonal = createNavigationGrid({ width: 2, height: 2, diagonal: true })
      .unwrap()
      .findPath(0, 3)
      .unwrap();
    expect(diagonal.cost).toBeCloseTo(Math.SQRT2);
  });
  it('keeps directed edges, zero-cost cycles, source copies and prior results independent', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 1]);
    const edges = [
      { from: 0, to: 1, cost: 0 },
      { from: 1, to: 0, cost: 0 },
      { from: 1, to: 2, cost: 1 },
    ];
    const graph = createNavigationGraph({ positions, edges }).unwrap();
    positions.fill(100);
    Object.assign(edges[2] ?? {}, { cost: 200 });
    const first = graph.findPath(0, 2).unwrap();
    expect(first.cost).toBe(1);
    expect([...first.points]).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 1]);
    first.points.fill(200);
    expect(graph.findPath(0, 2).unwrap().points[0]).toBe(0);
    expect(graph.findPath(2, 0).ok).toBe(false);
    expect(graph.findPath(1, 1).unwrap().nodes).toEqual([1]);
  });
  it('distinguishes query exhaustion, unreachable and invalid endpoints and recovers after failures', () => {
    const graph = createNavigationGrid({ width: 20, height: 20 }).unwrap();
    const limited = graph.findPath(0, 399, { maxVisited: 1 });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.code).toBe('navigation-query-limit');
    for (const id of [-1, 400, 0.1, NaN]) {
      const invalid = graph.findPath(id, 399);
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.error.code).toBe('navigation-invalid-node');
    }
    expect(graph.findPath(0, 399, { maxVisited: 0 }).ok).toBe(false);
    expect(graph.findPath(0, 399).unwrap().cost).toBe(38);
    const blocked = createNavigationGrid({ width: 2, height: 1, blocked: [1, 0] }).unwrap();
    expect(blocked.findPath(0, 0).ok).toBe(false);
  });
  it('rejects malformed topology and grids before constructing a graph', () => {
    for (const source of [
      { positions: [], edges: [] },
      { positions: [0, 0], edges: [] },
      { positions: [Infinity, 0, 0], edges: [] },
      { positions: [1e80, 0, 0], edges: [] },
      { positions: [0, 0, 0], edges: [{ from: 0, to: 1 }] },
      { positions: [0, 0, 0], edges: [{ from: 0, to: 0, cost: -1 }] },
      { positions: [0, 0, 0], edges: [{ from: 0, to: 0, cost: Infinity }] },
      { positions: [0, 0, 0], edges: [], blocked: [NaN] },
    ])
      expect(createNavigationGraph(source).ok).toBe(false);
    for (const source of [
      { width: 0, height: 1 },
      { width: 1.5, height: 1 },
      { width: 2e6, height: 1 },
      { width: 1, height: 1, cellSize: 0 },
      { width: 1, height: 1, weights: [0] },
      { width: 1, height: 1, weights: [] },
      { width: 1, height: 1, blocked: [] },
    ])
      expect(createNavigationGrid(source).ok).toBe(false);
  });
  it('matches an independent Bellman-Ford oracle on seeded directed weighted 3D graphs', () => {
    let seed = 87241;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let trial = 0; trial < 80; trial++) {
      const count = 30;
      const positions = Array.from({ length: count * 3 }, () => random() * 100);
      const edges = Array.from({ length: count * 4 }, () => ({
        from: Math.floor(random() * count),
        to: Math.floor(random() * count),
        cost:
          trial % 3 === 0
            ? Math.floor(random() * 10)
            : trial % 3 === 1
              ? 0.01 + random()
              : 1000 + random() * 1000,
      }));
      const graph = createNavigationGraph({ positions, edges }).unwrap();
      for (let goal = 0; goal < count; goal++) {
        const distance = new Float64Array(count).fill(Infinity);
        distance[0] = 0;
        for (let pass = 1; pass < count; pass++)
          for (const edge of edges)
            distance[edge.to] = Math.min(
              distance[edge.to] as number,
              (distance[edge.from] as number) + edge.cost,
            );
        const result = graph.findPath(0, goal);
        if (Number.isFinite(distance[goal])) {
          expect(result.ok).toBe(true);
          expect(result.unwrap().cost).toBeCloseTo(distance[goal] as number, 8);
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.code).toBe('navigation-unreachable');
        }
      }
    }
  });
});

it('matches independently enumerated weighted-grid shortest paths with both connectivity modes', () => {
  let seed = 48136;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (let trial = 0; trial < 40; trial++) {
    const width = 8;
    const count = width * width;
    const blocked = Array.from({ length: count }, () => Number(random() < 0.2));
    blocked[0] = 0;
    blocked[count - 1] = 0;
    const weights = Array.from({ length: count }, () => 0.05 + random() * 3);
    const diagonal = trial % 2 === 0;
    const graph = createNavigationGrid({
      width,
      height: width,
      blocked,
      weights,
      diagonal,
    }).unwrap();
    const costs = new Float64Array(count).fill(Infinity);
    costs[0] = 0;
    for (let pass = 0; pass < count; pass++) {
      for (let from = 0; from < count; from++) {
        if (blocked[from]) continue;
        const x = from % width;
        const y = Math.floor(from / width);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            if (!diagonal && dx !== 0 && dy !== 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= width) continue;
            const to = ny * width + nx;
            if (blocked[to]) continue;
            if (dx !== 0 && dy !== 0 && (blocked[y * width + nx] || blocked[ny * width + x]))
              continue;
            costs[to] = Math.min(
              costs[to] as number,
              (costs[from] as number) + Math.hypot(dx, dy) * (weights[to] as number),
            );
          }
        }
      }
    }
    const path = graph.findPath(0, count - 1);
    if (Number.isFinite(costs[count - 1])) {
      expect(path.ok).toBe(true);
      expect(path.unwrap().cost).toBeCloseTo(costs[count - 1] as number, 8);
    } else expect(path.ok).toBe(false);
  }
});
