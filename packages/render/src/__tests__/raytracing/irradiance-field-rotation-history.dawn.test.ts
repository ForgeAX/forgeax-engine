import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { IRRADIANCE_FIELD_UPDATE_WGSL } from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import {
  checkHistoryState,
  emptyHistory,
  type HistorySnapshot,
  historyIncident,
  historyProbeIds,
  historyRays,
  historyTolerance,
  wrongGainHistorySource,
} from './irradiance-field-unlit-history.fixture';
import {
  historyRadianceRgb,
  momentConstantAssessment,
  saveAngularHistorySnapshot,
  saveHistorySnapshot,
} from './irradiance-field-unlit-history-evidence.fixture';
import { createHistoryHarness } from './irradiance-field-unlit-history-gpu.fixture';

// Isolates the real update/derive operators. No World trace, Card scheduler or final image claim.
const directory = process.env.FORGEAX_FIELD_ROTATION_EVIDENCE;
const diagnostic = process.env.FORGEAX_FIELD_ROTATION_DIAGNOSTICS === '1' ? it : it.skip;
const color = [0.25, 0.5, 0.125] as const;
const stride = historyProbeIds.length * historyRays * 4;
const records: unknown[] = [];
let host: Awaited<ReturnType<typeof createHistoryHarness>>;
let directions: Float32Array;

function constantReference(): HistorySnapshot {
  const state = emptyHistory();
  for (const probe of historyProbeIds) {
    for (let texel = 0; texel < IRRADIANCE_FIELD_PROBE_STRIDE; texel++)
      state.irradiance.set([...color, 1], (probe * IRRADIANCE_FIELD_PROBE_STRIDE + texel) * 4);
    for (let texel = 0; texel < 64; texel++) state.moments.set([8, 64], (probe * 64 + texel) * 2);
  }
  return state;
}
const reference = constantReference();

function incident(update: number) {
  const rays = historyIncident(directions.subarray(update * stride, (update + 1) * stride));
  for (let ray = 0; ray < rays.length / 8; ray++) rays.set(color, ray * 8);
  return rays;
}
function signal(snapshot: HistorySnapshot) {
  const rgb = historyRadianceRgb(snapshot);
  const means = [0, 0, 0];
  let maximumError = 0;
  for (const [index, value] of rgb.entries()) {
    expect(Number.isFinite(value)).toBe(true);
    maximumError = Math.max(maximumError, Math.abs(value - (color[index % 3] ?? NaN)));
    means[index % 3] = (means[index % 3] ?? 0) + value / (rgb.length / 3);
  }
  return { rgb, means, maximumError };
}
async function saveRaw(name: string, snapshot: HistorySnapshot) {
  if (!directory) return;
  for (const key of ['irradiance', 'moments', 'meta'] as const)
    await writeFile(
      join(directory, `${name}-${key}.${key === 'meta' ? 'u32' : 'f32'}`),
      new Uint8Array(snapshot[key].buffer),
    );
}
async function savePictures(name: string, snapshot: HistorySnapshot) {
  await saveHistorySnapshot(directory, name, snapshot, reference);
  await saveAngularHistorySnapshot(directory, name, snapshot, reference);
}
beforeAll(async () => {
  if (directory) await mkdir(directory, { recursive: true });
  host = await createHistoryHarness();
  directions = await host.directions(256);
  expect(directions.length).toBe(256 * stride);
  if (directory)
    await writeFile(
      join(directory, 'production-directions.f32'),
      new Uint8Array(directions.buffer),
    );
}, 90_000);

for (const hysteresis of [0, 0.5, 0.9, 0.99])
  diagnostic(
    `preserves a constant spherical signal through 256 production direction rotations: h=${hysteresis}`,
    async () => {
      host.load(emptyHistory());
      let maximumError = 0;
      for (let update = 0; update < 256; update++) {
        const name = `h${hysteresis}-u${String(update).padStart(3, '0')}`;
        const snapshot = await host.step(incident(update), hysteresis, false, update);
        await saveRaw(name, snapshot);
        if (update === 0 || update === 255) await savePictures(name, snapshot);
        const measured = signal(snapshot);
        maximumError = Math.max(maximumError, measured.maximumError);
        expect(checkHistoryState(snapshot, update + 1)).toEqual([]);
        expect(momentConstantAssessment(snapshot, 8, 64).normalized).toBeLessThanOrEqual(
          historyTolerance,
        );
        expect(measured.maximumError).toBeLessThanOrEqual(historyTolerance);
      }
      records.push({ hysteresis, completedUpdates: 256, maximumError });
    },
    120_000,
  );

diagnostic(
  'detects a period-two wrong-gain shader while its per-frame global mean stays correct',
  async () => {
    const mutant = wrongGainHistorySource();
    const negative = await createHistoryHarness(mutant);
    const snapshots: Float32Array[] = [];
    try {
      negative.load(emptyHistory());
      for (let update = 0; update < 4; update++) {
        const snapshot = await negative.step(incident(update), 0, false, update);
        await saveRaw(`negative-u${update}`, snapshot);
        await savePictures(`negative-u${update}`, snapshot);
        const measured = signal(snapshot);
        measured.means.forEach((mean, channel) => {
          expect(Math.abs(mean - (color[channel] ?? NaN))).toBeLessThanOrEqual(historyTolerance);
        });
        expect(measured.maximumError).toBeGreaterThan(0.2);
        snapshots.push(measured.rgb);
      }
      const first = snapshots[0],
        next = snapshots[1];
      expect(first && next).toBeTruthy();
      const periodTwo = Math.max(
        ...Array.from(first ?? [], (value, index) => Math.abs(value - (next?.[index] ?? NaN))),
      );
      expect(periodTwo).toBeGreaterThan(0.4);
      expect(negative.errors).toEqual([]);
      records.push({
        negativeControl: 'wrong-gain-same-mean',
        updates: 4,
        periodTwo,
        shaderSHA256: createHash('sha256').update(mutant).digest('hex'),
      });
    } finally {
      await negative.close();
    }
  },
  90_000,
);

afterAll(async () => {
  try {
    if (directory)
      await writeFile(
        join(directory, 'assessment.json'),
        JSON.stringify(
          {
            scope:
              'Actual update/derive and changing production directions only; no final-scene, World, Card scheduling or performance qualification',
            adapter: host?.adapter,
            producerSHA256: createHash('sha256').update(IRRADIANCE_FIELD_UPDATE_WGSL).digest('hex'),
            directionsSHA256:
              directions &&
              createHash('sha256').update(new Uint8Array(directions.buffer)).digest('hex'),
            records,
            errors: host?.errors,
          },
          null,
          2,
        ),
      );
    if (host) expect(host.errors).toEqual([]);
  } finally {
    await host?.close();
  }
});
