import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sdkBuildEnvironment } from '../sdk-build-environment.mjs';

test('SDK build children inherit the runner heap and bounded compiler workers', () => {
  const environment = sdkBuildEnvironment(
    {
      ...process.env,
      NODE_OPTIONS: '--trace-warnings --max-old-space-size=128',
      FORGEAX_SHADER_COMPILE_WORKERS: undefined,
      FORGEAX_CANONICAL_KIT_OUTPUT: 'selected-kit',
    },
    { cpus: 8, memoryBytes: 16 * 1024 ** 3 },
  );
  const observation = `
    import {getHeapStatistics} from 'node:v8';
    console.log(JSON.stringify({
      heap: getHeapStatistics().heap_size_limit / 1024 ** 2,
      workers: process.env.FORGEAX_SHADER_COMPILE_WORKERS,
      kit: process.env.FORGEAX_CANONICAL_KIT_OUTPUT,
      options: process.env.NODE_OPTIONS,
    }));
  `;
  const launcher = `
    import {spawnSync} from 'node:child_process';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(observation)}],
      {env: process.env, encoding: 'utf8'});
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', launcher], {
    env: environment,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const actual = JSON.parse(child.stdout);
  assert.ok(actual.heap >= 8192 && actual.heap < 8704, child.stdout);
  assert.equal(actual.workers, '7');
  assert.equal(actual.kit, 'selected-kit');
  assert.match(actual.options, /--trace-warnings/);
});

test('SDK build compiler workers honor an explicit lower limit', () => {
  const environment = sdkBuildEnvironment(
    { ...process.env, FORGEAX_SHADER_COMPILE_WORKERS: '2' },
    { cpus: 64, memoryBytes: 128 * 1024 ** 3 },
  );
  assert.equal(environment.FORGEAX_SHADER_COMPILE_WORKERS, '2');
});

test('SDK production uses the budget on its actual Engine child', () => {
  const source = readFileSync(new URL('../build-sdk.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /await run\('pnpm', \['build:engine'\], \{[\s\S]*?\.\.\.sdkBuildEnvironment\(\)/,
  );
  const publicationStage = source.slice(
    source.indexOf("for (const profile of ['base-ssao', 'point-ssao'])"),
    source.indexOf('const publicPackages = []'),
  );
  assert.match(publicationStage, /'--expose-gc'/);
  assert.match(publicationStage, /'scripts\/forgeax\/check-shader-publication\.mjs'/);
  assert.doesNotMatch(publicationStage, /--max-old-space-size/);
  assert.match(publicationStage, /env: sdkBuildEnvironment\(\)/);
});

test('publication validation receives the bounded runner heap without dropping inherited options', () => {
  for (const [memoryGiB, heapMiB] of [
    [8, 4096],
    [16, 8192],
    [128, 24576],
  ]) {
    const child = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        '--input-type=module',
        '-e',
        `
      import {getHeapStatistics} from 'node:v8';
      console.log(JSON.stringify({heapMiB: getHeapStatistics().heap_size_limit / 1024 ** 2,
        gc: typeof globalThis.gc, options: process.env.NODE_OPTIONS}));
    `,
      ],
      {
        env: sdkBuildEnvironment(
          { ...process.env, NODE_OPTIONS: '--trace-warnings --max-old-space-size=512' },
          { cpus: 8, memoryBytes: memoryGiB * 1024 ** 3 },
        ),
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const actual = JSON.parse(child.stdout);
    assert.ok(actual.heapMiB >= heapMiB && actual.heapMiB < heapMiB + 512, child.stdout);
    assert.equal(actual.gc, 'function');
    assert.match(actual.options, /--trace-warnings/);
  }
});
