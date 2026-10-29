import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { inspectEcsIteration, isEngineSource } from '../check-engine-ecs-iteration.mjs';

const root = '/engine-ecs-iteration-test';
function inspect(source, path = 'packages/render/src/main.ts') {
  const files = new Map([
    [
      resolve(root, 'packages/ecs/src/query/query.ts'),
      'export interface Query { spans(): { unwrap(): number[] }; batches(): { unwrap(): number[] }; }',
    ],
    [
      resolve(root, path),
      `import type { Query as Rows } from '${relativeImport(path)}';\ndeclare const query: Rows;\n${source}`,
    ],
  ]);
  const host = ts.createCompilerHost({ noLib: true });
  host.fileExists = (file) => files.has(file);
  host.readFile = (file) => files.get(file);
  host.getSourceFile = (file, version) => {
    const text = files.get(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, version, true);
  };
  host.directoryExists = () => true;
  const program = ts.createProgram(
    [...files.keys()],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noLib: true,
      strict: true,
    },
    host,
  );
  return inspectEcsIteration(program, [...files.keys()], root);
}
function relativeImport(path) {
  // Fixtures keep the same src depth across production, examples and test cases.
  return path.includes('/__tests__/')
    ? '../../../ecs/src/query/query'
    : '../../ecs/src/query/query';
}

test('rejects query traversal through aliases and casts, with precise source locations', () => {
  const result = inspect('const alias = query;\nfor (const row of alias as Rows) { void row; }');
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].file, 'packages/render/src/main.ts');
  assert.equal(result.violations[0].line, 4);
  assert.equal(result.violations[0].expression, 'alias as Rows');
});

test('rejects materialization and explicit iterator access', () => {
  const result = inspect(
    'const a = [...query];\nconst b = Array.from(query);\nconst c = query[Symbol.iterator]();',
  );
  assert.equal(result.violations.length, 3);
});

test('accepts existing spans and batches, arrays and an unrelated structural lookalike', () => {
  const result = inspect(`
    for (const span of query.spans().unwrap()) { void span; }
    for (const batch of query.batches().unwrap()) { void batch; }
    const array = [1, 2]; for (const value of array) { void value; }
    declare const unrelated: { spans(): void };
    for (const value of unrelated) { void value; }
  `);
  assert.deepEqual(result.violations, []);
});

test('comments cannot waive numeric snapshots or facade escape', () => {
  for (const reason of [
    'Sparse optional membership has no span representation.',
    'Publication needs a complete declaration.',
    'Semantic strings are required by this owner.',
    '',
    'legacy',
    'TODO migrate this entire traversal at some point',
  ]) {
    assert.equal(
      inspect(`// ecs-row-iteration: ${reason}\nfor (const row of query) { consume(row); }`)
        .violations.length,
      1,
    );
  }
});

test('limits enforcement to engine implementation source', () => {
  for (const path of [
    'apps/demo/src/main.ts',
    'templates/game-3d/src/main.ts',
    'packages/render/src/__tests__/main.ts',
    'packages/render/src/__fixtures__/main.ts',
    'packages/render/src/main.test.ts',
    'packages/render/src/main.d.ts',
  ]) {
    assert.equal(isEngineSource(path), false);
    assert.deepEqual(inspect('for (const row of query) { void row; }', path).violations, []);
  }
  assert.equal(isEngineSource('packages/render/src/main.ts'), true);
});

test('does not mistake a local Array.from method for the native materializer', () => {
  const result = inspect(
    'const Array = { from(value: Rows) { return value; } }; Array.from(query);',
  );
  assert.deepEqual(result.violations, []);
});

test('accepts allocation-light identity and membership traversal, including copied IDs', () => {
  const result = inspect(`
    for (const row of query) {
      const entity = row.entity;
      if (row.has({})) consume(entity);
      callbacks.push(() => entity);
    }
  `);
  assert.deepEqual(result.violations, []);
});

test('rejects component materialization and captured transient row facades', () => {
  for (const body of [
    'row.get(Component)',
    'row.mut(Component)',
    'callbacks.push(() => row.entity)',
    'consume(row)',
    'const alias = row',
  ]) {
    assert.equal(inspect(`for (const row of query) { ${body}; }`).violations.length, 1);
  }
});

test('a method named snapshot does not authorize facade escape in consumers', () => {
  for (const body of [
    'row.snapshot()',
    '(row as { snapshot(): unknown }).snapshot()',
    'rows.push(row.snapshot())',
  ]) {
    assert.equal(inspect(`for (const row of query) { ${body}; }`).violations.length, 1);
  }
});

test('type erasure and locally erased aliases cannot waive traversal policy', () => {
  for (const source of [
    'for (const row of (query as unknown as Iterable<unknown>)) { consume(row); }',
    'const erased: any = query; for (const row of erased) { consume(row); }',
    'const alias = query as any; const again = alias; const snapshot = [...again];',
  ])
    assert.equal(inspect(source).violations.length, 1);
});

test('there is no intrinsic snapshot or combinations-owner allowlist', () => {
  const result = inspect(`
    class QueryRowFacade { snapshot() { return this; } }
    class ExecutableQuery {
      combinations() {
        for (const row of query) snapshots.push((row as QueryRowFacade).snapshot());
      }
    }
  `);
  assert.equal(result.violations.length, 1);
});
