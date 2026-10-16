import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandInvocation, execFileCommand } from '../child-process.js';

describe('commandInvocation', () => {
  it('executes commands directly on POSIX platforms', () => {
    expect(commandInvocation('pnpm', ['install'], 'linux', 'ignored')).toEqual({
      file: 'pnpm',
      args: ['install'],
      options: {},
    });
  });

  it('routes Windows command shims through ComSpec', () => {
    expect(
      commandInvocation(
        'npm',
        ['install', '--prefix', 'C:\\Games\\ForgeaX Game'],
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
      ),
    ).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm', 'install', '--prefix', 'C:\\Games\\ForgeaX Game'],
      options: { windowsVerbatimArguments: false },
    });
  });

  it('executes a harmless Node command through the platform adapter', async () => {
    await expect(
      execFileCommand(process.execPath, [
        '-e',
        'process.stdout.write(process.argv[1])',
        'ForgeaX & Game',
      ]),
    ).resolves.toEqual({ stdout: 'ForgeaX & Game', stderr: '' });
  });

  it('reuses the owning pnpm entry without shell interpretation or a PATH shim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax pnpm entry '));
    try {
      const manager = join(root, 'pnpm.mjs');
      await writeFile(manager, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      const args = ['install', 'ForgeaX & Game', '100%', 'quote"value'];
      const result = await execFileCommand('pnpm', args, {
        env: { ...process.env, npm_execpath: manager },
      });
      expect(JSON.parse(result.stdout)).toEqual(args);
      expect(result.stderr).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'runs a no-shebang pnpm entry through the shell when needed',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-pnpm-entry-'));
      try {
        const pnpm = join(root, 'pnpm');
        await writeFile(pnpm, 'printf "%s\\n" "$1"\n');
        await chmod(pnpm, 0o755);

        await expect(execFileCommand(pnpm, ['pnpm & 12.10.1'])).resolves.toEqual({
          stdout: 'pnpm & 12.10.1\n',
          stderr: '',
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
