import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { IrradianceFieldLevelWindow } from '../../raytracing/irradiance-field';
import {
  PROBE_ENTRY_FRESH,
  PROBE_ENTRY_INDEX,
  ProbeClipmapScheduler,
  type ProbeFrameSchedule,
} from '../../raytracing/probe-clipmap';
import {
  unselectedWorldCacheEqual,
  type WorldKeyCache,
  type WorldKeyRow,
  type WorldPoint,
  worldKeyFocus,
  worldKeyNextFocus,
  worldKeyPlan,
  worldKeyRatioTolerance,
  worldKeyTable,
} from './probe-clipmap-world-key.fixture';
import { markerError, saveWorldKeyCache } from './probe-clipmap-world-key-evidence.fixture';
import { createWorldKeyHarness, type PlacedWorldKey } from './probe-clipmap-world-key-gpu.fixture';

const directory = process.env.FORGEAX_CLIPMAP_WORLDKEY_EVIDENCE,
  plan = worldKeyPlan();
let host: Awaited<ReturnType<typeof createWorldKeyHarness>>, warm: WorldKeyCache;
let oldRows: readonly IrradianceFieldLevelWindow[],
  oldTable: WorldKeyRow[],
  initialHashes: Record<string, string>;
const records: unknown[] = [];
const sha = (a: ArrayBufferView) =>
  createHash('sha256')
    .update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
    .digest('hex');
const digests = (cache: WorldKeyCache) =>
  Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, sha(v)]));
async function save(name: string, bytes: Uint8Array) {
  if (directory) await writeFile(join(directory, name), bytes);
}
function scheduler() {
  const result = new ProbeClipmapScheduler(plan, worldKeyFocus);
  result.commit(result.schedule());
  result.limit = 4;
  return result;
}
function selected(work: ProbeFrameSchedule) {
  return Array.from(work.list.subarray(0, work.count), (entry) => entry & PROBE_ENTRY_INDEX);
}
function positions(
  placed: readonly PlacedWorldKey[],
  table: readonly WorldKeyRow[],
  failures: string[],
) {
  for (const origin of placed) {
    const expected = table[origin.probe];
    if (!expected) throw new Error('Unknown physical slot');
    if (origin.position.some((v, a) => v !== expected.position[a]))
      failures.push(`physical origin does not match world key ${expected.key}`);
  }
}
async function integrate(
  name: string,
  work: ProbeFrameSchedule,
  rows: readonly IrradianceFieldLevelWindow[],
  frame: number,
  entries = work.list.subarray(0, work.count),
) {
  const placed = await host.place(entries, rows, frame);
  const result = await host.integrate(placed.placed, placed.directions);
  await save(`${name}-origins.bin`, placed.origins);
  await save(`${name}-directions.f32`, new Uint8Array(placed.directions.buffer));
  await save(`${name}-rays.f32`, new Uint8Array(result.rays.buffer));
  await save(
    `${name}-list.u32`,
    new Uint8Array(entries.buffer, entries.byteOffset, entries.byteLength),
  );
  await save(`${name}-frame.bin`, placed.frameBytes);
  await save(`${name}-field.bin`, placed.fieldBytes);
  return { ...result, placed: placed.placed };
}
beforeAll(async () => {
  if (directory) await mkdir(directory, { recursive: true });
  host = await createWorldKeyHarness(plan);
  const initial = new ProbeClipmapScheduler(plan, worldKeyFocus);
  oldRows = initial.windows();
  oldTable = worldKeyTable(plan, oldRows);
  expect(plan.origin).toEqual([-31.5, -31.5, -31.5]);
  expect(oldRows.map((row) => row.window)).toEqual([[29, 30, 30]]);
  const work = initial.schedule(),
    captured = await host.capture(() => integrate('warm', work, oldRows, 0));
  warm = captured.value.cache;
  initialHashes = digests(warm);
  await save('warm.rhitape', captured.tape);
  await saveWorldKeyCache(directory, 'warm', warm, oldTable);
  const failures: string[] = [];
  positions(captured.value.placed, oldTable, failures);
  expect(failures).toEqual([]);
  for (const row of oldTable)
    expect(markerError(warm, row)).toBeLessThanOrEqual(worldKeyRatioTolerance);
}, 90000);

it('retains world keys while16 exposed probes are refreshed in four accepted budget4 chunks', async () => {
  host.load(warm);
  const current = scheduler();
  expect(current.focus(worldKeyNextFocus)).toBe(16);
  expect(current.windows().map((row) => row.window)).toEqual([[30, 30, 30]]);
  const table = worldKeyTable(plan, current.windows()),
    oldKeys = new Set(oldTable.map((r) => r.key)),
    fresh = table.filter((r) => !oldKeys.has(r.key)),
    seen = new Set<string>();
  const failures: string[] = [],
    steps: unknown[] = [];
  for (let frame = 0; frame < 4; frame++) {
    const rows = current.windows(),
      work = current.schedule(),
      before = await host.snapshot();
    const captured = await host.capture(() =>
      integrate(`positive-frame${frame + 1}`, work, rows, frame + 1),
    );
    const result = captured.value,
      ids = selected(work),
      set = new Set(ids);
    positions(result.placed, table, failures);
    if (!unselectedWorldCacheEqual(before, result.cache, set, plan.probeCount))
      failures.push('unselected canonical cache blocks changed');
    for (const id of ids) {
      const row = table[id];
      if (!row) throw new Error('Unknown selected marker');
      seen.add(row.key);
      if (markerError(result.cache, row) > worldKeyRatioTolerance)
        failures.push(`new world-key marker mismatch ${row.key}`);
      if (result.cache.meta[id * 4] !== 1 || result.cache.meta[id * 4 + 1] !== 1)
        failures.push(`fresh world cell has stale count/state ${row.key}`);
    }
    const unprocessed = fresh.find((row) => !seen.has(row.key));
    let query: unknown;
    if (unprocessed) {
      const receiver: WorldPoint = [
          unprocessed.position[0] - 0.25,
          unprocessed.position[1],
          unprocessed.position[2],
        ],
        read = await host.capture(() => host.sample(rows, receiver)),
        sample = read.value;
      if (sample[3] !== 0)
        failures.push('query depending on an untraced new world key was admitted');
      query = { key: unprocessed.key, receiver, sample: Array.from(sample) };
      await save(`positive-frame${frame + 1}-query.rhitape`, read.tape);
    }
    await saveWorldKeyCache(
      directory,
      `positive-frame${frame + 1}`,
      result.cache,
      ids.map((id) => {
        const row = table[id];
        if (!row) throw new Error('Unknown image row');
        return row;
      }),
    );
    await save(`positive-frame${frame + 1}.rhitape`, captured.tape);
    steps.push({
      frame: frame + 1,
      ids,
      keys: ids.map((id) => table[id]?.key),
      rows,
      query,
      cache: digests(result.cache),
    });
    current.commit(work);
  }
  expect(seen).toEqual(new Set(fresh.map((r) => r.key)));
  expect(current.inspect().pendingExposedProbes).toBe(0);
  const target = fresh[5];
  if (!target) throw new Error('Missing completed exposed marker');
  const receiver: WorldPoint = [target.position[0] - 0.25, target.position[1], target.position[2]],
    value = await host.sample(current.windows(), receiver);
  expect(value[3]).toBe(1);
  expect(
    Math.abs((value[0] ?? Number.NaN) / (value[1] ?? Number.NaN) - target.ratio[0]),
  ).toBeLessThanOrEqual(worldKeyRatioTolerance);
  expect(
    Math.abs((value[2] ?? Number.NaN) / (value[1] ?? Number.NaN) - target.ratio[1]),
  ).toBeLessThanOrEqual(worldKeyRatioTolerance);
  records.push({
    name: 'positive',
    steps,
    query: { receiver, value: Array.from(value), expected: target },
    failures,
  });
  expect(failures).toEqual([]);
}, 90000);

for (const mode of ['missing-fresh', 'old-window'] as const)
  it(`detects the single ${mode} fault from the same warm resources`, async () => {
    host.load(warm);
    const current = scheduler();
    current.focus(worldKeyNextFocus);
    const rows = current.windows(),
      table = worldKeyTable(plan, rows),
      work = current.schedule();
    const entries =
      mode === 'missing-fresh'
        ? Uint32Array.from(
            work.list.subarray(0, work.count),
            (entry) => (entry & ~PROBE_ENTRY_FRESH) >>> 0,
          )
        : work.list.subarray(0, work.count);
    const windows =
      mode === 'old-window'
        ? rows.map((row, i) => ({ ...row, window: oldRows[i]?.window ?? row.window }))
        : rows;
    const captured = await host.capture(() => integrate(mode, work, windows, 1, entries)),
      result = captured.value,
      failures: string[] = [];
    positions(result.placed, table, failures);
    const markerMaximum = Math.max(
      ...selected(work).map((id) => {
        const row = table[id];
        if (!row) throw new Error('Missing mutant row');
        return markerError(result.cache, row);
      }),
    );
    await saveWorldKeyCache(
      directory,
      mode,
      result.cache,
      selected(work).map((id) => {
        const row = table[id];
        if (!row) throw new Error('Unknown image row');
        return row;
      }),
    );
    await save(`${mode}.rhitape`, captured.tape);
    records.push({
      name: mode,
      rows: windows,
      selected: selected(work),
      markerMaximum,
      failures,
      cache: digests(result.cache),
    });
    expect(Number.isFinite(markerMaximum)).toBe(true);
    expect(markerMaximum).toBeGreaterThan(0.1);
    if (mode === 'old-window') expect(failures.length).toBeGreaterThan(0);
  }, 90000);

it('rejects unprocessed old-world cache and detects a falsely expanded valid window', async () => {
  host.load(warm);
  const current = scheduler();
  current.focus(worldKeyNextFocus);
  const rows = current.windows(),
    table = worldKeyTable(plan, rows),
    work = current.schedule(),
    ids = new Set(selected(work));
  const oldKeys = new Set(oldTable.map((r) => r.key)),
    target = table.find((row) => !oldKeys.has(row.key) && !ids.has(row.slot));
  if (!target) throw new Error('No unprocessed exposed witness');
  const captured = await host.capture(() => integrate('pending-valid', work, rows, 1));
  const receiver: WorldPoint = [target.position[0] - 0.25, target.position[1], target.position[2]];
  const wrongRows = rows.map((row) => ({
    window: row.window,
    min: row.window,
    max: row.window.map((v, a) => v + (plan.dimensions[a] ?? 0)) as unknown as WorldPoint,
  }));
  const query = await host.capture(async () => ({
      correct: await host.sample(rows, receiver),
      wrong: await host.sample(wrongRows, receiver),
    })),
    { correct, wrong } = query.value;
  const previous = oldTable[target.slot];
  if (!previous) throw new Error('Missing recycled old world key');
  await saveWorldKeyCache(directory, 'pending-valid', captured.value.cache, [target]);
  await save('pending-valid.rhitape', captured.tape);
  await save('pending-valid-queries.rhitape', query.tape);
  records.push({
    name: 'wrong-valid-window',
    target,
    previous,
    receiver,
    correct: Array.from(correct),
    wrong: Array.from(wrong),
    rows,
    wrongRows,
  });
  expect(correct[3]).toBe(0);
  expect(wrong[3]).toBe(1);
  const ratio = (wrong[0] ?? Number.NaN) / (wrong[1] ?? Number.NaN);
  expect(Math.abs(ratio - previous.ratio[0])).toBeLessThanOrEqual(worldKeyRatioTolerance);
  expect(Math.abs(ratio - target.ratio[0])).toBeGreaterThan(0.1);
}, 90000);
afterAll(async () => {
  if (host) {
    try {
      expect(digests(warm)).toEqual(initialHashes);
      expect(host.errors).toEqual([]);
      if (directory)
        await writeFile(
          join(directory, 'receipt.json'),
          JSON.stringify(
            {
              adapter: host.adapter,
              plan,
              oldRows,
              oldTable,
              records,
              errors: host.errors,
              scope:
                'Controlled world-key identity/position/cache witness; no world tracing, physical GI, full camera-rotation or whole17 qualification',
            },
            null,
            2,
          ),
        );
    } finally {
      await host.close();
    }
  }
});
