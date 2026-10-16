// @perf-budget-skip: standalone npm-process and filesystem integration gate, not a hot path.
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sdkInstallCommand } from '../sdk-install.js';
import { createUnifiedCommandContributions } from '../tools/unified-contributions.js';

const roots: string[] = [];
const originalClient = process.env.FORGEAX_NPM_CLIENT;
const originalFixture = process.env.FORGEAX_TEST_SDK_CARRIER;

afterEach(async () => {
  process.env.FORGEAX_NPM_CLIENT = originalClient;
  process.env.FORGEAX_TEST_SDK_CARRIER = originalFixture;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-install-test-'));
  roots.push(root);
  const sdk = resolve(root, 'carrier');
  const client = resolve(root, process.platform === 'win32' ? 'npm-client.cmd' : 'npm-client');
  const clientScript = resolve(root, 'npm-client-fixture.mjs');
  await mkdir(resolve(sdk, 'bin'), { recursive: true });
  await writeFile(
    resolve(sdk, 'sdk-manifest.json'),
    `${JSON.stringify({ sdkVersion: '1.2.3' })}\n`,
  );
  await writeFile(resolve(sdk, 'bin', 'forgeax.mjs'), 'export {};\n');
  await writeFile(
    clientScript,
    `${[
      "import { cp, link, mkdir, readdir, symlink } from 'node:fs/promises';",
      "import { resolve } from 'node:path';",
      'const args = process.argv.slice(2);',
      "const prefixIndex = args.indexOf('--prefix');",
      "if (prefixIndex < 0 || !args[prefixIndex + 1]) throw new Error('missing --prefix');",
      "const target = resolve(args[prefixIndex + 1], 'node_modules', '@forgeax', 'engine-sdk', 'sdk');",
      'await mkdir(target, { recursive: true });',
      'const source = process.env.FORGEAX_TEST_SDK_CARRIER;',
      "if (!source) throw new Error('missing FORGEAX_TEST_SDK_CARRIER');",
      'for (const entry of await readdir(source)) {',
      '  await cp(resolve(source, entry), resolve(target, entry), { recursive: true });',
      '}',
      "await link(resolve(target, 'bin/forgeax.mjs'), resolve(target, 'bin/forgeax-linked.mjs'));",
      "if (process.platform !== 'win32') await symlink('forgeax.mjs', resolve(target, 'bin/forgeax-alias.mjs'));",
    ].join('\n')}\n`,
  );
  if (process.platform === 'win32') {
    await writeFile(client, `@echo off\r\n"${process.execPath}" "${clientScript}" %*\r\n`);
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      client,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(clientScript)} "$@"\n`,
    );
    await chmod(client, 0o755);
  }
  process.env.FORGEAX_NPM_CLIENT = client;
  process.env.FORGEAX_TEST_SDK_CARRIER = sdk;
  return root;
}

describe('sdkInstallCommand', () => {
  it('loads the SDK installer without importing the full DevKit command bundle', async () => {
    const root = await fixture();
    const target = resolve(root, 'installed-sdk');
    vi.doMock('../commands.js', () => {
      throw new Error('sdk install imported the full DevKit command bundle');
    });

    try {
      const contribution = createUnifiedCommandContributions(root).find(
        (entry) => entry.descriptor.id === 'sdk.install',
      );
      expect(contribution).toBeDefined();
      await expect(
        contribution?.execute({ root: target, version: '1.2.3' }, {} as never),
      ).resolves.toMatchObject({ ok: true, value: { root: target, sdkVersion: '1.2.3' } });
    } finally {
      vi.doUnmock('../commands.js');
    }
  });

  it('installs an exact npm SDK carrier into an absent target', async () => {
    const root = await fixture();
    const target = resolve(root, 'installed-sdk');

    const result = await sdkInstallCommand({ root: target, version: '1.2.3' });

    expect(result).toEqual({
      ok: true,
      value: {
        root: target,
        sdkVersion: '1.2.3',
        source: '@forgeax/engine-sdk',
        next: { cwd: target, argv: ['node', './bin/forgeax.mjs', 'project', 'init'] },
      },
    });
    expect(JSON.parse(await readFile(resolve(target, 'sdk-manifest.json'), 'utf8'))).toEqual({
      sdkVersion: '1.2.3',
    });
    expect(await readFile(resolve(target, 'bin', 'forgeax.mjs'), 'utf8')).toBe('export {};\n');
    expect((await readdir(root)).filter((name) => name.includes('forgeax-sdk-'))).toEqual([]);
  });

  it('does not overwrite a non-empty directory', async () => {
    const root = await fixture();
    const target = resolve(root, 'existing');
    await mkdir(target);
    await writeFile(resolve(target, 'keep.txt'), 'keep\n');

    const result = await sdkInstallCommand({ root: target, version: '1.2.3' });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sdk-target-not-empty' }),
    });
    expect(await readFile(resolve(target, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('preserves carrier hard links and relative links when installing into an empty target', async () => {
    const root = await fixture();
    const target = resolve(root, 'empty-sdk');
    await mkdir(target);

    expect((await sdkInstallCommand({ root: target, version: '1.2.3' })).ok).toBe(true);
    const entry = resolve(target, 'bin/forgeax.mjs');
    const linked = resolve(target, 'bin/forgeax-linked.mjs');
    const [entryStat, linkedStat] = await Promise.all([stat(entry), stat(linked)]);
    expect([linkedStat.dev, linkedStat.ino]).toEqual([entryStat.dev, entryStat.ino]);
    expect(entryStat.nlink).toBe(2);
    expect(await readFile(linked, 'utf8')).toBe('export {};\n');
    if (process.platform !== 'win32') {
      const alias = resolve(target, 'bin/forgeax-alias.mjs');
      expect(await readlink(alias)).toBe('forgeax.mjs');
      expect(await readFile(alias, 'utf8')).toBe('export {};\n');
    }
    expect((await readdir(root)).filter((name) => name.includes('forgeax-sdk-'))).toEqual([]);
  });

  it('rejects a mismatched carrier before publishing any entries', async () => {
    const root = await fixture();
    const target = resolve(root, 'empty-sdk');
    await mkdir(target);

    expect(await sdkInstallCommand({ root: target, version: '1.2.4' })).toMatchObject({
      ok: false,
      error: { code: 'sdk-install-failed' },
    });
    expect(await readdir(target)).toEqual([]);
    expect((await readdir(root)).filter((name) => name.includes('forgeax-sdk-'))).toEqual([]);
  });
});
