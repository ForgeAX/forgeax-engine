import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runSurfaceBufferWork } from '../../../render/src/__tests__/raytracing/sdf-surface-intersection.fixture';
import { compileShader } from '../../../shader-compiler/src/index';
import { exactEndpointCases } from './sdf-surface-exact-endpoints.data';
import {
  assessExactEndpoints,
  exactEndpointInput,
  exactEndpointVariants,
} from './sdf-surface-exact-endpoints.fixture';

it('returns exact dyadic endpoint points only in the supported integer subdomain', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Actual endpoint verification requires an adapter');
  const device = await adapter.requestDevice(),
    errors: string[] = [],
    directory = process.env.FORGEAX_EXACT_ENDPOINT_OUTPUT ?? 'artifacts/sdf-exact-endpoints',
    rows = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(join(directory, 'input.bin'), exactEndpointInput());
    for (const variant of exactEndpointVariants()) {
      const code = (await compileShader(variant.source, { id: variant.name })).unwrap().wgsl,
        raw = await runSurfaceBufferWork(
          device,
          code,
          exactEndpointInput(),
          'exactEndpoints',
          exactEndpointCases.length,
          16,
        ),
        assessment = assessExactEndpoints(raw);
      writeFileSync(join(directory, `${variant.name}.wgsl`), code);
      writeFileSync(join(directory, `${variant.name}.bin`), new Uint8Array(raw.buffer));
      rows.push({ name: variant.name, negative: variant.negative, assessment });
      if (variant.negative) expect(assessment.failures.length).toBeGreaterThan(0);
      else expect(assessment.failures).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
    writeFileSync(
      join(directory, 'assessment.json'),
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
            'Endpoint precision component only; no closed-edge, nearest tie, World or GI qualification.',
        },
        null,
        2,
      ),
    );
  }
}, 60_000);
