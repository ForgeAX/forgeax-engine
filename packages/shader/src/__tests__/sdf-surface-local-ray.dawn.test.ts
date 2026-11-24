import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runSurfaceBufferWork } from '../../../render/src/__tests__/raytracing/sdf-surface-intersection.fixture';
import { compileShader } from '../../../shader-compiler/src/index';
import { surfaceLocalRayCases } from './sdf-surface-local-ray.data';
import {
  assessSurfaceLocalRays,
  surfaceLocalRayInputBytes,
  surfaceLocalRayVariants,
} from './sdf-surface-local-ray.fixture';

it('encloses canonical affine ray boxes and segments and catches actual GPU residual/width faults', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Local-ray component requires an actual GPU adapter');
  const device = await adapter.requestDevice(),
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const directory =
    process.env.FORGEAX_SURFACE_LOCAL_RAY_OUTPUT ?? 'artifacts/sdf-surface-local-ray';
  mkdirSync(directory, { recursive: true });
  const input = surfaceLocalRayInputBytes(),
    rows = [];
  try {
    for (const variant of surfaceLocalRayVariants()) {
      const code = (await compileShader(variant.source, { id: variant.name })).unwrap().wgsl,
        raw = await runSurfaceBufferWork(
          device,
          code,
          input,
          'localRayTest',
          surfaceLocalRayCases.length,
          80,
        ),
        assessment = assessSurfaceLocalRays(raw);
      writeFileSync(join(directory, `${variant.name}.bin`), new Uint8Array(raw.buffer));
      rows.push({ name: variant.name, negative: variant.negative, assessment });
      if (variant.negative) expect(assessment.failures.length, variant.name).toBeGreaterThan(0);
      else {
        expect(assessment.failures).toEqual([]);
        expect(assessment.valid).toBe(18);
        expect(assessment.unavailable).toBe(17);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
    writeFileSync(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          rows,
          errors,
          adapter: {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          },
          scope:
            'Binding-free affine/primitive component only; no World/BVH, Card, GI or performance qualification.',
        },
        null,
        2,
      ),
    );
  }
}, 60_000);
