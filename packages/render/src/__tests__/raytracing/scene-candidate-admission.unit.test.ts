import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { readSdfSceneCandidateDirectory } from '../../raytracing/sdf-scene-candidates';
import {
  fullRosterMask,
  sceneCandidateCases,
  sceneCandidateFragments,
  sceneCandidateInput,
  sceneCandidateKernel,
} from './sdf-scene-candidates.fixture';

it('keeps the complete canonical candidate admission inventory and real physical spans', async () => {
  const cases = await sceneCandidateCases();
  expect(cases).toHaveLength(33);
  expect(new Set(cases.map((row) => row.name)).size).toBe(33);
  for (const row of cases) {
    expect(row.instances.length).toBe(144);
    expect(row.expected.length).toBe(4);
    expect(row.actual.buffer).not.toBe(row.expected.buffer);
    expect(row.fields.length).toBeGreaterThan(84);
  }
  expect(cases.find((row) => row.name === 'complete-base-fallback')?.fields[1]).toBe(4);
  expect(cases.find((row) => row.name === 'indexed-near')?.fields[1]).toBe(0x80000004);
  const stale = cases.find((row) => row.name === 'stale-directory-highwater');
  if (!stale) throw Error('Explicit stale highwater case required');
  // Keep the directory internally legal, so only its disagreement with the
  // independent reader highwater rejects it, rather than an unrelated node cap.
  expect(readSdfSceneCandidateDirectory(stale.fields).unwrap()?.rowLimit).toBe(3);
  expect(stale.rowLimit).toBe(2);
  const input = sceneCandidateInput(cases);
  expect(input.byteLength % 4).toBe(0);
  expect(input.byteLength).toBe((4 + cases.length * (new Uint32Array(input.buffer)[0] ?? 0)) * 4);
});

it('checks the whole closed segment with the independent exact full-roster oracle', async () => {
  const cases = await sceneCandidateCases();
  const mask = (name: string) => {
    const row = cases.find((value) => value.name === name);
    if (!row) throw Error('Complete named case required');
    return fullRosterMask(row);
  };
  expect(mask('indexed-near')).toBe(1);
  expect(mask('retained-missing')).toBe(2);
  expect(mask('indexed-clear')).toBe(0);
  expect(mask('closed-end')).toBe(2);
  expect(mask('clear-before-end')).toBe(0);
  expect(mask('unknown-enclosure-always-retained')).toBe(2);
  expect(mask('complete-base-fallback')).toBe(3);
  expect(mask('mask-selects-only-sampled')).toBe(0);
});

it('validates both actual light kernels without a triangle or nearest traversal CFG', async () => {
  const fragments = sceneCandidateFragments();
  for (const part of fragments.parts) {
    expect(fragments.factory.slice(part.start, part.end)).toBe(part.source);
    expect(fragments.factory.split(part.source).length).toBe(2);
  }
  const rows = [];
  for (const variant of ['original', 'skip-raw-admission'] as const) {
    const source = sceneCandidateKernel(variant);
    expect(source).not.toMatch(
      /\bfn sdfSurface(?:Triangle|LeafTriangle|Accept|TraceRow|RootPrefix)\s*\(/,
    );
    const compiled = (
      await compileShader(source, { id: `scene-candidate-admission-${variant}` })
    ).unwrap();
    expect(
      compiled.manifestEntry.entryPoints?.some((entry) => entry.name === 'candidateTest'),
    ).toBe(true);
    rows.push({
      variant,
      sourceSHA256: createHash('sha256').update(source).digest('hex'),
      compiledSHA256: createHash('sha256').update(compiled.wgsl).digest('hex'),
      compiled: compiled.wgsl,
    });
  }
  expect(rows[0]?.sourceSHA256).not.toBe(rows[1]?.sourceSHA256);
  const out = process.env.FORGEAX_SCENE_CANDIDATE_PREPARED;
  if (out) {
    mkdirSync(out, { recursive: true });
    const cases = await sceneCandidateCases();
    writeFileSync(
      `${out}/fragments.json`,
      JSON.stringify(
        {
          scope:
            'Actual software World factory; checkout identity is captured by the execution plan',
          factorySHA256: createHash('sha256').update(fragments.factory).digest('hex'),
          parts: fragments.parts.map(({ source, ...part }) => ({
            ...part,
            sha256: createHash('sha256').update(source).digest('hex'),
          })),
        },
        null,
        2,
      ),
    );
    writeFileSync(`${out}/input.bin`, sceneCandidateInput(cases));
    writeFileSync(
      `${out}/cases.json`,
      JSON.stringify(
        cases.map((row) => ({
          name: row.name,
          state: row.state,
          directory: row.directory,
          preflight: row.preflight,
          rowLimit: row.rowLimit,
          associated: row.associated,
          mask: row.mask,
          ray: row.ray,
          expected: [...row.expected],
          actual: [...row.actual],
          bounds: row.bounds,
          candidateStateMeaning: { 0: 'indexed', 1: 'full-roster', 2: 'unknown' }[row.state],
          fullRosterMask: fullRosterMask(row),
        })),
        null,
        2,
      ),
    );
    for (const row of rows) writeFileSync(`${out}/${row.variant}.wgsl`, row.compiled);
    writeFileSync(
      `${out}/kernels.json`,
      JSON.stringify(
        rows.map(({ compiled: _compiled, ...row }) => row),
        null,
        2,
      ),
    );
  }
});
