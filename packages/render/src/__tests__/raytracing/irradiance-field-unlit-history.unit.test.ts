import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { IRRADIANCE_FIELD_UPDATE_WGSL } from '../../raytracing/irradiance-field';
import {
  effectiveHistoryHysteresis,
  emptyHistory,
  historyIncident,
  historyMutation,
  historyProbeIds,
  historyRays,
  wrongGainHistorySource,
} from './irradiance-field-unlit-history.fixture';
import { momentConstantAssessment } from './irradiance-field-unlit-history-evidence.fixture';

it('compiles the actual update source and its exact-store wrong-gain control with the same bindings', async () => {
  const programs = [];
  for (const source of [IRRADIANCE_FIELD_UPDATE_WGSL, wrongGainHistorySource()]) {
    const compiled = (
      await compileShader(source, { id: 'field-history-rotation-control' })
    ).unwrap();
    const entry = compiled.manifestEntry.entryPoints?.find((item) => item.name === 'updateProbes');
    expect(entry).toBeDefined();
    programs.push(entry?.bindings);
  }
  expect(programs[0]).toEqual(programs[1]);
}, 60_000);

it('changes only unknown status while preserving affine RGB, directions and known geometric distance', () => {
  // This is a source-side mutation control, not a production direction/GPU proof.
  const directions = new Float32Array(historyProbeIds.length * historyRays * 4);
  for (let i = 0; i < directions.length / 4; i++)
    directions.set(i % 2 ? [1, 0, 0, 1] : [-1, 0, 0, 1], i * 4);
  const incident = historyIncident(directions);
  const changed = historyMutation(incident, 'unknown-x');
  let unknown = 0;
  for (let i = 0; i < changed.length / 8; i++) {
    expect(changed.subarray(i * 8, i * 8 + 7)).toEqual(incident.subarray(i * 8, i * 8 + 7));
    if (changed[i * 8 + 7] === 4) unknown++;
  }
  expect(unknown).toBe((historyProbeIds.length * historyRays) / 2);
  expect(historyMutation(incident, 'stable')).toEqual(incident);
});
it('uses a dimension-aware f32 moment gate and rejects stale or wrongly scaled geometry', () => {
  const snapshot = emptyHistory();
  const set = (mean: number, second: number) => {
    for (const probe of historyProbeIds)
      for (let texel = 0; texel < 64; texel++)
        snapshot.moments.set([mean, second], (probe * 64 + texel) * 2);
  };
  // A concrete one-ULP example, not a universal WGSL two-ULP guarantee.
  set(8, 64.00000762939453);
  expect(momentConstantAssessment(snapshot, 8, 64).normalized).toBeLessThanOrEqual(0.000002);
  set(8.008, 64.064);
  expect(momentConstantAssessment(snapshot, 8, 64).normalized).toBeGreaterThan(0.000002);
  set(2, 4);
  expect(momentConstantAssessment(snapshot, 5, 34).normalized).toBeGreaterThan(0.000002);
});
it('keeps real black observations distinct from unavailable radiance and reads the packed f32 hysteresis', () => {
  const directions = new Float32Array(historyProbeIds.length * historyRays * 4);
  const black = historyMutation(historyIncident(directions), 'black-all');
  for (let i = 0; i < black.length / 8; i++) {
    expect(Array.from(black.subarray(i * 8, i * 8 + 3))).toEqual([0, 0, 0]);
    expect(black[i * 8 + 3]).toBe(8);
    expect(black[i * 8 + 7]).toBe(1);
  }
  expect(effectiveHistoryHysteresis(0.5)).toBe(0.5);
  expect(effectiveHistoryHysteresis(0.97)).toBe(Math.fround(0.97));
});
