import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as actionsGlob from '@actions/glob';
import { Project } from 'ts-morph';
import waitOn from 'wait-on';

const globEntry = import.meta.resolve('@actions/glob');
const globRoot = dirname(fileURLToPath(globEntry));
const { Pattern } = await import(pathToFileURL(join(globRoot, 'internal-pattern.js')));
const globRequire = createRequire(globEntry);
const { Minimatch } = globRequire('minimatch');

test('the fixed minimatch removes the internal API used by unpatched actions glob', () => {
  const matcher = new Minimatch('source/**/*.ts');
  assert.equal(matcher.matchOne, undefined);
  assert.throws(() => matcher.matchOne(['source'], matcher.set[0], true), TypeError);
});

test('actions glob retains partial traversal and exclusion with minimatch 11', async () => {
  const prefix = join(tmpdir(), 'forgeax-dependency-override-');
  const root = mkdtempSync(prefix);
  try {
    mkdirSync(join(root, 'source', 'nested'), { recursive: true });
    mkdirSync(join(root, 'other'));
    for (const name of [
      'source/one.ts',
      'source/nested/two.ts',
      'source/nested/skip.ts',
      'other/no.ts',
    ]) {
      writeFileSync(join(root, name), 'export {};\n');
    }
    const pattern = new Pattern(join(root, 'source', '**', '*.ts'));
    assert.equal(pattern.partialMatch(join(root, 'source', 'nested')), true);
    assert.equal(pattern.partialMatch(join(root, 'other')), false);
    const globber = await actionsGlob.create(`${root}/source/**/*.ts\n!${root}/source/**/skip.ts`, {
      followSymbolicLinks: false,
    });
    assert.deepEqual(
      (await globber.glob()).sort(),
      [join(root, 'source', 'nested', 'two.ts'), join(root, 'source', 'one.ts')].sort(),
    );
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(resolve(root).startsWith(resolve(prefix)) && !root.endsWith(sep));
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('ts-morph source selection remains compatible with overridden minimatch', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('/source/one.ts', 'export const one = 1;');
  project.createSourceFile('/other/two.ts', 'export const two = 2;');
  assert.deepEqual(
    project.getSourceFiles('/source/**/*.ts').map((source) => source.getFilePath()),
    ['/source/one.ts'],
  );
});

test('wait-on validates and executes its public options with the fixed joi', async () => {
  await waitOn({ resources: [`file:${fileURLToPath(import.meta.url)}`], timeout: 1000 });
  await assert.rejects(waitOn({ resources: [42], timeout: 1000 }), /string/);
});
