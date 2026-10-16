import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const preflight = resolve(import.meta.dirname, '..', 'typecheck-output-preflight.mjs');

test('fails a cold declaration build instead of hiding the first compiler failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-types-preflight-'));
  const bin = join(root, 'node_modules/typescript/bin');
  const state = join(root, 'invocations');
  try {
    for (const name of ['alpha', 'beta']) {
      const src = join(root, 'packages', name, 'src');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'index.ts'), `export const ${name} = true;\n`);
      writeFileSync(
        join(root, 'packages', name, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { declaration: true, outDir: 'dist' } }),
      );
    }
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'tsc'),
      `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const state = process.env.FORGEAX_PREFLIGHT_STATE;
const count = state && existsSync(state) ? Number(readFileSync(state, 'utf8')) : 0;
const next = count + 1;
if (state) writeFileSync(state, String(next));
if (next === 1) {
  const output = join(process.env.FORGEAX_REPO_ROOT, 'packages', 'alpha', 'dist', 'index.d.ts');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, 'export declare const alpha: true;\\n');
  process.exit(1);
}
const output = join(process.env.FORGEAX_REPO_ROOT, 'packages', 'beta', 'dist', 'index.d.ts');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, 'export declare const beta: true;\\n');
process.exit(0);
`,
    );

    const result = spawnSync(process.execPath, [preflight], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORGEAX_REPO_ROOT: root,
        FORGEAX_PREFLIGHT_STATE: state,
        PATH: dirname(process.execPath),
      },
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(state, 'utf8'), '1');
    assert.ok(existsSync(join(root, 'packages', 'alpha', 'dist', 'index.d.ts')));
    assert.equal(existsSync(join(root, 'packages', 'beta', 'dist', 'index.d.ts')), false);
    assert.doesNotMatch(result.stderr, /retrying/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const invalid of [false, true]) {
  test(`cold declarations are emitted before a mandatory checked build (invalid=${invalid})`, () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-types-checked-'));
    try {
      for (const name of ['provider', 'consumer']) {
        const directory = join(root, 'packages', name);
        mkdirSync(join(directory, 'src'), { recursive: true });
        writeFileSync(
          join(directory, 'package.json'),
          JSON.stringify({
            name: `@fixture/${name}`,
            type: 'module',
            exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } },
          }),
        );
        writeFileSync(
          join(directory, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              composite: true,
              declaration: true,
              emitDeclarationOnly: true,
              strict: true,
              module: 'ESNext',
              moduleResolution: 'bundler',
              target: 'ES2022',
              rootDir: 'src',
              outDir: 'dist',
              types: [],
            },
            include: ['src/**/*.ts'],
            references: name === 'consumer' ? [{ path: '../provider' }] : [],
          }),
        );
        writeFileSync(
          join(directory, 'src/index.ts'),
          name === 'provider'
            ? 'export const value: number = 7;'
            : `import { value } from '@fixture/provider'; export const result: ${invalid ? 'string' : 'number'} = value;`,
        );
      }
      mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true });
      symlinkSync(
        join(root, 'packages/provider'),
        join(root, 'node_modules/@fixture/provider'),
        'dir',
      );
      const bin = join(root, 'node_modules/typescript/bin');
      mkdirSync(bin, { recursive: true });
      const tsc = resolve('node_modules/typescript/bin/tsc');
      writeFileSync(
        join(bin, 'tsc'),
        `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, 'calls'))}, JSON.stringify(args) + '\\n');
const result = spawnSync(process.execPath, [${JSON.stringify(tsc)}, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      );
      const result = spawnSync(process.execPath, [preflight], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, FORGEAX_REPO_ROOT: root, PATH: dirname(process.execPath) },
      });
      assert.equal(result.status, invalid ? 2 : 0, result.stderr + result.stdout);
      const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(calls.length, 2);
      assert.ok(calls[0].includes('--noCheck'));
      assert.ok(calls[1].includes('--force'));
      assert.equal(calls[1].includes('--noCheck'), false);
      assert.match(
        readFileSync(join(root, 'packages/provider/dist/index.d.ts'), 'utf8'),
        /value: number/,
      );
      if (invalid) assert.match(result.stdout, /TS2322/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('the real compiler regression runs after its required job installs TypeScript', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const primary = workflow.split('\n  primary-pnpm:')[1]?.split(/\n {2}[a-z][a-z0-9-]*:/)[0];
  assert.ok(primary, 'primary regression job is required');
  const install = primary.indexOf('- name: Install (frozen)');
  const regression = primary.indexOf('scripts/__tests__/typecheck-output-preflight.test.mjs');
  assert.ok(
    install >= 0 && regression > install,
    'compiler regression requires the frozen dependency installation',
  );
});
