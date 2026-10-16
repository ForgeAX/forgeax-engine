import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps a complete existing facade readable during rebuilds and removes retired facades', async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const root = await mkdtemp(join(tmpdir(), 'facade-publication-'));
  try {
    await mkdir(join(root, 'packages/engine/scripts'), { recursive: true });
    await mkdir(join(root, 'packages/ecs/dist'), { recursive: true });
    for (const file of ['build.mjs', 'public-facades.mjs'])
      await copyFile(join(repository, 'packages/engine/scripts', file), join(root, 'packages/engine/scripts', file));
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(join(root, 'packages/engine/package.json'), JSON.stringify({ dependencies: { '@forgeax/engine-ecs': '0.0.0' } }));
    await writeFile(join(root, 'packages/ecs/package.json'), JSON.stringify({ name: '@forgeax/engine-ecs', exports: { '.': './dist/index.mjs' } }));
    await writeFile(join(root, 'packages/ecs/dist/index.mjs'), 'export const proof=1;');
    const build = () => new Promise((done, reject) => {
      const child = spawn(process.execPath, [join(root, 'packages/engine/scripts/build.mjs')]);
      let error = '';
      child.stderr.on('data', (chunk) => { error += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? done() : reject(new Error(error)));
    });
    await build();
    const target = join(root, 'packages/engine/dist/facades/ecs.mjs');
    const expected = await readFile(target, 'utf8');
    const retired = join(root, 'packages/engine/dist/facades/retired.mjs');
    await writeFile(retired, 'retired');
    let stop = false;
    let reads = 0;
    const failures = [];
    const reader = (async () => {
      while (!stop) {
        try {
          const content = await readFile(target, 'utf8');
          if (content !== expected) failures.push('partial content');
        } catch (error) { failures.push(error.code); }
        reads++;
      }
    })();
    try { for (let i = 0; i < 5; i++) await build(); }
    finally { stop = true; await reader; }
    expect(reads).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    await expect(readFile(retired)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
