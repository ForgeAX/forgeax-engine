import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import {
  runSegmentEndpoint,
  segmentCases,
  segmentShader,
} from './irradiance-field-segment.fixture';

it('checks the covered segment endpoint independently of march phase and rejects unavailable endpoint coverage', async () => {
  const code = (
    await compileShader(segmentShader, {
      id: 'irradiance-field-segment-endpoint',
      imports: {
        'forgeax_ray::irradiance_field_sample': readFileSync(
          new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
          'utf8',
        ),
      },
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
    })
  ).unwrap().wgsl;
  const field = packIrradianceFieldUniform(
    { origin: [-1, -1, -1], spacing: 0.25, dimensions: [9, 9, 9], probeCount: 729, levels: 1 },
    [{ window: [0, 0, 0], min: [0, 0, 0], max: [9, 9, 9] }],
  );
  const grid = packGlobalSdfComposition([], {
    origin: [-1, -1, -1],
    dimensions: [9, 9, 9],
    spacing: 0.25,
    maxDistance: 4,
    coverageDistance: 0.125,
  }).unwrap().data.settings;
  mkdirSync('artifacts/irradiance-field/segment', { recursive: true });
  writeFileSync('artifacts/irradiance-field/segment/compiled.wgsl', code);
  writeFileSync(
    'artifacts/irradiance-field/segment/inputs.json',
    JSON.stringify({ field: Array.from(field), grid: Array.from(grid) }),
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('segment regression requires a real GPU');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  try {
    const result = await runSegmentEndpoint(device, code, field, grid);
    mkdirSync('artifacts/irradiance-field/segment', { recursive: true });
    writeFileSync(
      'artifacts/irradiance-field/segment/result.json',
      JSON.stringify(
        {
          ...result,
          errors,
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          adapter: {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          },
        },
        null,
        2,
      ),
    );
    expect(result.covered.slice(0, segmentCases.length)).toEqual(segmentCases.map(() => 0));
    expect(result.covered.slice(segmentCases.length)).toEqual(segmentCases.map(() => 1));
    expect(result.unavailable).toEqual(result.cases.map(() => -1));
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
  }
}, 60_000);
