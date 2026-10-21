import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { generateProfileTypes } from '../../scripts/generate-profile-types.mjs';

function diagnostics(sources) {
  const directory = mkdtempSync(join(tmpdir(), 'profile-types-'));
  try {
    const paths = sources.map((source, index) => {
      const path = join(directory, `consumer-${index}.ts`);
      writeFileSync(path, source);
      return path;
    });
    const program = ts.createProgram(paths, {
      noEmit: true,
      strict: true,
      types: [],
      lib: ['lib.es2022.d.ts'],
      target: ts.ScriptTarget.ES2022,
    });
    return ts.getPreEmitDiagnostics(program).map((issue) => ({
      source: paths.findIndex((path) => program.getSourceFile(path) === issue.file),
      code: issue.code,
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it('carries schema field requirements and source variants into consumer typechecking', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../../schema/profile-capture.schema.json', import.meta.url), 'utf8'),
  );
  const consumer = `const value: ProfilePhaseRecord = {
    kind: 'phase', source: 'app', frameId: 1, phase: 'step', startMicros: 0, endMicros: 1, durationMicros: 1,
  };`;
  const source = (consumer) => `${generateProfileTypes(schema)}\n${consumer}`;
  const sources = [source(consumer)];
  schema.$defs.phaseRecord.properties.traceId = { type: 'string' };
  schema.$defs.phaseRecord.required.push('traceId');
  sources.push(source(consumer));
  sources.push(source(consumer.replace("kind: 'phase',", "traceId: 'trace', kind: 'phase',")));
  sources.push(source("const source: ProfileSource = 'worker';"));
  schema.$defs.source.enum.push('worker');
  sources.push(source("const source: ProfileSource = 'worker';"));
  expect(diagnostics(sources)).toEqual([
    { source: 1, code: 2741 },
    { source: 3, code: 2322 },
  ]);
});
