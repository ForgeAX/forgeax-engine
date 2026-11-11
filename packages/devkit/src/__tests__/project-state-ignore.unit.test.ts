import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ignoreProjectState, PROJECT_STATE_GITIGNORE } from '../project-state-ignore.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-state-ignore-'));
  roots.push(root);
  return root;
}

it('keeps the state directory out of git even when the project ignores nothing', async () => {
  const root = await tempRoot();
  await mkdir(join(root, '.forgeax', 'ddc'), { recursive: true });
  await writeFile(join(root, '.forgeax', 'ddc', 'entry.bin'), 'cache');
  await writeFile(join(root, 'game.ts'), 'export {};\n');
  expect(await ignoreProjectState(root)).toBe(true);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  git('init', '--quiet');
  expect(git('status', '--porcelain', '--untracked-files=all').trim()).toBe('?? game.ts');
});

it('never creates the directory or replaces an existing ignore file', async () => {
  const root = await tempRoot();
  expect(await ignoreProjectState(root)).toBe(false);
  await expect(readFile(join(root, '.forgeax', '.gitignore'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await mkdir(join(root, '.forgeax'));
  await writeFile(join(root, '.forgeax', '.gitignore'), 'custom\n');
  expect(await ignoreProjectState(root)).toBe(false);
  expect(await readFile(join(root, '.forgeax', '.gitignore'), 'utf8')).toBe('custom\n');
  expect(PROJECT_STATE_GITIGNORE.split('\n')).toContain('*');
});
