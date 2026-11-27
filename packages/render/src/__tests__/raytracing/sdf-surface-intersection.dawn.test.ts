import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  assessIntervalArithmetic,
  assessSurfaceIntervals,
  runIntervalArithmeticFixture,
  runSurfaceIntervalFixture,
  surfaceCases,
  surfaceShaderVariants,
} from './sdf-surface-intersection.fixture';

it('certifies primitive intervals against exact rational geometry and detects actual GPU mutants', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null)
    throw new Error('Conservative primitive verification requires an actual adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const directory = process.env.FORGEAX_SURFACE_INTERVAL_OUTPUT ?? 'artifacts/sdf-surface-interval';
  mkdirSync(directory, { recursive: true });
  const cases = surfaceCases();
  const rows = [];
  try {
    for (const variant of surfaceShaderVariants()) {
      const code = (await compileShader(variant.source, { id: `surface-${variant.name}` })).unwrap()
        .wgsl;
      const raw =
        variant.kind === 'surface'
          ? await runSurfaceIntervalFixture(device, code, cases)
          : await runIntervalArithmeticFixture(device, code);
      const assessment =
        variant.kind === 'surface'
          ? assessSurfaceIntervals(cases, raw)
          : assessIntervalArithmetic(raw);
      writeFileSync(
        join(directory, `${variant.name}.bin`),
        new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
      );
      rows.push({ name: variant.name, kind: variant.kind, negative: variant.negative, assessment });
      if (variant.negative) expect(assessment.failures.length, variant.name).toBeGreaterThan(0);
      else expect(assessment.failures, variant.name).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
    writeFileSync(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          cases,
          rows,
          errors,
          adapter: adapter.info,
          scope:
            'Primitive component only; not integrated SDF traversal, final GI or frame performance.',
        },
        null,
        2,
      ),
    );
  }
}, 60_000);
