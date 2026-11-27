import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createVitest } from 'vitest/node';
import { DAWN_VITEST_CONFIG } from '../dawn-gate-roster.mjs';

test('native transforms reuse bytes while same-size source edits invalidate the real cache', async () => {
  const native = await createVitest('test', {
    config: resolve(DAWN_VITEST_CONFIG),
    project: ['dawn'],
    watch: false,
  });
  try {
    assert.equal(native.config.experimental.fsModuleCache, true);
    assert.equal(native.projects[0].config.experimental.fsModuleCache, true);
    const owned = resolve('node_modules/.vite/vitest-module-processes', String(process.pid));
    assert.equal(native.config.experimental.fsModuleCachePath, owned);
    assert.equal(native.projects[0].config.experimental.fsModuleCachePath, owned);
    await mkdir(owned, { recursive: true });
    const active = await mkdtemp(join(owned, 'active-transform-'));
    try {
      const transform = join(active, 'module');
      await writeFile(transform, 'active coordinator');
      const neighbor = spawnSync(
        process.execPath,
        [
          resolve('node_modules/vitest/vitest.mjs'),
          '--config',
          DAWN_VITEST_CONFIG,
          '--project',
          'dawn',
          '--clearCache',
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(neighbor.status, 0, neighbor.stdout + neighbor.stderr);
      assert.equal(await readFile(transform, 'utf8'), 'active coordinator');
    } finally {
      await rm(active, { recursive: true, force: true });
    }
  } finally {
    await native.close();
  }
  const root = await mkdtemp(join(tmpdir(), 'dawn-transform-cache-'));
  try {
    const vitest = pathToFileURL(resolve('node_modules/vitest/dist/index.js')).href;
    const config = join(root, 'vitest.config.mjs');
    const source = join(root, 'value.mjs');
    const consumer = join(root, 'consumer.test.mjs');
    await writeFile(
      config,
      `export default {test:{include:['consumer.test.mjs'],maxWorkers:1,experimental:{fsModuleCache:true}}};`,
    );
    await writeFile(source, 'export const value = 7;\n');
    const assertion = (value) =>
      `import {expect,it} from ${JSON.stringify(vitest)}; import {value} from './value.mjs'; it('checks current source',()=>expect(value).toBe(${value}));`;
    await writeFile(consumer, assertion(7));
    const execute = () =>
      spawnSync(
        process.execPath,
        [resolve('node_modules/vitest/vitest.mjs'), 'run', '--root', root, '--config', config],
        { cwd: root, encoding: 'utf8', timeout: 60_000 },
      );
    const cold = execute();
    assert.equal(cold.status, 0, cold.stdout + cold.stderr);
    const original = await stat(source);
    await writeFile(source, 'export const value = 8;\n');
    await utimes(source, original.atime, original.mtime);
    const changed = execute();
    assert.equal(changed.status, 1, changed.stdout + changed.stderr);
    assert.match(changed.stdout + changed.stderr, /expected 8 to be 7/);
    await writeFile(consumer, assertion(8));
    const updated = execute();
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.equal(await readFile(source, 'utf8'), 'export const value = 8;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shared transforms preserve fresh evaluation and exact V8 maps after uninstrumented reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitest-coverage-cache-'));
  try {
    await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    const config = join(root, 'vitest.config.mjs');
    const shared = pathToFileURL(resolve('config/vitest-shared.ts')).href;
    const vitest = pathToFileURL(resolve('node_modules/vitest/dist/index.js')).href;
    const source = join(root, 'value.mjs');
    await writeFile(
      source,
      `export const owner=process.pid; export function sign(v){return v>0?'yes':'no'} export function unused(){return 17}`,
    );
    await writeFile(
      join(root, 'consumer.test.mjs'),
      `import {expect,it} from ${JSON.stringify(vitest)}; import {owner,sign} from './value.mjs'; it('evaluates in this fresh process',()=>{expect(owner).toBe(process.pid);expect(sign(1)).toBe('yes');expect(sign(-1)).toBe('no')});`,
    );
    await writeFile(
      config,
      `import {sharedVitestConfig as shared} from ${JSON.stringify(shared)};
export default {
  ...shared,
  root: ${JSON.stringify(root)},
  test: {
    ...shared.test,
    include: ['consumer.test.mjs'],
    maxWorkers: 1,
    typecheck: {enabled: false},
    experimental: {
      ...shared.test.experimental,
      fsModuleCachePath: ${JSON.stringify(join(root, 'transforms'))}
    },
    coverage: {
      provider: 'v8',
      include: ['value.mjs'],
      reporter: ['json'],
      reportsDirectory: ${JSON.stringify(join(root, 'coverage'))},
      thresholds: {lines: 0, functions: 0}
    }
  }
};`,
    );
    const context = await createVitest('test', { config, watch: false });
    try {
      assert.equal(context.config.experimental.fsModuleCache, true);
    } finally {
      await context.close();
    }
    const execute = (coverage) =>
      spawnSync(
        process.execPath,
        [
          resolve('node_modules/vitest/vitest.mjs'),
          'run',
          '--root',
          root,
          '--config',
          config,
          `--coverage.enabled=${coverage}`,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
          env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
        },
      );
    const plain = execute(false);
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    const cold = execute(true);
    assert.equal(cold.status, 0, cold.stdout + cold.stderr);
    const first = JSON.parse(await readFile(join(root, 'coverage/coverage-final.json'), 'utf8'));
    const warm = execute(true);
    assert.equal(warm.status, 0, warm.stdout + warm.stderr);
    const second = JSON.parse(await readFile(join(root, 'coverage/coverage-final.json'), 'utf8'));
    assert.deepEqual(second, first);
    const actualSource = await realpath(source);
    assert.deepEqual(Object.keys(first), [actualSource]);
    const row = first[actualSource];
    const counts = Object.entries(row.fnMap).map(([id, fn]) => [fn.name, row.f[id]]);
    assert.deepEqual(counts, [
      ['sign', 2],
      ['unused', 0],
    ]);
    assert.ok(
      Object.values(row.b)
        .flat()
        .every((count) => count > 0),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
