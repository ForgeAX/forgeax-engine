import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/index';
import { surfacePoolCases, surfacePoolVariants } from './sdf-surface-pool.fixture';
import { assessSurfacePoolCases, runSurfacePoolCases } from './sdf-surface-pool-gpu.fixture';

it('executes metadata guards through storage and uint texture adapters and catches omitted guard/source-span controls', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('Pool decoder validation requires an actual GPU adapter');
  const device = await adapter.requestDevice(),
    errors: string[] = [],
    cases = surfacePoolCases(),
    results = [];
  const info = adapter.info,
    adapterReceipt = {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    };
  const directory = process.env.FORGEAX_SURFACE_POOL_OUTPUT ?? 'artifacts/sdf-surface-pool';
  mkdirSync(directory, { recursive: true });
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    expect(
      [adapterReceipt.vendor, adapterReceipt.device, adapterReceipt.description].some(Boolean),
      'Actual physical adapter identity must be captured through its getters',
    ).toBe(true);
    for (const variant of surfacePoolVariants()) {
      const compiled = (
          await compileShader(variant.source, { id: `surface-pool-${variant.name}` })
        ).unwrap(),
        raw = await runSurfacePoolCases(device, compiled.wgsl, variant.kind, cases),
        failures = assessSurfacePoolCases(cases, raw);
      writeFileSync(join(directory, `${variant.name}.bin`), new Uint8Array(raw.buffer));
      writeFileSync(join(directory, `${variant.name}.wgsl`), compiled.wgsl);
      results.push({
        name: variant.name,
        kind: variant.kind,
        negative: variant.negative,
        failures,
      });
      if (!variant.negative) expect(failures, variant.name).toEqual([]);
      else if (variant.name === 'negative-unused-tail-accepted')
        expect(failures.map((row) => row.name)).toEqual(['nonzero-unused-sidedness-tail']);
      else
        expect(failures.map((row) => row.name)).toEqual([
          'logical-field-span-truncated',
          'logical-field-span-empty',
        ]);
    }
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
    writeFileSync(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          cases,
          results,
          errors,
          adapter: adapterReceipt,
          scope:
            'Controlled metadata decoder component only; not geometry, production projection, traversal, scene, GI or performance acceptance',
        },
        null,
        2,
      ),
    );
  }
}, 60_000);
