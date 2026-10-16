import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sdkInstaller = vi.hoisted(() =>
  vi.fn(async (options: unknown) => ({ ok: true, value: options })),
);

vi.mock('../commands.js', () => {
  throw new Error('sdk-install-loaded-command-barrel');
});
vi.mock('../sdk-install.js', () => ({ sdkInstallCommand: sdkInstaller }));

import { runUnifiedCli } from '../unified-cli.js';

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
  sdkInstaller.mockClear();
});

describe('SDK command module loading', () => {
  it('loads the SDK installer without the Vite and Vitest command barrel', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-command-loading-'));
    await writeFile(join(root, 'package.json'), '{"name":"sdk-command-loading","type":"module"}\n');
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        id: 'sdk-command-loading',
        name: 'SDK command loading',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );

    const result = await runUnifiedCli([
      'sdk',
      'install',
      '--root',
      root,
      '--version',
      '1.2.3',
      '--json',
    ]);

    expect(result.ok).toBe(true);
    expect(sdkInstaller).toHaveBeenCalledWith({ root, version: '1.2.3' });
  });
});
