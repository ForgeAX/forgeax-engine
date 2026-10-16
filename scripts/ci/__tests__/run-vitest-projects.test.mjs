import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = path.join(root, 'scripts/ci/run-vitest-projects.mjs');

test('workspace typecheck modes preserve real type errors, runtime failures, and coverage', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'forgeax-vitest-projects-'));
  const runtimeFile = path.join(fixture, 'runtime.test.ts');
  const typeFile = path.join(fixture, 'contract.test-d.ts');
  const reportFile = path.join(fixture, 'result.json');
  const run = (...args) => {
    const result = spawnSync(
      process.execPath,
      [cli, 'run', '--maxWorkers=1', '--reporter=verbose', ...args],
      {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, NO_COLOR: '1' },
      },
    );
    assert.equal(
      result.error,
      undefined,
      `Vitest child: ${result.error?.message ?? 'ok'}\n${result.stdout}\n${result.stderr}`,
    );
    assert.equal(result.signal, null, result.stdout + result.stderr);
    return { ...result, output: result.stdout + result.stderr };
  };
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
    writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
    writeFileSync(
      path.join(fixture, 'vitest.config.mjs'),
      `export default { test: {
        projects: [{ test: { name: 'probe', include: ['runtime.test.ts'],
          typecheck: { enabled: true, tsconfig: './tsconfig.json' } } }],
        coverage: { provider: 'v8', include: ['subject.ts'], reporter: ['json'] }
      } };`,
    );
    writeFileSync(
      path.join(fixture, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, skipLibCheck: true, module: 'NodeNext' },
        exclude: ['**/*.test-d.ts'],
      }),
    );
    writeFileSync(path.join(fixture, 'subject.ts'), 'export const answer = () => 42;');
    writeFileSync(path.join(fixture, 'ambient.d.ts'), 'declare type FixtureName = string;');
    // Ordinary source and runtime-file typechecking has its own build gate.
    // A selected type test should compile its imports and ambient declarations only.
    writeFileSync(path.join(fixture, 'unselected.ts'), 'const unrelated: string = 42;');
    writeFileSync(
      runtimeFile,
      "import { test } from 'vitest'; test('runtime poison', () => { throw Error('runtime poison'); });",
    );
    writeFileSync(
      typeFile,
      "import { expectTypeOf, test } from 'vitest'; import { answer } from './subject.js'; test('types pass', () => { expectTypeOf<FixtureName>().toEqualTypeOf<string>(); expectTypeOf(answer()).toEqualTypeOf<number>(); });",
    );
    const types = run('--typecheck.only');
    assert.equal(types.status, 0, types.output);
    assert.match(types.output, /contract\.test-d\.ts/);
    assert.match(types.output, /passed: files=1, owners=1/);
    assert.doesNotMatch(types.output, /runtime\.test\.ts|runtime poison/);

    writeFileSync(path.join(fixture, 'subject.ts'), 'export const answer = (): number => "bad";');
    const badImport = run('--typecheck.only');
    assert.equal(badImport.status, 1, badImport.output);
    assert.match(badImport.output, /subject\.ts/);
    writeFileSync(path.join(fixture, 'subject.ts'), 'export const answer = () => 42;');

    writeFileSync(
      typeFile,
      "import { expectTypeOf, test } from 'vitest'; test('types fail', () => { expectTypeOf<string>().toEqualTypeOf<number>(); });",
    );
    const badTypes = run('--typecheck.only');
    assert.equal(badTypes.status, 1, badTypes.output);
    assert.match(badTypes.output, /TypeCheckError/);

    const badRuntime = run('--typecheck.enabled=false');
    assert.equal(badRuntime.status, 1, badRuntime.output);
    assert.match(badRuntime.output, /runtime poison/);
    assert.doesNotMatch(badRuntime.output, /contract\.test-d\.ts/);

    writeFileSync(
      runtimeFile,
      "import { expect, test } from 'vitest'; import { answer } from './subject.js'; test('runtime passes', () => expect(answer()).toBe(42));",
    );
    const coverage = run(
      '--typecheck.enabled=false',
      '--coverage',
      '--reporter=json',
      `--outputFile=${reportFile}`,
    );
    assert.equal(coverage.status, 0, coverage.output);
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.equal(report.success, true);
    assert.equal(report.numPassedTests, 1);
    assert.equal(report.testResults.length, 1);
    assert.ok(report.testResults[0].name.endsWith('runtime.test.ts'));
    const covered = JSON.parse(
      readFileSync(path.join(fixture, 'coverage/coverage-final.json'), 'utf8'),
    );
    assert.ok(Object.keys(covered).some((name) => name.endsWith('subject.ts')));

    const nested = path.join(fixture, 'nested');
    mkdirSync(nested);
    writeFileSync(
      path.join(nested, 'runtime.test.ts'),
      "import { test } from 'vitest'; test('nested runtime poison', () => { throw Error('nested runtime poison'); });",
    );
    writeFileSync(
      path.join(nested, 'other.test.ts'),
      "import { expect, test } from 'vitest'; test('other passes', () => expect(1).toBe(1));",
    );
    writeFileSync(
      path.join(fixture, 'vitest.config.mjs'),
      `export default { test: {
        projects: [{ root: './nested', test: { name: 'probe', include: ['*.test.ts'] } }]
      } };`,
    );
    const excluded = run('--typecheck.enabled=false', '--exclude=nested/runtime.test.ts');
    assert.equal(excluded.status, 0, excluded.output);
    assert.match(excluded.output, /other passes/);
    assert.doesNotMatch(excluded.output, /nested runtime poison/);

    // A main-process plugin handle must retain the CLI's bounded exit and
    // diagnostic, rather than hanging a completed coverage child forever.
    writeFileSync(
      path.join(fixture, 'vitest.config.mjs'),
      `export default {
        plugins: [{ name: 'retained-handle', configureServer() {
          setInterval(() => {}, 1000);
        } }],
        test: { include: ['runtime.test.ts'], teardownTimeout: 100 }
      };`,
    );
    const retainedHandle = run('--typecheck.enabled=false');
    assert.equal(retainedHandle.status, 0, retainedHandle.output);
    assert.match(retainedHandle.output, /close timed out after 100ms/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('only the intentional unit marker accepts an empty population through the API runner', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'forgeax-vitest-empty-'));
  try {
    symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
    writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
    // Exercise the actual Vitest API runner without initializing every Engine
    // workspace and graphics plugin merely to discover an empty population.
    writeFileSync(
      path.join(fixture, 'vitest.config.mjs'),
      `export default { test: { projects: [
        { test: { name: 'unit', include: [], passWithNoTests: true } },
        { test: { name: 'required', include: [] } }
      ] } };`,
    );
    for (const projects of [['unit'], ['required'], ['unit', 'required']]) {
      const args = ['run', ...projects.flatMap((name) => ['--project', name])];
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, NO_COLOR: '1' },
      });
      const detail = `Vitest ${args.join(' ')}: ${result.error?.message ?? 'completed'}\n${result.stdout}\n${result.stderr}`;
      assert.equal(result.error, undefined, detail);
      assert.equal(result.signal, null, detail);
      assert.equal(result.status, projects.length === 1 && projects[0] === 'unit' ? 0 : 1, detail);
      assert.match(`${result.stdout}${result.stderr}`, /No test files found/, detail);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
