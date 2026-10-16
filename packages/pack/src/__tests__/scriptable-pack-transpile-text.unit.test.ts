import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  snapshotTranspileText,
  transpileTextDigest,
  validSnapshotTranspileText,
} from '../scriptable-pack-transpile-text.js';

// Real compiler oracle; no fixture compiler or successful import-missing RED.
const filename = '/fixture/owner.pack.ts';
const source = `import type { Missing } from './type-only.ts';
// import("./comment-is-not-a-module.ts")
import { value } from './relative.ts';
export { value as alias } from 'fixture-alias';
export enum Mode { Ready = 1 }
const ordinary = "import('fake')";
const escaped = "a\\"b";
export const read = async (): Promise<number> => (await import('./dynamic.ts')).value + value;
export const marker: Missing | undefined = undefined;
export { ordinary, escaped };`;
const options: ts.TranspileOptions = {
  fileName: filename,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    isolatedModules: true,
    sourceMap: false,
  },
  reportDiagnostics: true,
};

it('preserves exact successful native TypeScript emitted bytes before import rewriting', () => {
  const compiled = ts.transpileModule(source, options);
  expect(
    compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error),
  ).toEqual([]);
  expect(compiled.outputText).not.toContain("from './type-only.ts'");
  expect(compiled.outputText).toContain('comment-is-not-a-module');
  expect(compiled.outputText).toContain("import('fake')");
  const recipe = transpileTextDigest('fixture real compiler output qualification');
  const record = snapshotTranspileText(filename, source, recipe, compiled.outputText);
  expect(validSnapshotTranspileText(record, filename, source, recipe)).toBe(true);
  expect(new TextEncoder().encode(record.outputText)).toEqual(
    new TextEncoder().encode(compiled.outputText),
  );
  expect(record.outputDigest).toBe(transpileTextDigest(compiled.outputText));
});

it('refuses changed source, filename, recipe, corrupt text/digest/key and malformed records', () => {
  const compiled = ts.transpileModule(source, options);
  const recipe = transpileTextDigest('fixture recipe');
  const record = snapshotTranspileText(filename, source, recipe, compiled.outputText);
  expect(validSnapshotTranspileText(record, filename, `${source}\n// changed`, recipe)).toBe(false);
  expect(validSnapshotTranspileText(record, '/other/owner.pack.ts', source, recipe)).toBe(false);
  expect(
    validSnapshotTranspileText(record, filename, source, transpileTextDigest('other recipe')),
  ).toBe(false);
  for (const corrupt of [
    { ...record, outputText: `${record.outputText}\nthrow new Error("corrupt cache");` },
    { ...record, outputDigest: '0'.repeat(64) },
    { ...record, key: '0'.repeat(64) },
    { ...record, sourceDigest: '0'.repeat(64) },
    null,
    {},
    { ...record, outputText: 1 },
  ])
    expect(validSnapshotTranspileText(corrupt, filename, source, recipe)).toBe(false);
});

it('keeps native malformed TypeScript diagnostics as the cold correctness oracle', () => {
  const compiled = ts.transpileModule('export const broken = ;', options);
  const errors =
    compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ?? [];
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0]?.file?.fileName).toBe(filename);
});
