import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { assessPartialCoverage, preparePartialCoverage } from './sdf-partial-coverage.fixture';

let pending: ReturnType<typeof preparePartialCoverage> | undefined;
const prepare = () => (pending ??= preparePartialCoverage());

it('retains real Global byte transport for partial bit31/32 and arbitrary u32 coverage words', async () => {
  const prepared = await prepare();
  expect(prepared.cases).toHaveLength(31);
  const input = new Uint32Array(prepared.input.buffer);
  for (const [index, entry] of prepared.cases.entries()) {
    const data = entry.composition.data.fields;
    expect(data).toBeInstanceOf(Uint8Array);
    const first = (input[4 + index * 32 + 2] ?? 0) * 4;
    expect(prepared.input.subarray(first, first + data.byteLength)).toEqual(data);
  }
  for (const name of ['uint64-primitive-31', 'uint33-primitive-32']) {
    const entry = prepared.cases.find((row) => row.name === name);
    if (!entry) throw Error('Authored cross-word transport control missing');
    const words = new Uint32Array(entry.composition.data.fields.buffer);
    const record = words[7] ?? 0;
    expect(words[record + 2]).toBe(2);
    const bits = (words[record + 3] ?? 0) + 4;
    expect(Array.from(words.subarray(bits, bits + 2))).toEqual(entry.expectedWords);
  }
});

it('composes actual packet, canonical candidates and Row traversal for the bounded coverage GPU component', async () => {
  const prepared = await prepare();
  const compiled = (
    await compileShader(prepared.code, { id: 'partial-surface-coverage-world' })
  ).unwrap();
  expect(compiled.wgsl).toContain('sdfSurfacePrimitiveOpaque');
  expect(compiled.reflection.boundGlobals.map((entry) => [entry.group, entry.binding])).toEqual([
    [0, 0],
    [0, 1],
  ]);
  const directory = process.env.FORGEAX_PARTIAL_COVERAGE_PREPARE;
  if (directory !== undefined) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/partial.input.bin`, prepared.input);
    writeFileSync(`${directory}/partial.source.wgsl`, prepared.code);
    writeFileSync(`${directory}/partial.compiled.wgsl`, compiled.wgsl);
    writeFileSync(
      `${directory}/partial.reflection.json`,
      JSON.stringify(compiled.reflection, null, 2),
    );
    writeFileSync(
      `${directory}/partial.cases.json`,
      JSON.stringify(
        prepared.cases.map(({ composition: _composition, ...entry }) => entry),
        null,
        2,
      ),
    );
    const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    writeFileSync(
      `${directory}/partial.identity.json`,
      JSON.stringify(
        {
          cases: prepared.cases.length,
          inputBytes: prepared.input.byteLength,
          inputSha: hash(prepared.input),
          sourceSha: hash(prepared.code),
          compiledSha: hash(compiled.wgsl),
          outputBytes: prepared.cases.length * 64,
          deviceCreated: false,
        },
        null,
        2,
      ),
    );
  }
}, 60_000);

it('rejects wrong availability and word transport in the CPU assessment without averaging cases', async () => {
  const { cases } = await prepare();
  // CPU-only checker witness. These records are never called actual GPU output.
  const raw = new Uint32Array(cases.length * 16),
    floats = new Float32Array(raw.buffer);
  cases.forEach((entry, index) => {
    const at = index * 16;
    raw.set([entry.state, entry.row, entry.primitive ?? 0xffffffff, entry.frontFace], at);
    floats[at + 4] = 1;
    floats[at + 5] = 1;
    raw[at + 6] = entry.budget;
    raw[at + 7] = Number(entry.ready);
    raw.set(entry.expectedWords ?? [0, 0], at + 10);
    raw.set([entry.fieldWords, 1, entry.expectedEpoch], at + 12);
  });
  expect(assessPartialCoverage(cases, raw)).toEqual([]);
  const serialized = JSON.parse(
    JSON.stringify(cases.map(({ composition: _composition, ...entry }) => entry)),
  );
  expect(assessPartialCoverage(serialized, raw)).toEqual([]);
  for (const [name, offset] of [
    ['unknown-before-opaque', 0],
    ['opaque-before-unknown', 0],
    ['uint64-primitive-31', 10],
    ['bad-partial-tail', 7],
    ['stale-expected-epoch', 7],
  ] as const) {
    const index = cases.findIndex((entry) => entry.name === name);
    expect(index).toBeGreaterThanOrEqual(0);
    const wrong = raw.slice();
    wrong[index * 16 + offset] = (wrong[index * 16 + offset] ?? 0) ^ 1;
    expect(assessPartialCoverage(cases, wrong).some((message) => message.startsWith(name))).toBe(
      true,
    );
  }
});
