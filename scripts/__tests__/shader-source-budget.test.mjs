import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

test('direct source production replaces an inherited small heap before compiler admission', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-source-budget-'));
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  try {
    for (const file of [
      'scripts/build-shared-inputs.mjs',
      'scripts/lib/shader-source-budget.mjs',
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(file, join(root, file));
    }
    write('package.json', '{"type":"module"}');
    write(
      'scripts/lib/runner-resources.mjs',
      `${readFileSync('scripts/lib/runner-resources.mjs', 'utf8').replace(
        'export function runnerResources(',
        'function actualRunnerResources(',
      )}\nexport const runnerResources = () => ({cpus: 8, memoryBytes: 16 * 1024 ** 3});\n`,
    );
    write(
      'scripts/lib/shared-build-cache.mjs',
      `
      export const reusableSharedShader = () => process.env.FIXTURE_CACHE === '1' ? 'verified' : null;
      export const sharedShaderInputFingerprint = () => 'fixture-input';
      export const sharedShaderReceipt = () => ({fixture: true});
    `,
    );
    for (const owner of ['shader', 'vfx-render'])
      write(`packages/${owner}/src/fixture.wgsl`, 'fixture');
    write('packages/vfx-render/src/shaders/fixture.wgsl', 'fixture');
    write(
      'node_modules/@forgeax/engine-vite-plugin-shader/package.json',
      '{"type":"module","exports":"./index.mjs"}',
    );
    write(
      'node_modules/@forgeax/engine-vite-plugin-shader/index.mjs',
      `
      export const forgeaxShader = ({engineEntries}) => {
        if (!engineEntries.pointShadows || !engineEntries.hdrpSsao) throw Error('profile pruned');
        return {name: 'fixture'};
      };
    `,
    );
    write('node_modules/vite/package.json', '{"type":"module","exports":"./index.mjs"}');
    write(
      'node_modules/vite/index.mjs',
      `
      import {getHeapStatistics} from 'node:v8';
      import {mkdirSync, writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      export async function build(options) {
        const expected = Number(process.env.FIXTURE_HEAP ?? '8192');
        if (getHeapStatistics().heap_size_limit < expected * 1024 * 1024) throw Error('inherited heap reached compiler');
        if (!process.execArgv.includes('--trace-warnings')) throw Error('lost parent options');
        if (process.env.FORGEAX_SHADER_COMPILE_WORKERS !== (process.env.FIXTURE_WORKERS ?? '2')) throw Error('unbounded compiler pool');
        const shaders = join(options.build.outDir, 'shaders');
        mkdirSync(shaders, {recursive: true});
        writeFileSync(join(shaders, 'manifest.json'), '{}');
      }
    `,
    );
    const environment = {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=128',
      FORGEAX_SHADER_COMPILE_WORKERS: '',
      FORGEAX_BUILD_NO_TASK_CACHE: '1',
    };
    const result = spawnSync(
      process.execPath,
      ['--trace-warnings', 'scripts/build-shared-inputs.mjs', '--out', 'fixture-output'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15000,
        env: environment,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(readFileSync(join(root, 'fixture-output/manifest.json'), 'utf8'));
    assert.equal(receipt.shaderBuild.fixture, true);
    const explicit = spawnSync(
      process.execPath,
      [
        '--trace-warnings',
        '--max-old-space-size=4096',
        'scripts/build-shared-inputs.mjs',
        '--out',
        'explicit-output',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...environment,
          FORGEAX_SHADER_COMPILE_WORKERS: '99',
          FIXTURE_HEAP: '4096',
          FIXTURE_WORKERS: '4',
        },
      },
    );
    assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
    assert.doesNotMatch(explicit.stdout, /source budget:/);
    const cached = spawnSync(
      process.execPath,
      ['scripts/build-shared-inputs.mjs', '--out', 'fixture-output'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15000,
        env: { ...environment, FORGEAX_BUILD_NO_TASK_CACHE: '0', FIXTURE_CACHE: '1' },
      },
    );
    assert.equal(cached.status, 0, cached.stdout + cached.stderr);
    assert.doesNotMatch(cached.stdout, /source budget:/);
    const fingerprint = spawnSync(
      process.execPath,
      ['scripts/build-shared-inputs.mjs', '--fingerprint'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15000,
        env: environment,
      },
    );
    assert.equal(fingerprint.status, 0, fingerprint.stderr);
    assert.equal(fingerprint.stdout.trim(), 'fixture-input');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
