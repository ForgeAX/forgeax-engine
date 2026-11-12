import { appendFileSync } from 'node:fs';
import {
  type BakeExecutor,
  type BakeOptions,
  type BakeResult,
  bakeMaps,
  bakeMapsParallel,
  bakePhases,
  model,
  sel,
  WorkMeter,
} from '@forgeax/engine-modeling';
import { bakeWorkers } from '@forgeax/engine-modeling/tools';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

/**
 * U38 gate: tile rows sampled by Worker threads, in any split and order, assemble to the
 * serial bake byte for byte (the kernel's determinism contract).
 */

function fixture(): BakeOptions {
  const low = model();
  low.box({ size: [0.1, 0.1, 0.1], tag: 'bake:a' });
  low.box({ size: [0.05, 0.05, 0.05], center: [0.1, 0, 0], tag: 'bake:b' });
  low.markSharp(sel.edges.dihedral('>', 40));
  low.uv.auto({ resolution: 128, padding: 4 });
  const high = model();
  const rounded = model();
  rounded.box({ size: [0.1, 0.1, 0.1] });
  rounded.bevel(sel.edges.all(), { width: 0.004, segments: 4 });
  high.append(rounded, { tag: 'bake:a' });
  high.box({ size: [0.05, 0.05, 0.05], center: [0.1, 0, 0], tag: 'bake:b' });
  const hard = { mode: 'autoSmooth', angle: 40 } as const;
  return {
    base: low,
    detail: high,
    maps: ['normal', 'ao', 'curvature', 'height', 'thickness', 'opacity'],
    resolution: 128,
    samples: 4,
    normals: hard,
    detailNormals: { mode: 'weighted' },
    tags: { groupPrefix: 'bake:' },
    ao: { rays: 8 },
    thickness: { rays: 4 },
  };
}

const bytes = (r: BakeResult) =>
  Object.fromEntries(
    Object.entries(r.textures).map(([k, t]) => [
      k,
      Buffer.from((t as TextureAsset).data as Uint8Array).toString('base64'),
    ]),
  );
const facts = (r: BakeResult) => {
  const { work: _, ...metrics } = r.report.metrics;
  return { provenance: r.provenance, metrics, cacheKey: r.report.cacheKey };
};

/** Samples rows in this thread, in a given order and split. */
function inProcess(order: (rows: readonly number[]) => number[][]): BakeExecutor {
  return async (request, rows, { budget }) => {
    const prepared = bakePhases.prepare(request, new WorkMeter(Number.POSITIVE_INFINITY));
    if (!prepared.ok) throw prepared.error;
    const parts = [];
    let work = 0;
    for (const chunk of order(rows)) {
      const meter = new WorkMeter(budget);
      const part = bakePhases.rows(prepared.value, chunk, meter);
      if (!part.ok) throw part.error;
      parts.push(part.value);
      work += meter.units;
    }
    return { ok: true, parts, work };
  };
}

describe('bake Workers: split and order independence (gate)', () => {
  it('4 Workers, reversed rows and uneven chunks all equal the serial bake byte for byte; a dropped row does not (falsifier)', {
    timeout: 300000,
  }, async () => {
    const options = fixture();
    const t0 = performance.now();
    const serial = bakeMaps(options);
    const serialMs = performance.now() - t0;
    if (!serial.ok) throw serial.error;
    const t1 = performance.now();
    const workers = await bakeMapsParallel(options, bakeWorkers({ workers: 4 }));
    const workersMs = performance.now() - t1;
    if (!workers.ok) throw workers.error;
    expect(bytes(workers.value)).toEqual(bytes(serial.value));
    expect(facts(workers.value)).toEqual(facts(serial.value));
    // Audit A12: work counts each tile's own visits, so any split sums to the serial count.
    expect(workers.value.report.metrics.work).toBe(serial.value.report.metrics.work);
    const reversed = await bakeMapsParallel(
      options,
      inProcess((rows) => [...rows].reverse().map((r) => [r])),
    );
    if (!reversed.ok) throw reversed.error;
    expect(bytes(reversed.value)).toEqual(bytes(serial.value));
    const uneven = await bakeMapsParallel(
      options,
      inProcess((rows) => [
        [...rows].filter((r) => r % 3 === 1),
        [...rows].filter((r) => r % 3 !== 1).reverse(),
      ]),
    );
    if (!uneven.ok) throw uneven.error;
    expect(bytes(uneven.value)).toEqual(bytes(serial.value));
    expect(uneven.value.report.metrics.work).toBe(serial.value.report.metrics.work);
    expect(reversed.value.report.metrics.work).toBe(serial.value.report.metrics.work);
    const dropped = await bakeMapsParallel(
      options,
      inProcess((rows) => [rows.slice(1)]),
    );
    if (!dropped.ok) throw dropped.error;
    expect(bytes(dropped.value)).not.toEqual(bytes(serial.value));
    expect(serialMs).toBeGreaterThan(0);
    const log = process.env.FORGEAX_BAKE_TIMING_LOG;
    if (log !== undefined) appendFileSync(log, `${JSON.stringify({ serialMs, workersMs })}\n`);
  });

  it('Worker failures, budgets, cancellation and bad worker counts return structured errors', {
    timeout: 120000,
  }, async () => {
    const options = fixture();
    expect(
      await bakeMapsParallel({ ...options, budget: 1000 }, bakeWorkers({ workers: 2 })),
    ).toMatchObject({
      ok: false,
      error: { code: 'model-work-budget' },
    });
    expect(
      await bakeMapsParallel(
        { ...options, signal: { aborted: true } },
        bakeWorkers({ workers: 2 }),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'model-cancelled' },
    });
    expect(await bakeMapsParallel(options, bakeWorkers({ workers: 0 }))).toMatchObject({
      ok: false,
      error: { code: 'model-invalid-argument' },
    });
    expect(
      await bakeMapsParallel({ ...options, compute: 'native' }, bakeWorkers({ workers: 2 })),
    ).toMatchObject({
      ok: false,
      error: { code: 'model-capability-unavailable' },
    });
  });
});
