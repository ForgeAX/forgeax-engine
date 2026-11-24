import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/compile';
import {
  AXIS_TIE_LEAF_PROVENANCE,
  axisTieExactHits,
  axisTieLeafWitness,
  prepareAxisTie,
} from './sdf-surface-axis-tie.fixture';
import { exactSurface, surfaceDyadic } from './sdf-surface-intersection.fixture';

it('independently proves that the two actual opaque box primitives have exactly equal ray parameters', () => {
  const [a, b] = axisTieExactHits();
  if (!a || !b || a.kind !== 'hit' || b.kind !== 'hit')
    throw new Error('Both exact authored hits required');
  expect(a.time * b.det).toBe(b.time * a.det);
  expect(a.frontFace).toBe(1);
  expect(b.frontFace).toBe(1);
  const [nearA, nearB] = axisTieExactHits(Math.fround(0.125 + 2 ** -26));
  if (!nearA || !nearB || nearA.kind !== 'hit' || nearB.kind !== 'hit')
    throw new Error('Both distinct-plane hits required');
  expect(nearA.time * nearB.det).not.toBe(nearB.time * nearA.det);
});

it('compiles the actual baseline reducer and candidate geometry certificate with fixed control framing', async () => {
  const input = process.env.FORGEAX_AXIS_TIE_LEAF_RAW,
    output = process.env.FORGEAX_AXIS_TIE_OUTPUT;
  const witness = axisTieLeafWitness();
  expect(createHash('sha256').update(new Uint8Array(witness.buffer)).digest('hex')).toBe(
    AXIS_TIE_LEAF_PROVENANCE.rawSha256,
  );
  const bytes = input ? readFileSync(input) : new Uint8Array(witness.buffer),
    raw = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  expect(raw).toEqual(witness);
  const prepared = prepareAxisTie(raw);
  expect(prepared.cases).toHaveLength(15);
  const exact = axisTieExactHits()[0];
  if (!exact || exact.kind !== 'hit') throw new Error('Actual exact tie witness required');
  for (const row of prepared.cases) {
    if (row.expectedInterval) {
      const words = new Uint32Array(Float32Array.from(row.expectedInterval).buffer);
      expect(surfaceDyadic(words[0] ?? 0) * exact.det <= exact.time * (1n << 149n)).toBe(true);
      expect(surfaceDyadic(words[1] ?? 0) * exact.det >= exact.time * (1n << 149n)).toBe(true);
    }
    if (row.name === 'closed-point-original-tie') {
      for (const primitive of [8, 9]) {
        const triangle = row.mesh[primitive];
        if (!triangle) throw new Error('Closed triangle required');
        const closed = exactSurface({
          name: row.name,
          triangle,
          origin: [0, 0, 3],
          direction: [0, 0, -1],
          range: [0, 4],
          expected: 'oracle',
        });
        if (closed.kind !== 'hit') throw new Error('Closed endpoint must really intersect');
        expect(closed.time).toBe(4n * closed.det);
      }
    }
  }
  if (output) {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'input.bin'), prepared.input);
    writeFileSync(
      join(output, 'cases.json'),
      JSON.stringify(
        prepared.cases.map(({ records: _records, ...row }) => row),
        null,
        2,
      ),
    );
  }
  for (const name of ['baseline', 'candidate'] as const) {
    const compiled = (
      await compileShader(prepared[name], { id: `surface-axis-tie-${name}` })
    ).unwrap();
    if (output) {
      writeFileSync(join(output, `${name}.source.wgsl`), prepared[name]);
      writeFileSync(join(output, `${name}.wgsl`), compiled.wgsl);
    }
  }
  expect(prepared.candidate).not.toContain('fn sdfSurfaceTraceRow(');
  expect(prepared.candidate).not.toContain('fn sdfSurfaceTriangle(');
}, 30_000);
