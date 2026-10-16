import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { installProjectSkills } from '../skill-install.js';

it('keeps the real project test reporter and test console off JSON stdout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-test-output-'));
  try {
    await symlink(
      fileURLToPath(new URL('../../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      'dir',
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'test-output', type: 'module' }),
    );
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'test-output',
        name: 'Test output',
        roots: {},
      }),
    );
    await writeFile(
      join(root, 'example.test.js'),
      "import { it } from 'vitest'; it('real user test', () => { console.log('test diagnostic'); });",
    );
    const result = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url)),
        'project',
        'test',
        '--root',
        root,
        '--json',
      ],
      { env: { ...process.env, FORGEAX_DISABLE_UPDATE_CHECK: '1' } },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: 'project test' });
    expect(result.stderr).toContain('test diagnostic');
    expect(result.stderr).toContain('passed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('keeps installed skill tests outside the game while retaining adjacent tests and project exclusions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-test-skills-'));
  const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
  const run = () =>
    promisify(execFile)(process.execPath, [cli, 'project', 'test', '--root', root, '--json'], {
      env: { ...process.env, FORGEAX_DISABLE_UPDATE_CHECK: '1' },
    });
  try {
    await symlink(
      fileURLToPath(new URL('../../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      'dir',
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'test-skills', type: 'module' }),
    );
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({ schemaVersion: '3.0.0', id: 'test-skills', name: 'Test skills', roots: {} }),
    );
    const skill = join(root, 'skills/forgeax-engine-fixture');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '# Engine tool fixture\n');
    await writeFile(
      join(skill, 'tool.test.mjs'),
      "throw new Error('installed tool is not a game test');",
    );
    await installProjectSkills(root);
    await writeFile(
      join(root, 'vitest.config.mjs'),
      "export default { test: { exclude: ['**/node_modules/**', 'excluded.test.mjs'] } };",
    );
    await writeFile(
      join(root, 'excluded.test.mjs'),
      "throw new Error('project exclusion was lost');",
    );
    const gameTest = join(root, 'skills/gameplay.test.mjs');
    await writeFile(
      gameTest,
      "import { it } from 'vitest'; it('game skill logic', () => console.log('game skill executed'));",
    );
    await writeFile(
      join(root, '.claude/game.test.mjs'),
      "import { it } from 'vitest'; it('adjacent game logic', () => console.log('adjacent test executed'));",
    );
    const result = await run();
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: 'project test' });
    expect(result.stderr).toContain('game skill executed');
    expect(result.stderr).toContain('adjacent test executed');
    await writeFile(
      gameTest,
      "import { it, expect } from 'vitest'; it('game regression', () => expect(1).toBe(2));",
    );
    await expect(run()).rejects.toMatchObject({
      stdout: expect.stringContaining('project-tests-failed'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
