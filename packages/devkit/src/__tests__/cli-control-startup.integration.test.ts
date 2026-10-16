import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each([
  {
    label: 'existing dev controls',
    commands: [
      ['dev', 'status'],
      ['help', 'dev', 'start'],
    ],
  },
  {
    label: 'backend controls',
    commands: [
      ['backend', 'status'],
      ['backend', 'stop'],
      ['help', 'backend', 'start'],
    ],
  },
])('runs the published CLI $label without activating browser or build producers', async ({
  commands,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-cli-control-'));
  try {
    const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
    const observer = new URL('./fixtures/cli-owner-imports.mjs', import.meta.url).href;
    for (const args of commands) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--import', observer, cli, ...args, '--root', root, '--json'],
        { cwd: root, env: { ...process.env, FORGEAX_RUNS_DIR: join(root, 'runs') } },
      );
      const result = JSON.parse(stdout);
      expect(result.ok).toBe(true);
      if (args[0] !== 'help') expect(result.value.phase).toBe('stopped');
      else expect(result.value).toMatchObject({ path: args.slice(1).join(' ') });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a replaced daemon claim before activating its build owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-cli-invalid-claim-'));
  try {
    const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
    const observer = new URL('./fixtures/cli-owner-imports.mjs', import.meta.url).href;
    await expect(
      promisify(execFile)(
        process.execPath,
        ['--import', observer, cli, '--__forgeax-backend', root, 'replaced-claim'],
        { cwd: root },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Backend startup claim was replaced'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
