import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/compile';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import { screenProbeReceiverWgsl } from '../../raytracing/screen-probe-receiver';
import {
  hardwareSourceEligibility,
  softwareReceiverEligibility,
} from './screen-probe-support-domain.fixture';
import { rasterReceiverCases, rasterReceiverPrograms } from './screen-raster-receiver.fixture';

it('compiles the actual local receiver and full World while retaining the storage limit', async () => {
  for (const [name, code] of [
    ['prepare', screenProbeReceiverWgsl()],
    ['world', screenProbeWorldWgsl('global-sdf')],
  ] as const) {
    const actual = (await compileShader(code, { id: `raster-local-receiver-${name}` })).unwrap();
    const storage = actual.bindings
      .flatMap((group) => group.entries)
      .filter((entry) => entry.buffer && entry.buffer.type !== 'uniform' && entry.visibility !== 0);
    expect(storage.length).toBeLessThanOrEqual(8);
    expect(actual.reflection.entryPoints?.length).toBeGreaterThan(0);
  }
  expect(hardwareSourceEligibility(24)).toBe(true);
  expect(hardwareSourceEligibility(8)).toBe(false);
});

it('keeps local raster tokens within current software reconstruction and their actual frame', () => {
  for (const kind of [2, 3]) {
    expect(softwareReceiverEligibility(kind, 8)).toBe(true);
    for (const flags of [0, 7, 16, 24, 32])
      expect(softwareReceiverEligibility(kind, flags)).toBe(false);
    expect(softwareReceiverEligibility(kind, 8, 10)).toBe(false);
  }
  for (const kind of [0, 4, 0xffffffff]) expect(softwareReceiverEligibility(kind, 8)).toBe(false);
  expect(softwareReceiverEligibility(1, 8)).toBe(true);
});

it('prepares the actual raster alpha gate and fixed one-sided/unknown numerical controls', async () => {
  const programs = await rasterReceiverPrograms();
  expect(programs.raster.reflection.entryPoints?.map((p) => p.name)).toEqual(
    expect.arrayContaining(['receiverVertex', 'receiverFragment']),
  );
  const cases = await rasterReceiverCases();
  expect(cases).toHaveLength(13);
  for (const row of cases) {
    const bytes = row.row.composition.data.fields;
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const coverage = words[7];
    if (coverage === undefined) throw Error('Actual coverage record required');
    const pointer = words[coverage + 3];
    if (pointer === undefined) throw Error('Actual opaque mask required');
    expect((words[pointer + 4] ?? 0) & 1).toBe(0);
    expect([1, 4]).toContain(row.status);
  }
  const output = process.env.FORGEAX_SCREEN_RASTER_RECEIVER_CPU_OUTPUT;
  if (output) {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'raster.wgsl'), programs.raster.wgsl);
    writeFileSync(join(output, 'compute.wgsl'), programs.compute.wgsl);
    writeFileSync(
      join(output, 'cases.json'),
      JSON.stringify(
        cases.map(({ name, token, status, opacity, direction, viewProjection, rasterMatrix }) => ({
          name,
          token,
          status,
          opacity,
          direction,
          viewProjection: [...viewProjection],
          rasterMatrix: [...rasterMatrix],
        })),
        null,
        2,
      ),
    );
  }
});
