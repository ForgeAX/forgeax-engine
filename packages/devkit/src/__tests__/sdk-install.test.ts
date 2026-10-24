// @perf-budget-skip: standalone npm-process and filesystem integration gate, not a hot path.
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileCommand } from '../child-process.js';
import { sdkInstallCommand } from '../sdk-install.js';
import { createUnifiedCommandContributions } from '../tools/unified-contributions.js';

const roots: string[] = [];
const originalClient = process.env.FORGEAX_NPM_CLIENT;
const originalFixture = process.env.FORGEAX_TEST_SDK_CARRIER;
const originalRegistry = process.env.npm_config_registry;

afterEach(async () => {
  if (originalClient === undefined) delete process.env.FORGEAX_NPM_CLIENT;
  else process.env.FORGEAX_NPM_CLIENT = originalClient;
  if (originalFixture === undefined) delete process.env.FORGEAX_TEST_SDK_CARRIER;
  else process.env.FORGEAX_TEST_SDK_CARRIER = originalFixture;
  if (originalRegistry === undefined) delete process.env.npm_config_registry;
  else process.env.npm_config_registry = originalRegistry;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-install-test-'));
  roots.push(root);
  const sdk = resolve(root, 'carrier');
  const client = resolve(root, process.platform === 'win32' ? 'npm-client.cmd' : 'npm-client');
  const clientScript = resolve(root, 'npm-client-fixture.mjs');
  await mkdir(resolve(sdk, 'bin'), { recursive: true });
  const engine = resolve(root, 'engine');
  await mkdir(engine);
  await writeFile(
    resolve(engine, 'package.json'),
    JSON.stringify({ name: '@forgeax/engine', version: '1.2.3' }),
  );
  const reused = [
    {
      path: 'source/engine/packages/math/dist/index.mjs',
      enginePath: 'node_modules/@forgeax/engine-math/dist/index.mjs',
      content: 'export const value = 137;\n',
    },
    {
      path: 'source/engine/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm',
      enginePath: 'node_modules/@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm_bg.wasm',
      content: '\0asm',
    },
  ];
  for (const entry of reused) {
    await mkdir(resolve(engine, entry.enginePath, '..'), { recursive: true });
    await writeFile(resolve(engine, entry.enginePath), entry.content);
  }
  const ignore = 'node_modules/\ndist/\n';
  const artifacts = ['source/engine/.gitignore', 'templates/empty/.gitignore'].map((path) => ({
    path,
    bytes: Buffer.byteLength(ignore),
    sha256: createHash('sha256').update(ignore).digest('hex'),
  }));
  for (const entry of artifacts) {
    await mkdir(resolve(sdk, entry.path, '..'), { recursive: true });
    await writeFile(resolve(sdk, entry.path), ignore);
  }
  await writeFile(
    resolve(sdk, 'sdk-manifest.json'),
    `${JSON.stringify({ sdkVersion: '1.2.3', source: { root: 'source/engine' }, artifacts: [...artifacts, ...reused.map(({ content, ...entry }) => ({ ...entry, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }))] })}\n`,
  );
  for (const path of [
    '.forgeax-public-distribution',
    'package.json',
    'pnpm-lock.yaml',
    'scripts/build.mjs',
  ]) {
    const target = resolve(sdk, 'source/engine', path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, path.endsWith('.json') ? '{}\n' : 'source input\n');
  }
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
      "await cp(resolve(source, '../engine'), resolve(args[prefixIndex + 1], 'node_modules/@forgeax/engine'), { recursive: true });",
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
    expect(JSON.parse(await readFile(resolve(target, 'sdk-manifest.json'), 'utf8'))).toMatchObject({
      sdkVersion: '1.2.3',
      source: { root: 'source/engine' },
    });
    expect(await readFile(resolve(target, 'source/engine/scripts/build.mjs'), 'utf8')).toBe(
      'source input\n',
    );
    expect(await readFile(resolve(target, 'bin', 'forgeax.mjs'), 'utf8')).toBe('export {};\n');
    expect((await readdir(root)).filter((name) => name.includes('forgeax-sdk-'))).toEqual([]);
  });

  it('materializes Engine baselines as independent writable source outputs', async () => {
    const root = await fixture();
    await chmod(resolve(root, 'engine/node_modules/@forgeax/engine-math/dist/index.mjs'), 0o755);
    const target = resolve(root, 'installed-sdk');
    expect((await sdkInstallCommand({ root: target, version: '1.2.3' })).ok).toBe(true);
    const output = resolve(target, 'source/engine/packages/math/dist/index.mjs');
    if (process.platform !== 'win32') expect((await stat(output)).mode & 0o111).toBe(0o111);
    expect(await readFile(output, 'utf8')).toBe('export const value = 137;\n');
    await writeFile(output, 'changed owner\n');
    expect(
      await readFile(
        resolve(root, 'engine/node_modules/@forgeax/engine-math/dist/index.mjs'),
        'utf8',
      ),
    ).toBe('export const value = 137;\n');
    expect(
      await readFile(
        resolve(target, 'source/engine/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm'),
        'utf8',
      ),
    ).toBe('\0asm');
  });

  it.each([
    'version',
    'bytes',
    'path',
  ])('rejects invalid Engine %s before adopting the SDK', async (invalid) => {
    const root = await fixture();
    const target = resolve(root, 'empty-sdk');
    await mkdir(target);
    if (invalid === 'version')
      await writeFile(
        resolve(root, 'engine/package.json'),
        JSON.stringify({ name: '@forgeax/engine', version: '1.2.4' }),
      );
    if (invalid === 'bytes')
      await writeFile(
        resolve(root, 'engine/node_modules/@forgeax/engine-math/dist/index.mjs'),
        'corrupt',
      );
    if (invalid === 'path') {
      const path = resolve(root, 'carrier/sdk-manifest.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.artifacts.find(
        (entry: { enginePath?: string }) => entry.enginePath !== undefined,
      ).enginePath = '../../outside';
      await writeFile(path, JSON.stringify(manifest));
    }
    expect(await sdkInstallCommand({ root: target, version: '1.2.3' })).toMatchObject({
      ok: false,
      error: { code: 'sdk-install-failed' },
    });
    expect(await readdir(target)).toEqual([]);
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

  it('rejects an SDK missing its source before adopting files into the target', async () => {
    const root = await fixture();
    const target = resolve(root, 'empty-sdk');
    await mkdir(target);
    await rm(resolve(root, 'carrier/source'), { recursive: true });
    expect(await sdkInstallCommand({ root: target, version: '1.2.3' })).toMatchObject({
      ok: false,
      error: { code: 'sdk-install-failed' },
    });
    expect(await readdir(target)).toEqual([]);
    expect((await readdir(root)).filter((name) => name.includes('forgeax-sdk-'))).toEqual([]);
  });

  it('rejects changed npm-renamed ignore bytes before adopting the SDK', async () => {
    const root = await fixture();
    const target = resolve(root, 'empty-sdk');
    await mkdir(target);
    await rm(resolve(root, 'carrier/source/engine/.gitignore'));
    await writeFile(resolve(root, 'carrier/source/engine/.npmignore'), 'corrupt\n');
    expect(await sdkInstallCommand({ root: target, version: '1.2.3' })).toMatchObject({
      ok: false,
      error: {
        code: 'sdk-install-failed',
        detail: { reason: 'sdk-carrier-artifact-mismatch: source/engine/.gitignore' },
      },
    });
    expect(await readdir(target)).toEqual([]);
  });

  it('installs a deduplicated carrier with exact Engine dependency through real npm', async () => {
    const root = await fixture();
    const packageRoot = resolve(root, 'packed/package');
    await mkdir(packageRoot, { recursive: true });
    await cp(resolve(root, 'carrier'), resolve(packageRoot, 'sdk'), { recursive: true });
    await writeFile(
      resolve(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-sdk',
        version: '1.2.3',
        dependencies: { '@forgeax/engine': '1.2.3' },
      }),
    );
    const archive = resolve(root, 'sdk.tgz');
    await execFileCommand('tar', ['-czf', archive, '-C', resolve(root, 'packed'), 'package']);
    const enginePack = resolve(root, 'packed-engine');
    await mkdir(enginePack);
    await cp(resolve(root, 'engine'), resolve(enginePack, 'package'), { recursive: true });
    const engineArchive = resolve(root, 'engine.tgz');
    await execFileCommand('tar', ['-czf', engineArchive, '-C', enginePack, 'package']);
    const tarballs = {
      '/sdk.tgz': await readFile(archive),
      '/engine.tgz': await readFile(engineArchive),
    };
    const registry = createServer((request, response) => {
      const path = decodeURIComponent(request.url ?? '');
      if (path === '/sdk.tgz' || path === '/engine.tgz') {
        response.end(tarballs[path]);
        return;
      }
      const name = path === '/@forgeax/engine-sdk' ? '@forgeax/engine-sdk' : '@forgeax/engine';
      const tarPath = name === '@forgeax/engine-sdk' ? '/sdk.tgz' : '/engine.tgz';
      const tarball = tarballs[tarPath];
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          name,
          versions: {
            '1.2.3': {
              name,
              version: '1.2.3',
              ...(name === '@forgeax/engine-sdk'
                ? { dependencies: { '@forgeax/engine': '1.2.3' } }
                : {}),
              dist: {
                tarball: `http://127.0.0.1:${(registry.address() as { port: number }).port}${tarPath}`,
                integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
              },
            },
          },
          'dist-tags': { latest: '1.2.3' },
        }),
      );
    });
    await once(registry.listen(0, '127.0.0.1'), 'listening');
    delete process.env.FORGEAX_NPM_CLIENT;
    process.env.npm_config_registry = `http://127.0.0.1:${(registry.address() as { port: number }).port}/`;
    try {
      const target = resolve(root, 'installed-sdk');
      expect(await sdkInstallCommand({ root: target, version: '1.2.3' })).toMatchObject({
        ok: true,
      });
      expect(
        await readFile(resolve(target, 'source/engine/packages/math/dist/index.mjs'), 'utf8'),
      ).toBe('export const value = 137;\n');
      expect(
        await readFile(
          resolve(target, 'source/engine/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm'),
          'utf8',
        ),
      ).toBe('\0asm');
      for (const path of ['source/engine/.gitignore', 'templates/empty/.gitignore']) {
        expect(await readFile(resolve(target, path), 'utf8')).toBe('node_modules/\ndist/\n');
        await expect(
          readFile(resolve(target, path.replace(/\.gitignore$/, '.npmignore'))),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await new Promise<void>((accept, reject) =>
        registry.close((error) => (error ? reject(error) : accept())),
      );
    }
  }, 30_000);
});

import { createHash } from 'node:crypto';
import { once } from 'node:events';
