import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { IrradianceFieldLevelWindow } from '../../raytracing/irradiance-field';
import {
  PROBE_ENTRY_INDEX,
  ProbeClipmapScheduler,
  type ProbeFrameSchedule,
} from '../../raytracing/probe-clipmap';
import {
  unselectedWorldCacheEqual,
  type WorldKeyCache,
  type WorldPoint,
  worldKeyRatioTolerance,
  worldKeyTable,
} from './probe-clipmap-world-key.fixture';
import { markerError, saveWorldKeyCache } from './probe-clipmap-world-key-evidence.fixture';
import { createWorldKeyHarness } from './probe-clipmap-world-key-gpu.fixture';
import {
  negativeKeyFocus,
  negativeKeyNextFocus,
  negativeKeyPlan,
  negativeRemainderWitness,
  rawRemainderQueryOwner,
} from './probe-clipmap-world-key-negative.fixture';

const root = process.env.FORGEAX_CLIPMAP_WORLDKEY_EVIDENCE,
  directory = root ? join(root, 'negative') : undefined,
  plan = negativeKeyPlan();
let host: Awaited<ReturnType<typeof createWorldKeyHarness>>,
  wrong: Awaited<ReturnType<typeof createWorldKeyHarness>> | undefined,
  warm: WorldKeyCache,
  complete: WorldKeyCache | undefined;
let windows: readonly IrradianceFieldLevelWindow[];
const records: unknown[] = [];
async function save(name: string, bytes: ArrayBufferView) {
  if (directory)
    await writeFile(
      join(directory, name),
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
}
async function step(
  name: string,
  work: ProbeFrameSchedule,
  rows: readonly IrradianceFieldLevelWindow[],
  index: number,
) {
  const entries = work.list.subarray(0, work.count),
    placed = await host.place(entries, rows, index),
    result = await host.integrate(placed.placed, placed.directions);
  await save(`${name}-list.u32`, entries);
  await save(`${name}-origins.bin`, placed.origins);
  await save(`${name}-directions.f32`, placed.directions);
  await save(`${name}-rays.f32`, result.rays);
  await save(`${name}-frame.bin`, placed.frameBytes);
  await save(`${name}-field.bin`, placed.fieldBytes);
  return { ...result, placed: placed.placed };
}
beforeAll(async () => {
  if (directory) await mkdir(directory, { recursive: true });
  host = await createWorldKeyHarness(plan);
  const current = new ProbeClipmapScheduler(plan, negativeKeyFocus);
  expect(current.windows().map((row) => row.window)).toEqual([[-3, 30, 30]]);
  const rows = worldKeyTable(plan, current.windows()),
    capture = await host.capture(() => step('warm', current.schedule(), current.windows(), 0));
  warm = capture.value.cache;
  await save('warm.rhitape', capture.tape);
  await saveWorldKeyCache(directory, 'warm', warm, rows);
  for (const row of rows)
    expect(markerError(warm, row)).toBeLessThanOrEqual(worldKeyRatioTolerance);
}, 90000);

it('retains physical negative world keys across cell zero in four accepted chunks', async () => {
  host.load(warm);
  const current = new ProbeClipmapScheduler(plan, negativeKeyFocus),
    old = worldKeyTable(plan, current.windows()),
    oldKeys = new Set(old.map((row) => row.key));
  current.commit(current.schedule());
  current.limit = 4;
  expect(current.focus(negativeKeyNextFocus)).toBe(16);
  expect(current.windows().map((row) => row.window)).toEqual([[-4, 30, 30]]);
  const rows = worldKeyTable(plan, current.windows()),
    fresh = rows.filter((row) => !oldKeys.has(row.key)),
    seen = new Set<string>(),
    failures: string[] = [],
    steps: unknown[] = [];
  for (let frame = 1; frame <= 4; frame++) {
    const work = current.schedule(),
      before = await host.snapshot(),
      capture = await host.capture(() => step(`frame${frame}`, work, current.windows(), frame)),
      result = capture.value,
      ids = Array.from(work.list.subarray(0, work.count), (entry) => entry & PROBE_ENTRY_INDEX);
    for (const [index, slot] of ids.entries()) {
      const row = rows[slot],
        placed = result.placed[index];
      if (!row || !placed) throw new Error('Missing negative work row');
      if (seen.has(row.key) || row.cell[0] !== -4)
        failures.push('Duplicate or wrong negative exposed key');
      seen.add(row.key);
      if (placed.probe !== slot || placed.position.some((v, a) => v !== row.position[a]))
        failures.push(`Wrong negative physical position ${row.key}`);
      if (markerError(result.cache, row) > worldKeyRatioTolerance)
        failures.push(`Wrong negative marker ${row.key}`);
      if (result.cache.meta[slot * 4] !== 1 || result.cache.meta[slot * 4 + 1] !== 1)
        failures.push(`Stale negative history ${row.key}`);
    }
    if (!unselectedWorldCacheEqual(before, result.cache, new Set(ids), plan.probeCount))
      failures.push('Unselected canonical cache changed');
    await saveWorldKeyCache(
      directory,
      `frame${frame}`,
      result.cache,
      ids.map((slot) => {
        const row = rows[slot];
        if (!row) throw new Error('Missing image key');
        return row;
      }),
    );
    await save(`frame${frame}.rhitape`, capture.tape);
    steps.push({
      frame,
      ids,
      keys: ids.map((slot) => rows[slot]?.key),
      windows: current.windows(),
    });
    current.commit(work);
    complete = result.cache;
  }
  windows = current.windows();
  expect(seen).toEqual(new Set(fresh.map((row) => row.key)));
  expect(current.inspect().pendingExposedProbes).toBe(0);
  records.push({ name: 'negative-cross-zero', old, rows, steps, failures });
  expect(failures).toEqual([]);
}, 90000);

it('detects a raw signed-remainder sampler fault against identical completed cache resources', async () => {
  if (!complete) throw new Error('Negative completed cache unavailable');
  const witness = negativeRemainderWitness();
  expect(witness.expectedSlot).not.toBe(witness.wrongSlot);
  const table = worldKeyTable(plan, windows),
    target = table[witness.expectedSlot];
  if (!target) throw new Error('Missing exact negative remainder witness');
  expect(target.cell[0]).toBe(-4);
  const receiver: WorldPoint = [target.position[0] - 0.25, target.position[1], target.position[2]];
  host.load(complete);
  const mutantHost = await createWorldKeyHarness(plan, rawRemainderQueryOwner);
  wrong = mutantHost;
  mutantHost.load(complete);
  const positive = await host.capture(() => host.sample(windows, receiver)),
    negative = await mutantHost.capture(() => mutantHost.sample(windows, receiver));
  const actual = positive.value,
    mutant = negative.value;
  if (!mutant) throw new Error('Negative query unavailable');
  await save('query-production.rhitape', positive.tape);
  await save('query-raw-remainder.rhitape', negative.tape);
  const expected = target.ratio,
    ratio = (value: Float32Array) => [
      (value[0] ?? Number.NaN) / (value[1] ?? Number.NaN),
      (value[2] ?? Number.NaN) / (value[1] ?? Number.NaN),
    ];
  const correctRatio = ratio(actual),
    wrongRatio = ratio(mutant),
    error = Math.max(...wrongRatio.map((v, a) => Math.abs(v - (expected[a] ?? Number.NaN))));
  records.push({
    name: 'raw-signed-remainder',
    witness,
    target,
    wrongKey: table[witness.wrongSlot],
    receiver,
    actual: Array.from(actual),
    mutant: Array.from(mutant),
    correctRatio,
    wrongRatio,
    error,
  });
  expect(actual[3]).toBe(1);
  expect(
    correctRatio.every(
      (v, a) => Math.abs(v - (expected[a] ?? Number.NaN)) <= worldKeyRatioTolerance,
    ),
  ).toBe(true);
  expect(mutant[3] !== 1 || error > worldKeyRatioTolerance).toBe(true);
  expect(
    unselectedWorldCacheEqual(complete, await host.snapshot(), new Set(), plan.probeCount),
  ).toBe(true);
  expect(
    unselectedWorldCacheEqual(complete, await wrong.snapshot(), new Set(), plan.probeCount),
  ).toBe(true);
}, 90000);

afterAll(async () => {
  try {
    if (host) expect(host.errors).toEqual([]);
    if (wrong) expect(wrong.errors).toEqual([]);
    if (directory)
      await writeFile(
        join(directory, 'receipt.json'),
        JSON.stringify(
          {
            adapter: host?.adapter,
            mutantAdapter: wrong?.adapter,
            plan,
            records,
            scope:
              'Controlled true-negative clipmap position/cache and public sampler remainder; no World/SDF tracing or whole17 qualification',
          },
          null,
          2,
        ),
      );
  } finally {
    if (wrong) await wrong.close();
    if (host) await host.close();
  }
});
