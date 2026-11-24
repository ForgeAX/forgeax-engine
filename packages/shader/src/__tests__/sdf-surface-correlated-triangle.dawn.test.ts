import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runSurfaceBufferWork } from '../../../render/src/__tests__/raytracing/sdf-surface-intersection.fixture';
import { compileShader } from '../../../shader-compiler/src/index';
import {
  assessCorrelatedTriangle,
  correlatedTriangleCases,
  correlatedTriangleInput,
  correlatedTriangleKernel,
  correlatedTriangleWithoutRefinement,
} from './sdf-surface-correlated-triangle.fixture';

it('refines unresolved triangle correlation without changing certified hits or clears', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Actual triangle-correlation adapter required');
  const device = await adapter.requestDevice(),
    errors: string[] = [];
  const directory =
    process.env.FORGEAX_CORRELATED_TRIANGLE_OUTPUT ?? 'artifacts/sdf-correlated-triangle';
  const rows: unknown[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  mkdirSync(directory, { recursive: true });
  try {
    const input = correlatedTriangleInput();
    writeFileSync(join(directory, 'input.bin'), input);
    const results: Uint32Array[] = [];
    for (const [name, source] of [
      ['unrefined-control', correlatedTriangleWithoutRefinement()],
      ['production', correlatedTriangleKernel],
    ] as const) {
      const code = (await compileShader(source, { id: name })).unwrap().wgsl;
      const raw = await runSurfaceBufferWork(
        device,
        code,
        input,
        'correlatedTriangle',
        correlatedTriangleCases.length,
        16,
      );
      // Save actual failures before any assertions.
      writeFileSync(join(directory, `${name}.wgsl`), code);
      writeFileSync(
        join(directory, `${name}.bin`),
        new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
      );
      results.push(raw);
    }
    const [old, current] = results;
    if (!old || !current) throw new Error('Both real pipeline readbacks required');
    for (const [index, row] of correlatedTriangleCases.entries()) {
      const before = old.subarray(index * 4, index * 4 + 4),
        after = current.subarray(index * 4, index * 4 + 4);
      const failures = assessCorrelatedTriangle(index, after);
      rows.push({ name: row.name, before: Array.from(before), after: Array.from(after), failures });
      expect(failures, row.name).toEqual([]);
      if (before[0] !== 2) expect(after, row.name).toEqual(before);
      if (row.name.startsWith('correlated-')) {
        expect(before[0], row.name).toBe(2);
        expect(after[0], row.name).toBe(0);
      }
    }
    expect(old[0]).toBe(2);
    expect(current[0]).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
    writeFileSync(
      join(directory, 'assessment.json'),
      JSON.stringify(
        {
          rows,
          errors,
          scope:
            'Real production triangle arithmetic component; not complete World, MASK coverage, GI or scene qualification.',
        },
        null,
        2,
      ),
    );
  }
}, 60_000);
