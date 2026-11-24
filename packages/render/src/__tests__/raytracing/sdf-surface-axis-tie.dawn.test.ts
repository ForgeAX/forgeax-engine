import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/compile';
import { assessAxisTie, axisTieLeafWitness, prepareAxisTie } from './sdf-surface-axis-tie.fixture';
import { runSurfaceBufferWork } from './sdf-surface-intersection.fixture';

it('removes only the certified same-axis-plane tie blocker while preserving ordinary overlap and prior unknown', async () => {
  const input = process.env.FORGEAX_AXIS_TIE_LEAF_RAW,
    output = process.env.FORGEAX_AXIS_TIE_OUTPUT ?? 'artifacts/sdf-surface-axis-tie';
  const witness = axisTieLeafWitness();
  const bytes = input ? readFileSync(input) : new Uint8Array(witness.buffer),
    prepared = prepareAxisTie(
      new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    );
  expect(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)).toEqual(witness);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'input.bin'), prepared.input);
  const start = performance.now();
  const stage = (name: string) =>
    appendFileSync(
      join(output, 'stages.jsonl'),
      `${JSON.stringify({ name, at: new Date().toISOString(), elapsedMs: performance.now() - start })}\n`,
    );
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Actual GPU adapter required');
  const device = await adapter.requestDevice(),
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const results: Record<string, ReturnType<typeof assessAxisTie>> = {};
  let baselineRaw: Uint32Array | undefined;
  try {
    for (const name of ['baseline', 'candidate'] as const) {
      stage(`${name}.compile.begin`);
      const code = (
        await compileShader(prepared[name], { id: `surface-axis-tie-${name}` })
      ).unwrap().wgsl;
      stage(`${name}.compile.ready`);
      writeFileSync(join(output, `${name}.wgsl`), code);
      stage(`${name}.work.begin`);
      const raw = await runSurfaceBufferWork(
        device,
        code,
        prepared.input,
        'endpointRows',
        prepared.cases.length,
        prepared.recordBytes,
      );
      stage(`${name}.work.ready`);
      writeFileSync(
        join(output, `${name}.raw`),
        new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
      );
      results[name] = assessAxisTie(prepared, raw);
      writeFileSync(join(output, `${name}.json`), JSON.stringify(results[name], null, 2));
      expect(errors).toEqual([]);
      if (name === 'baseline') {
        baselineRaw = raw;
        expect(results.baseline?.rows.map((row) => row.state)).toEqual(
          prepared.cases.map((row) => row.baselineState ?? 2),
        );
      } else {
        expect(results.candidate?.failures).toEqual([]);
        if (!baselineRaw) throw new Error('Actual baseline records required');
        const reference = baselineRaw;
        const stride = prepared.recordBytes / 4;
        prepared.cases.forEach((row, index) => {
          // An earlier unknown keeps its blocker; its opaque tie identity can
          // still select the lower primitive. All other unchanged paths are exact.
          if (
            row.baselineState === 1 ||
            (row.expectedState === 2 && row.name !== 'prior-unknown-survives')
          )
            expect(raw.slice(index * stride, (index + 1) * stride), row.name).toEqual(
              reference.slice(index * stride, (index + 1) * stride),
            );
        });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
    writeFileSync(
      join(output, 'result.json'),
      JSON.stringify(
        {
          results,
          errors,
          scope:
            'Reducer/axis-plane certificate component using actual leaf GPU records; not full packet or Sponza qualification',
        },
        null,
        2,
      ),
    );
  }
}, 30_000);
