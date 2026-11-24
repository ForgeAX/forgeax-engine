import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodePng } from '../../../../image/src/png-encoder';
import {
  authoredBox,
  geometryRays,
  type Point,
  placementFailures,
  relocationNormalizedTolerance,
  relocationProbe,
  relocationScales,
  sub,
} from './irradiance-field-relocation-scale.fixture';
import {
  createRelocationHarness,
  type RelocationSnapshot,
} from './irradiance-field-relocation-scale-gpu.fixture';

const directory = process.env.FORGEAX_RELOCATION_EVIDENCE;
let host: Awaited<ReturnType<typeof createRelocationHarness>>, directions: Float32Array;
const records: unknown[] = [],
  reference = new Map<boolean, number[]>();
const hash = (value: string | ArrayBufferView) =>
  createHash('sha256')
    .update(
      typeof value === 'string'
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    )
    .digest('hex');
const save = async (name: string, bytes: Uint8Array) => {
  if (directory) await writeFile(join(directory, name), bytes);
};
beforeAll(async () => {
  if (directory) await mkdir(directory, { recursive: true });
  host = await createRelocationHarness();
  for (const stage of ['updateProbes', 'deriveProbes', 'placeProbes'] as const)
    await save(`${stage}-producer.wgsl`, new TextEncoder().encode(host.source[stage]));
  const audited = await host.capture(() => host.directions());
  directions = audited.value;
  expect(directions.length).toBe(1024);
  for (let r = 0; r < 256; r++)
    expect(Math.abs(Math.hypot(...directions.subarray(r * 4, r * 4 + 3)) - 1)).toBeLessThan(1e-6);
  await save('actual-probe21-direction-ordinal0.f32', new Uint8Array(directions.buffer));
  await save('directions.rhitape', audited.tape);
}, 90000);
async function saveSnapshot(name: string, s: RelocationSnapshot) {
  for (const key of ['irradiance', 'moments', 'meta', 'origins'] as const)
    await save(`${name}-${key}.bin`, new Uint8Array(s[key].buffer));
}
/** XY cross-section: authored walls and actual GPU placed origins; not a final rendered scene. */
function placementPng(points: readonly Point[], scale: number, lattice: Point) {
  const size = 384,
    rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([20, 24, 30, 255], i);
  const pixel = (x: number, y: number, color: number[]) => {
    if (x >= 0 && y >= 0 && x < size && y < size) rgba.set([...color, 255], (y * size + x) * 4);
  };
  const coord = (v: number) => Math.round(size / 2 + v * 70);
  for (let y = 0; y < size; y++)
    for (const wall of [-0.8, 0.8]) pixel(coord(wall), y, [95, 110, 130]);
  for (const [step, p] of points.entries()) {
    const q = sub(p, lattice).map((v) => v / scale);
    if (!q.every(Number.isFinite)) {
      for (let d = -12; d <= 12; d++) {
        pixel(size - 25 + d, 25 + d, [255, 40, 50]);
        pixel(size - 25 + d, 25 - d, [255, 40, 50]);
      }
      continue;
    }
    const x = coord(q[0] ?? Number.NaN),
      y = coord(-(q[1] ?? Number.NaN));
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++)
        if (dx * dx + dy * dy <= 16)
          pixel(x + dx, y + dy, step === 0 ? [255, 210, 50] : [40, 220, 150]);
  }
  return encodePng(size, size, rgba);
}
function checkFirstMovement(
  scale: number,
  mirror: boolean,
  state: number | undefined,
  updates: number | undefined,
  assessment: ReturnType<typeof placementFailures>,
  failures: string[],
) {
  if (scale === 1) {
    reference.set(mirror, assessment.offset);
    if (!(Math.max(...assessment.offset.map(Math.abs)) > 0.1))
      failures.push('degenerate witness: no actual relocation');
  }
  const baseline = reference.get(mirror);
  if (!baseline) throw new Error('Missing ordinary-scale GPU reference');
  const error = Math.max(
    ...assessment.offset.map((v, a) => Math.abs(v - (baseline[a] ?? Number.NaN))),
  );
  // Fixed before GPU: engineering allowance covers ordinary half quantization
  // plus the subnormal half step at the smallest admitted scale. It is not a
  // universal WGSL worst-case bound or a physical GI tolerance.
  if (!(error <= relocationNormalizedTolerance))
    failures.push(`scale-normalized displacement differs from ordinary GPU placement: ${error}`);
  if (scale >= 65536 && !(Math.max(...baseline.map(Math.abs)) * scale > 65504))
    failures.push('degenerate witness: requested offset does not cross half finite range');
  if (state !== 3 || updates !== 0)
    failures.push(`first geometric escape must restart: state=${state} updates=${updates}`);
}
for (const mirror of [false, true])
  for (const scale of relocationScales)
    it(`closed authored box relocation mirror=${mirror} scale=${scale}`, async () => {
      const name = `mirror-${mirror}-scale-${scale}`,
        failures: string[] = [],
        lattice: Point = [5 * scale, 5 * scale, 5 * scale],
        steps: unknown[] = [],
        points: Point[] = [];
      const initial = await host.reset(scale);
      points.push(initial.point);
      await saveSnapshot(`${name}-initial`, initial);
      expect(initial.point).toEqual(lattice);
      for (let step = 0; step < 2; step++) {
        const previous = points.at(-1);
        if (!previous) throw new Error('Missing previous placed origin');
        if (!previous.every(Number.isFinite)) {
          failures.push(`step${step + 1} cannot trace from non-finite origin`);
          break;
        }
        const normalized = sub(previous, lattice).map((v) => v / scale) as unknown as Point;
        const input = geometryRays(directions, normalized, scale, mirror);
        if (step === 0) expect(input.backs).toBe(256);
        await save(`${name}-step${step + 1}-rays.f32`, new Uint8Array(input.rays.buffer));
        const captured = await host.capture(() => host.step(input.rays, scale, step));
        const s = captured.value;
        points.push(s.point);
        await saveSnapshot(`${name}-step${step + 1}`, s);
        await save(`${name}-step${step + 1}.rhitape`, captured.tape);
        const assessment = placementFailures(s.point, s.meta, scale, lattice);
        failures.push(...assessment.failures.map((f) => `step${step + 1}: ${f}`));
        for (const plane of ['irradiance', 'moments'] as const)
          if (!s[plane].every(Number.isFinite))
            failures.push(`step${step + 1}: ${plane} is non-finite`);
        const state = s.meta[relocationProbe * 4 + 1],
          updates = s.meta[relocationProbe * 4];
        if (step === 0) checkFirstMovement(scale, mirror, state, updates, assessment, failures);
        else if (state !== 1 || updates !== 1)
          failures.push(
            `outside retrace must activate fresh history: state=${state} updates=${updates}`,
          );
        steps.push({
          step: step + 1,
          backs: input.backs,
          point: s.point,
          ...assessment,
          state,
          updates,
          metaSha: hash(s.meta),
          raySha: hash(input.rays),
        });
      }
      await save(`${name}-placement-xy.png`, placementPng(points, scale, lattice));
      const record = {
        name,
        scale,
        mirror,
        triangleSha: hash(JSON.stringify(authoredBox(mirror))),
        steps,
        failures,
      };
      records.push(record);
      if (directory)
        await writeFile(join(directory, `${name}.json`), JSON.stringify(record, null, 2));
      expect(failures, JSON.stringify(record)).toEqual([]);
    }, 90000);
it('detects an injected wrong-normal classification on the actual GPU', async () => {
  const scale = 1,
    lattice: Point = [5, 5, 5];
  await host.reset(scale);
  const input = geometryRays(directions, [0, 0, 0], scale, false, true);
  expect(input.backs).toBe(0);
  const captured = await host.capture(() => host.step(input.rays, scale, 0)),
    s = captured.value;
  const assessment = placementFailures(s.point, s.meta, scale, lattice);
  await saveSnapshot('negative-wrong-normal', s);
  await save('negative-wrong-normal.rhitape', captured.tape);
  await save('negative-wrong-normal-rays.f32', new Uint8Array(input.rays.buffer));
  await save(
    'negative-wrong-normal-placement-xy.png',
    placementPng([lattice, s.point], scale, lattice),
  );
  const record = {
    name: 'negative-wrong-normal',
    expectedFailure: 'active probe remains inside authored solid',
    ...assessment,
  };
  records.push(record);
  expect(assessment.failures).toContain('active probe remains inside authored solid');
}, 90000);
afterAll(async () => {
  if (host) {
    try {
      if (directory)
        await writeFile(
          join(directory, 'receipt.json'),
          JSON.stringify(
            {
              adapter: host.adapter,
              source: Object.fromEntries(Object.entries(host.source).map(([k, v]) => [k, hash(v)])),
              errors: host.errors,
              records,
              scope:
                'Controlled actual UPDATE/DERIVE/PLACE; authored full triangle input; no world trace/Card/material/GI or timing qualification',
            },
            null,
            2,
          ),
        );
      expect(host.errors).toEqual([]);
    } finally {
      await host.close();
    }
  }
});
