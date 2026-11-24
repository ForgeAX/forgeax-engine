import { buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { SDF_SURFACE_POOL_WGSL } from '@forgeax/engine-shader';
import { assert, expect, it } from 'vitest';
import { FIELD_VISIBILITY_BOUNDS_WGSL } from '../../../../shader/src/field-visibility-wgsl';
import { SDF_SURFACE_CANDIDATES_WGSL } from '../../../../shader/src/sdf-surface-candidates-wgsl';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { sceneFieldSourceEpoch } from '../../raytracing/scene-field-projection';
import { packSdfScene, type SdfMeshInstance } from '../../raytracing/sdf-query';
import {
  appendSdfSceneCandidates,
  packSdfSceneCandidates,
  readSdfSceneCandidateDirectory,
  validateSdfSceneCandidateRegion,
} from '../../raytracing/sdf-scene-candidates';
import { validateSdfSurfacePoolHeader } from '../../raytracing/sdf-surface-storage';
import { SDF_SCENE_SURFACE_TRACE_WGSL } from '../../raytracing/sdf-surface-trace';
import { packWorldSource } from '../../raytracing/world-traversal';
import { snapshotBudgetFixture } from '../scene-field-snapshot-budget.fixture';
import {
  authoredMissingBounds,
  envelopeContains,
  type PlacementRay,
  placementCorners,
  placementSegmentCases,
  segmentIntersectsBox,
} from './sdf-placement-bounds.fixture';

const pose = (x = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 3, 1];

/** Restricted executable translation of one pure-u32 DUT predicate. Unsupported
 * code shapes fail closed; this does not execute triangle or World WGSL. */
function associationPredicate(source: string) {
  const matches = [
    ...source.matchAll(/fn sdfSurfaceRowAssociated\(row:u32\) -> bool \{([^}]+)\}/g),
  ];
  expect(matches).toHaveLength(1);
  const body = /^\s*return\s+([\s\S]+);\s*$/.exec(matches[0]?.[1] ?? '');
  assert(body?.[1]);
  const expression = body[1],
    token = /\s+|0x[\da-f]+u|\d+u|sdfInstanceWord|row|true|false|==|&&|[+*(),]/gy;
  let consumed = 0;
  while (token.exec(expression)) consumed = token.lastIndex;
  expect(consumed).toBe(expression.length);
  return new Function(
    'row',
    'sdfInstanceWord',
    `return (${expression.replace(/(0x[\da-f]+|\d+)u/g, '$1')});`,
  ) as (row: number, read: (row: number, word: number) => number) => boolean;
}

it('preserves sampled mode and own-packet association on retained rows', () => {
  const rows = [
    { row: 0, mode: 0x40000000, address: 4, expected: true },
    { row: 1, mode: 0x40000000, address: 24, expected: true },
    { row: 0, mode: 0, address: 4, expected: false },
    { row: 0, mode: 0x3f800000, address: 4, expected: false },
    { row: 0, mode: 0x40000000, address: 24, expected: false },
    { row: 1, mode: 0x40000000, address: 4, expected: false },
    { row: 0, mode: 0x40000000, address: 0xffffffff, expected: false },
  ];
  const run = (source: string) => {
    const evaluate = associationPredicate(source);
    return rows.map((value) =>
      evaluate(value.row, (_row, word) =>
        word === 35 ? value.mode : word === 20 ? value.address : 0,
      ),
    );
  };
  expect(run(SDF_SURFACE_POOL_WGSL)).toEqual(rows.map((row) => row.expected));
  for (const mutant of [
    SDF_SURFACE_POOL_WGSL.replace('sdfInstanceWord(row,35u)==0x40000000u', 'true'),
    SDF_SURFACE_POOL_WGSL.replace('sdfInstanceWord(row,20u)==4u+row*20u', 'true'),
  ]) {
    expect(mutant).not.toBe(SDF_SURFACE_POOL_WGSL);
    expect(run(mutant)).not.toEqual(rows.map((row) => row.expected));
  }
  expect(SDF_SCENE_SURFACE_TRACE_WGSL).toContain('if(!sdfSurfaceRowAssociated(row))');
});
async function packed() {
  const field = (
    await buildVisibilityDistanceField([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2], {
      voxelSize: 0.5,
      triangleSidedness: [1],
    })
  ).unwrap();
  const source: SdfMeshInstance[] = [
    { instanceId: 1, geometryId: 1, mask: 255, transform: pose(), field },
    {
      instanceId: 2,
      geometryId: 2,
      mask: 255,
      transform: pose(4),
      field: { missing: true, bounds: authoredMissingBounds },
    },
  ];
  return packSdfScene(source, 64, 4, 7).unwrap();
}

it('shares directory qualification across Field and World without borrowing source expectations', async () => {
  const data = await packed();
  const words = new Uint32Array(data.fields.buffer);
  const admitted = readSdfSceneCandidateDirectory(words).unwrap();
  assert(admitted);
  const match =
    /fn sdfSurfaceExpectedDirectory\([\s\S]*?\) -> SdfSurfaceDirectory \{([\s\S]*?)\n\}/.exec(
      SDF_SURFACE_POOL_WGSL,
    );
  assert(match?.[1]);
  // This restricted integer-only source translation exercises the actual shared
  // metadata predicate, not Slab/triangle WGSL or GPU transport execution.
  expect(match[1]).not.toMatch(/\b(for|while|loop|bitcast)\b/);
  const execute = new Function(
    'rowLimit',
    'expectedSource',
    'sdfInstanceRowCount',
    'sdfFieldWordCount',
    'sdfSurfaceDirectory',
    'sdfSurfaceDirectoryInvalid',
    match[1].replace(/\b(\d+)u\b/g, '$1').replace(/\blet\b/g, 'const'),
  );
  const directory = { ...admitted, valid: 1, indexed: 1 };
  const expected = [data.instances.byteLength / 4, words.length, 2, 7];
  const run = (tuple = expected, value = directory, count = 2) =>
    execute(
      count,
      { x: tuple[0], y: tuple[1], z: tuple[2], w: tuple[3] },
      () => 4,
      () => words.length,
      () => value,
      () => ({ valid: 0 }),
    ) as { valid: number };
  expect(words[1]).toBe(0x80000004);
  expect(run().valid).toBe(1);
  for (const index of [0, 1, 2, 3]) {
    const wrong = [...expected];
    wrong[index] = (wrong[index] ?? 0) + 1;
    expect(run(wrong).valid).toBe(0);
  }
  expect(run(expected, { ...directory, epoch: 6 }).valid).toBe(0);
  expect(run(expected, { ...directory, rowLimit: 1 }).valid).toBe(0);
  expect(run(expected, { ...directory, valid: 0 }).valid).toBe(0);
  expect(run(expected, directory, 5).valid).toBe(0);
  // No optional index is a legitimate complete-roster fallback, not stale metadata.
  expect(run(expected, { ...directory, indexed: 0, epoch: 0, rowLimit: 0 }).valid).toBe(1);
  expect(FIELD_VISIBILITY_BOUNDS_WGSL).toContain(
    'sdfSurfaceExpectedDirectory(sdfSceneRowLimit(),sdfSceneExpected())',
  );
  expect(SDF_SURFACE_CANDIDATES_WGSL).toContain(
    'sdfSurfaceExpectedDirectory(rowLimit,expectedSource)',
  );
  expect(FIELD_VISIBILITY_BOUNDS_WGSL).toContain('if(!sdfSurfaceCharge(remaining)){return false;}');
  expect(FIELD_VISIBILITY_BOUNDS_WGSL).toContain('sdfSurfacePacket(row).valid==0u');
});
/** Independent literal V4-footer/node reader. This is an exact CPU oracle,
 * not execution of the binding-free WGSL consumer. */
function queryWords(words: Uint32Array, capacity: number, ray: PlacementRay) {
  const footer = (words[3] ?? 0) - 8;
  expect(words[1]).toBe(0x80000004);
  expect(words[footer]).toBe(0x53434256);
  const first = (words[footer + 2] ?? 0) + capacity * 8,
    count = words[footer + 4] ?? 0,
    view = new DataView(words.buffer, words.byteOffset, words.byteLength),
    rows = new Set<number>();
  let node = 0,
    visits = 0;
  while (node < count) {
    if (++visits > 2 * capacity - 1) throw Error('Authored candidate bound exceeded');
    const at = first + node * 8,
      flags = words[at + 3] ?? 0,
      escapeIndex = words[at + 7] ?? 0;
    assert(escapeIndex > node && escapeIndex <= count);
    const min = [0, 1, 2].map((axis) => view.getFloat32((at + axis) * 4, true)) as [
        number,
        number,
        number,
      ],
      max = [0, 1, 2].map((axis) => view.getFloat32((at + axis + 4) * 4, true)) as [
        number,
        number,
        number,
      ];
    if (flags & 0x40000000 && !segmentIntersectsBox(ray, { min, max })) {
      node = escapeIndex;
      continue;
    }
    if (flags & 0x80000000) {
      rows.add(flags & 1023);
      node = escapeIndex;
    } else node++;
  }
  return { rows: [...rows].sort((a, b) => a - b), visits };
}

it('retains the disjoint missing row only when the entire closed segment can reach it', async () => {
  const data = await packed(),
    words = new Uint32Array(data.fields.buffer),
    directory = readSdfSceneCandidateDirectory(words).unwrap();
  assert(directory);
  expect(directory.epoch).toBe(7);
  expect(directory.rowLimit).toBe(2);
  expect(validateSdfSurfacePoolHeader(words, 0, 4).ok).toBe(true);
  expect(validateSdfSurfacePoolHeader(words, 1, 4).ok).toBe(false);
  for (const row of placementSegmentCases()) {
    const actual = queryWords(words, 4, row.ray);
    expect(actual.rows.includes(1), row.name).toBe(row.intersects);
    expect(actual.visits).toBeLessThanOrEqual(7);
  }
  const near = queryWords(words, 4, { origin: [0, 0, 0], direction: [0, 0, 1], first: 0, last: 8 });
  expect(near.rows).toEqual([0]);
});

it('always retains an unknown enclosure and excludes zero-mask tombstones', () => {
  const instances = new Uint8Array(4 * 144),
    view = new DataView(instances.buffer);
  for (const row of [0, 1]) {
    for (const axis of [0, 5, 10, 15]) view.setFloat32(row * 144 + axis * 4, 1, true);
    view.setUint32(row * 144 + 80, 0xffffffff, true);
  }
  view.setUint32(76, 255, true);
  view.setUint32(144 + 76, 255, true);
  const bounds = [{ min: [3, -1, 2.875], max: [5, 1, 3.125] } as const, undefined, undefined],
    region = packSdfSceneCandidates(bounds, instances, 4, 4096).unwrap();
  assert(region);
  expect(region.nodeCount).toBe(3);
  const base = new Uint32Array(4 + 4 * 24);
  base.set([0x53534650, 4, 4, base.length]);
  const words = appendSdfSceneCandidates(base, instances, bounds, 1).unwrap().words;
  expect(
    queryWords(words, 4, { origin: [0, 0, 0], direction: [0, 0, 1], first: 0, last: 8 }).rows,
  ).toEqual([1]);
});

it('encloses rotated, negative-scale and sheared placements over the whole segment', () => {
  const poses = [
    [-2, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 0.5, 0, 6, 0, 3, 1],
    [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, -4, 0, 3, 1],
  ];
  const source = poses.map((transform, row) => ({
    instanceId: row + 1,
    geometryId: row + 1,
    mask: 255,
    transform,
    field: { missing: true as const, bounds: authoredMissingBounds },
  }));
  const data = packSdfScene(source, 64, 4, 8).unwrap(),
    words = new Uint32Array(data.fields.buffer);
  for (const [row, transform] of poses.entries()) {
    const box = data.placementBounds[row];
    assert(box);
    expect(
      envelopeContains(box, placementCorners(Float32Array.from(transform), authoredMissingBounds)),
    ).toBe(true);
  }
  for (const speed of [0.5, 1, 2]) {
    for (const [x, expected] of [
      [0, []],
      [6, [0]],
      [-4, [1]],
    ] as const) {
      const ray = {
        origin: [x, 0, 0] as const,
        direction: [0, 0, speed] as const,
        first: 0,
        last: 6 / speed,
      };
      const result = queryWords(words, 4, ray);
      expect(result.rows).toEqual(expected);
      expect(result.visits).toBeLessThanOrEqual(7);
    }
  }
});

it('rejects malformed topology, missing coverage and inward bounds in producer admission', async () => {
  const data = await packed(),
    words = new Uint32Array(data.fields.buffer),
    dir = readSdfSceneCandidateDirectory(words).unwrap();
  assert(dir);
  const region = words.slice(dir.first, dir.first + dir.words),
    first = 4 * 8;
  const mutations = [
    (bad: Uint32Array) => {
      bad[first + 7] = 1;
    },
    (bad: Uint32Array) => {
      bad[first + 8 + 3] = 0xc0000001;
    },
    (bad: Uint32Array) => {
      bad[first] = 0x40000000;
    },
    (bad: Uint32Array) => {
      bad[3] = 2;
    },
    (bad: Uint32Array) => {
      bad[bad.length - 1] = 1;
    },
  ];
  expect(
    validateSdfSceneCandidateRegion(region, dir.nodeCount, data.placementBounds, data.instances, 4)
      .ok,
  ).toBe(true);
  for (const mutate of mutations) {
    const bad = region.slice();
    mutate(bad);
    expect(bad).not.toEqual(region);
    expect(
      validateSdfSceneCandidateRegion(bad, dir.nodeCount, data.placementBounds, data.instances, 4)
        .ok,
    ).toBe(false);
  }
});

it('charges optional metadata after the complete actual source span without truncating geometry', async () => {
  const data = await packed(),
    base = new Uint32Array(data.fields.buffer),
    dir = readSdfSceneCandidateDirectory(base).unwrap();
  assert(dir);
  const geometry = new Uint32Array((16 * 1024 * 1024) / 4);
  geometry.set(base.subarray(0, dir.first));
  geometry[1] = 4;
  geometry[3] = dir.geometryEnd;
  expect(validateSdfSurfacePoolHeader(geometry, 0, 4).ok).toBe(true);
  const skipped = appendSdfSceneCandidates(
    geometry,
    data.instances,
    data.placementBounds,
    7,
  ).unwrap();
  expect(skipped.words).toBe(geometry);
  expect(skipped.directory).toBeUndefined();
  expect(validateSdfSurfacePoolHeader(skipped.words, 0, 4).ok).toBe(true);
  expect(appendSdfSceneCandidates(geometry, data.instances, data.placementBounds, 0).ok).toBe(
    false,
  );
});

it('rejects an active spare row beyond the declared highwater before publication', async () => {
  const data = await packed(),
    words = new Uint32Array(data.fields.buffer),
    directory = readSdfSceneCandidateDirectory(words).unwrap();
  assert(directory);
  const region = words.slice(directory.first, directory.first + directory.words);
  const hidden = data.instances.slice();
  new DataView(hidden.buffer).setUint32((3 * 36 + 19) * 4, 255, true);
  expect(
    validateSdfSceneCandidateRegion(region, directory.nodeCount, data.placementBounds, hidden, 4)
      .ok,
  ).toBe(false);
  expect(packSdfSceneCandidates(data.placementBounds, hidden, 4, directory.words).ok).toBe(false);
  const base = words.slice(0, directory.first);
  base[1] = 3;
  base[3] = directory.geometryEnd;
  expect(appendSdfSceneCandidates(base, hidden, data.placementBounds, 7).ok).toBe(false);
  expect(directory.rowLimit).toBe(2);
  expect(data.instances.byteLength / 144).toBe(4);
});

it('qualifies actual empty, first-add and removal snapshots using one noncolliding source clock', async () => {
  const f = await snapshotBudgetFixture();
  const grid = {
    origin: [-2, -2, -2] as const,
    dimensions: [4, 4, 4] as const,
    spacing: 1,
    maxDistance: 4,
    coverageDistance: 0.5,
  };
  try {
    expect(f.sourceRevision).toBe(0);
    f.remove(0);
    const empty = f.project(1024 * 1024).unwrap(),
      rawEmpty = f.sourceRevision,
      first = packGlobalSdfComposition(empty.instances, grid, {
        capacity: 4,
        sourceEpoch: sceneFieldSourceEpoch(rawEmpty).unwrap(),
      }).unwrap();
    expect(empty.instances).toHaveLength(0);
    assert(first.sourceExpected);
    expect(first.sourceExpected[2]).toBe(0);
    expect(first.sourceExpected[3]).toBeGreaterThan(0);
    const entity = f.spawnSameMesh(),
      added = f.project(1024 * 1024).unwrap(),
      rawAdd = f.sourceRevision,
      second = packGlobalSdfComposition(added.instances, grid, {
        capacity: 4,
        sourceEpoch: sceneFieldSourceEpoch(rawAdd).unwrap(),
      }).unwrap();
    assert(second.sourceExpected);
    expect(added.instances).toHaveLength(1);
    expect(rawAdd).toBeGreaterThan(rawEmpty);
    f.remove(entity);
    const removed = f.project(1024 * 1024).unwrap(),
      rawRemove = f.sourceRevision,
      third = packGlobalSdfComposition(removed.instances, grid, {
        capacity: 4,
        sourceEpoch: sceneFieldSourceEpoch(rawRemove).unwrap(),
      }).unwrap();
    assert(third.sourceExpected);
    expect(removed.instances).toHaveLength(0);
    expect(rawRemove).toBeGreaterThan(rawAdd);
    expect(
      new Set([first.sourceExpected[3], second.sourceExpected[3], third.sourceExpected[3]]).size,
    ).toBe(3);
    expect(packWorldSource({ traversal: 'global-sdf', expected: first.sourceExpected }).ok).toBe(
      true,
    );
    expect(packWorldSource({ traversal: 'global-sdf', expected: [0, 0, 0, 0] }).ok).toBe(false);
    expect(sceneFieldSourceEpoch(0xffffffff).ok).toBe(false);
    expect(sceneFieldSourceEpoch(0xfffffffe).unwrap()).toBe(0xffffffff);
  } finally {
    f.dispose();
  }
});
