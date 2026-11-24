import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  IRRADIANCE_FIELD_ORIGIN_BYTES,
  IRRADIANCE_FIELD_UPDATE_WGSL,
  IrradianceFieldProbeState,
  IrradianceFieldRayStatus,
} from '../../raytracing/irradiance-field';
import {
  checkHistoryState,
  effectiveHistoryHysteresis,
  emptyHistory,
  type HistoryCase,
  type HistorySnapshot,
  historyCases,
  historyFrame,
  historyIncident,
  historyMutation,
  historyProbeIds,
  historyRays,
  historyTolerance,
  maximumHistoryDelta,
  scheduledValues,
} from './irradiance-field-unlit-history.fixture';
import {
  historyRadianceRgb,
  momentConstantAssessment,
  saveHistorySnapshot,
} from './irradiance-field-unlit-history-evidence.fixture';
import { createHistoryHarness } from './irradiance-field-unlit-history-gpu.fixture';

const directory = process.env.FORGEAX_UNLIT_HISTORY_EVIDENCE;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
let host: Awaited<ReturnType<typeof createHistoryHarness>>;
let incident: Float32Array;
let warmEight: HistorySnapshot, warmTwo: HistorySnapshot;
const records: unknown[] = [];
const warmWitnesses: unknown[] = [];
function snapshotDigests(snapshot: HistorySnapshot) {
  return {
    irradiance: sha(new Uint8Array(snapshot.irradiance.buffer)),
    moments: sha(new Uint8Array(snapshot.moments.buffer)),
    meta: sha(new Uint8Array(snapshot.meta.buffer)),
  };
}

async function saveBytes(name: string, bytes: Uint8Array) {
  if (directory) await writeFile(join(directory, name), bytes);
}
async function warm(distance: number) {
  host.load(emptyHistory());
  const captured = await host.capture(() => host.step(historyIncident(directions, distance), 0));
  expect(checkHistoryState(captured.value, 1)).toEqual([]);
  expect(
    scheduledValues(captured.value, 'irradiance')
      .filter((_, index) => index % 4 === 3)
      .every((valid) => valid === 1),
  ).toBe(true);
  const rgb = historyRadianceRgb(captured.value);
  const channels = [0, 1, 2].map((channel) => {
    const values = rgb.filter((_, index) => index % 3 === channel);
    const minimum = Math.min(...values),
      maximum = Math.max(...values);
    expect(minimum).toBeGreaterThan(0.05);
    expect(maximum - minimum).toBeGreaterThan(0.2);
    return { minimum, maximum };
  });
  warmWitnesses.push({ distance, channels });
  await saveBytes(`warm-${distance}.rhitape`, captured.tape);
  await saveHistorySnapshot(directory, `warm-${distance}`, captured.value);
  return captured.value;
}
let directions: Float32Array;
beforeAll(async () => {
  if (directory) await mkdir(directory, { recursive: true });
  host = await createHistoryHarness();
  console.info(
    '[gi-field-history-device]',
    JSON.stringify({
      backendFactory: '@forgeax/engine-rhi-webgpu',
      nodeProvider: process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native' ? 'wgpu-native' : 'dawn-node',
      adapter: {
        vendor: host.adapter?.vendor ?? null,
        architecture: host.adapter?.architecture ?? null,
        device: host.adapter?.device ?? null,
        description: host.adapter?.description ?? null,
      },
    }),
  );
  const audited = await host.capture(() => host.directions());
  directions = audited.value;
  expect(directions.length).toBe(historyProbeIds.length * historyRays * 4);
  for (let ray = 0; ray < directions.length / 4; ray++)
    expect(Math.abs(Math.hypot(...directions.subarray(ray * 4, ray * 4 + 3)) - 1)).toBeLessThan(
      0.000001,
    );
  incident = historyIncident(directions);
  await saveBytes('production-directions.f32', new Uint8Array(directions.buffer));
  await saveBytes('production-directions.rhitape', audited.tape);
  await saveBytes('complete-incident-rays.f32', new Uint8Array(incident.buffer));
  warmEight = await warm(8);
  warmTwo = await warm(2);
}, 90_000);

function initialFor(c: HistoryCase): HistorySnapshot {
  if (c.initial) return emptyHistory(true, c.initial === 'invalid');
  return c.warmDistance === 2 ? warmTwo : warmEight;
}
function compareRadiance(actual: HistorySnapshot, expected: HistorySnapshot, failures: string[]) {
  const error = maximumHistoryDelta(
    scheduledValues(actual, 'irradiance'),
    scheduledValues(expected, 'irradiance'),
  );
  if (!(error <= historyTolerance)) failures.push(`radiance history changed: ${error}`);
  return error;
}
function checkKnownBlack(
  c: HistoryCase,
  actual: HistorySnapshot,
  reference: HistorySnapshot,
  failures: string[],
) {
  const change = maximumHistoryDelta(historyRadianceRgb(actual), historyRadianceRgb(reference));
  if (!(change > 0.01)) failures.push(`known black did not update radiance: ${change}`);
  if (c.mutation === 'black-all') {
    const error = maximumHistoryDelta(
      historyRadianceRgb(actual),
      historyRadianceRgb(reference),
      effectiveHistoryHysteresis(c.hysteresis),
    );
    if (!(error <= historyTolerance)) failures.push(`known black EMA mismatch: ${error}`);
  }
  return change;
}
function checkCold(c: HistoryCase, actual: HistorySnapshot, failures: string[]) {
  if (c.initial === 'fresh-partial') return;
  const maximum = Math.max(...scheduledValues(actual, 'irradiance').map(Math.abs));
  if (maximum !== 0) failures.push(`cold/fresh slot leaked old irradiance: ${maximum}`);
}
function checkConstantDepth(
  actual: HistorySnapshot,
  c: HistoryCase,
  updates: number,
  failures: string[],
) {
  // All current geometric observations have distance8. The weighted means
  // are therefore exactly (8,64), independent of angular exponent or radiance
  // availability. Only this constant-distance domain admits this closed form.
  const initial = c.warmDistance ?? 8;
  const power = effectiveHistoryHysteresis(c.hysteresis) ** updates;
  const error = momentConstantAssessment(
    actual,
    power * initial + (1 - power) * 8,
    power * initial * initial + (1 - power) * 64,
  );
  // Engineering gate max(absolute2e-6, relative2e-6*abs(expected)); division
  // and EMA are not promised to be exact or universally within two ULP.
  if (!(error.normalized <= historyTolerance))
    failures.push(`known-depth moment update mismatch: ${JSON.stringify(error)}`);
  return error;
}
async function runCase(c: HistoryCase) {
  const failures: string[] = [];
  const rays = historyMutation(incident, c.mutation);
  const unknownCount = Array.from({ length: rays.length / 8 }, (_, i) => rays[i * 8 + 7]).filter(
    (status) => status === 4,
  ).length;
  if (c.mutation.startsWith('unknown') && unknownCount === 0)
    failures.push('unknown witness selected no rays');
  const initial = initialFor(c),
    initialSha256 = snapshotDigests(initial);
  await saveHistorySnapshot(directory, `${c.name}-initial`, initial);
  host.load(initial);
  const snapshots: HistorySnapshot[] = [];
  const depthErrors: ReturnType<typeof checkConstantDepth>[] = [];
  const captured = await host.capture(async () => {
    for (let step = 0; step < c.steps; step++) {
      const actual = await host.step(rays, c.hysteresis, c.initial?.startsWith('fresh'), step + 1);
      snapshots.push(actual);
      await saveBytes(`${c.name}-step-${step}-frame.bin`, historyFrame(c.hysteresis, step + 1));
      const first = c.initial ? 0 : 1;
      failures.push(...checkHistoryState(actual, first + step + 1));
      depthErrors.push(checkConstantDepth(actual, c, step + 1, failures));
      await saveHistorySnapshot(directory, `${c.name}-step-${step}`, actual, initial);
    }
    if (!c.initial && c.mutation.startsWith('unknown')) {
      const recovery = await host.step(incident, c.hysteresis, false, c.steps + 1);
      await saveBytes(
        `${c.name}-complete-recovery-frame.bin`,
        historyFrame(c.hysteresis, c.steps + 1),
      );
      failures.push(...checkHistoryState(recovery, c.steps + 2));
      depthErrors.push(checkConstantDepth(recovery, c, c.steps + 1, failures));
      compareRadiance(recovery, c.warmDistance === 2 ? warmTwo : warmEight, failures);
      await saveHistorySnapshot(directory, `${c.name}-complete-recovery`, recovery, initial);
    }
    return snapshots[snapshots.length - 1];
  });
  const actual = captured.value;
  if (!actual) throw new Error('History scenario produced no output');
  let maximumHistoryDifference = 0;
  if (c.initial) checkCold(c, actual, failures);
  else if (c.mutation.startsWith('black'))
    maximumHistoryDifference = checkKnownBlack(c, actual, warmEight, failures);
  else
    for (const snapshot of snapshots)
      maximumHistoryDifference = Math.max(
        maximumHistoryDifference,
        compareRadiance(snapshot, c.warmDistance === 2 ? warmTwo : warmEight, failures),
      );
  if (c.initial === 'fresh-partial') {
    host.load(emptyHistory());
    const reference = await host.step(rays, c.hysteresis, true, 1);
    await saveHistorySnapshot(directory, 'fresh-partial-zero-reference', reference);
    if (
      maximumHistoryDelta(
        scheduledValues(actual, 'moments'),
        scheduledValues(reference, 'moments'),
      ) > historyTolerance
    )
      failures.push('fresh moments depend on recycled slot');
    compareRadiance(actual, reference, failures);
  }
  await saveBytes(`${c.name}.rhitape`, captured.tape);
  await saveBytes(`${c.name}-rays.f32`, new Uint8Array(rays.buffer));
  await saveBytes(`${c.name}-frame.bin`, historyFrame(c.hysteresis, 1));
  if (JSON.stringify(snapshotDigests(initial)) !== JSON.stringify(initialSha256))
    failures.push('initial cache was mutated by a scenario');
  records.push({
    ...c,
    unknownCount,
    effectiveHysteresis: effectiveHistoryHysteresis(c.hysteresis),
    frameIndices: Array.from({ length: c.steps }, (_, step) => step + 1),
    maximumHistoryDifference,
    initialSha256,
    depthErrors,
    failures,
    raysSha256: sha(new Uint8Array(rays.buffer)),
    tapeSha256: sha(captured.tape),
  });
  return failures;
}
for (const c of historyCases)
  it(`preserves unavailable radiance separately from geometric depth: ${c.name}`, async () => {
    expect(await runCase(c)).toEqual([]);
  }, 90_000);

it('keeps far transport backfaces separate from probe placement', async () => {
  const backfaces = (distance: number) => {
    const rays = historyIncident(directions, distance);
    for (let probe = 0; probe < historyProbeIds.length; probe++)
      for (let ray = 0; ray < historyRays / 2; ray++)
        rays[(probe * historyRays + ray) * 8 + 7] = IrradianceFieldRayStatus.backface;
    return rays;
  };
  host.load(emptyHistory());
  const near = await host.step(backfaces(1), 0);
  for (const probe of historyProbeIds)
    expect(near.meta[probe * 4 + 1]).toBe(IrradianceFieldProbeState.relocated);

  const far = await createHistoryHarness(IRRADIANCE_FIELD_UPDATE_WGSL, true);
  try {
    const rays = backfaces(8);
    for (let update = 1; update <= 2; update++) {
      const state = await far.step(rays, 0, false, update);
      for (const probe of historyProbeIds) {
        expect([...state.meta.subarray(probe * 4, probe * 4 + 4)]).toEqual([
          update,
          IrradianceFieldProbeState.active,
          0,
          0,
        ]);
      }
    }
    expect(far.errors).toEqual([]);
  } finally {
    await far.close();
  }
}, 30_000);

it('restarts displaced far history at the radiance-cache lattice', async () => {
  const displaced = emptyHistory(true);
  // Packed half-float 0.25 in x. This old origin was one metre off the 4m lattice.
  for (const probe of historyProbeIds) displaced.meta[probe * 4 + 2] = 0x3400;
  const far = await createHistoryHarness(IRRADIANCE_FIELD_UPDATE_WGSL, true);
  try {
    const assertPlacement = async (
      field: Awaited<ReturnType<typeof createHistoryHarness>>,
      xOffset: number,
      updates: number,
    ) => {
      const origins = await field.place();
      const view = new DataView(origins.buffer, origins.byteOffset, origins.byteLength);
      for (const [slot, probe] of historyProbeIds.entries()) {
        const offset = slot * IRRADIANCE_FIELD_ORIGIN_BYTES;
        expect.soft(view.getFloat32(offset, true)).toBe(probe * 4 + xOffset);
        expect.soft(view.getUint32(offset + 12, true)).toBe(probe);
        expect.soft(view.getUint32(offset + 16, true)).toBe(updates);
      }
    };
    host.load(displaced);
    await assertPlacement(host, 1, 19);
    far.load(emptyHistory());
    const fresh = await far.step(incident, 0.75);
    far.load(displaced);
    await assertPlacement(far, 0, 0);
    const recovered = await far.step(incident, 0.75);
    expect(recovered.meta).toEqual(fresh.meta);
    expect(recovered.irradiance).toEqual(fresh.irradiance);
    expect(recovered.moments).toEqual(fresh.moments);
    expect(far.errors).toEqual([]);
  } finally {
    await far.close();
  }
}, 30_000);

afterAll(async () => {
  if (!host) return;
  try {
    await saveBytes(
      'assessment.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            adapter: host.adapter,
            records,
            warmWitnesses,
            errors: host.errors,
            producerSha256: sha(IRRADIANCE_FIELD_UPDATE_WGSL),
            fixtureSha256: sha(
              await readFile(
                new URL('./irradiance-field-unlit-history.fixture.ts', import.meta.url),
              ),
            ),
            imageMeaning:
              'Probe cache / distance-moment / validity data only. Rows are scheduled probes. Columns: named reference (case initial for steps), actual, 5x absolute difference. Warm/initial captures self-reference. Not a final render.',
            imageDisplay: {
              cacheRgbDivisor: 2.5,
              momentMeanDivisor: 12,
              momentSecondDivisor: 144,
              validityDivisor: 1,
              differenceGain: 5,
            },
            limits: [
              'Fixed recorded production directions; not a changing-sample physical GI proof',
              'No backface/skip reinterpretation',
              'No World trace, HW/SW path or final-scene qualification',
              'Cold partial cases prove no old-slot leakage, not unbiased or complete irradiance',
              'No performance or UI measurement',
            ],
          },
          null,
          2,
        ),
      ),
    );
    expect(host.errors).toEqual([]);
  } finally {
    await host.close();
  }
});
