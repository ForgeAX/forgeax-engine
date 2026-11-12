import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  downloadAsset,
  extractTarball,
  getReleaseAsset,
  getReleaseByTag,
} from '../lib/fetch-wasm-lib.mjs';

const ENV = { GITHUB_TOKEN: 'test-token' };
const RELEASE = {
  tag_name: 'wasm-artifacts',
  assets: [
    {
      id: 42,
      name: 'basis-wasm-pkg-abcdef01.tar.gz',
      url: 'https://api.github.com/repos/ForgeAX/forgeax-engine/releases/assets/42',
    },
  ],
};
const ASSET = {
  id: 42,
  name: 'basis-wasm-pkg-abcdef01.tar.gz',
  url: 'https://api.github.com/repos/ForgeAX/forgeax-engine/releases/assets/42',
};

const tempRoots = [];

async function tempFile(name = 'asset.tar.gz') {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-fetch-wasm-'));
  tempRoots.push(root);
  return join(root, name);
}

function tlsFailure() {
  return Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('fetch-wasm native transport fallback', () => {
  it('extracts a real archive with the host tar and replaces stale members', async () => {
    const archive = await tempFile('asset % archive.tar.gz');
    const root = dirname(archive);
    const source = join(root, 'source % files');
    const destination = join(root, 'pkg % output');
    await mkdir(source);
    await mkdir(destination);
    writeFileSync(join(source, 'payload.txt'), 'wasm package payload');
    writeFileSync(join(destination, 'stale.txt'), 'previous publication');
    execFileSync('tar', ['-czf', './asset % archive.tar.gz', '-C', source, 'payload.txt'], {
      cwd: root,
    });
    await extractTarball(archive, destination);
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('wasm package payload');
    await expect(readFile(join(destination, 'stale.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('recovers release metadata through gh when Node fetch fails at TLS', async () => {
    const calls = [];
    const logs = [];
    const release = await getReleaseByTag('ForgeAX', 'forgeax-engine', 'wasm-artifacts', {
      pkgLabel: 'codec',
      buildHint: 'pnpm -F @forgeax/engine-codec build:wasm',
      env: ENV,
      platform: 'win32',
      fetchImpl: vi.fn(async () => {
        throw tlsFailure();
      }),
      commandRunner: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: JSON.stringify(RELEASE), stderr: '' };
      },
      log: (message) => logs.push(message),
    });

    expect(release).toEqual(RELEASE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: 'gh',
      args: [
        'api',
        'repos/ForgeAX/forgeax-engine/releases/tags/wasm-artifacts',
        '--header',
        'Accept: application/vnd.github+json',
      ],
    });
    expect(logs[0]).toMatch(/TLS.*gh api/);
  });

  it('uses curl.exe for release metadata when gh is unavailable', async () => {
    const calls = [];
    const release = await getReleaseByTag('ForgeAX', 'forgeax-engine', 'wasm-artifacts', {
      pkgLabel: 'codec',
      buildHint: 'build locally',
      env: ENV,
      platform: 'win32',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      commandRunner: (command, args) => {
        calls.push({ command, args });
        if (command === 'gh')
          return { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } };
        return { status: 0, stdout: `${JSON.stringify(RELEASE)}\n200`, stderr: '' };
      },
      log: () => {},
    });

    expect(release).toEqual(RELEASE);
    expect(calls.map(({ command }) => command)).toEqual(['gh', 'curl.exe']);
    expect(calls[1].args).toContain('Authorization: Bearer test-token');
  });

  it('resolves the exact release asset through the shared asset boundary', async () => {
    const asset = await getReleaseAsset(
      'ForgeAX',
      'forgeax-engine',
      'wasm-artifacts',
      ASSET.name,
      {
        pkgLabel: 'codec',
        buildHint: 'build locally',
        env: ENV,
        fetchImpl: async () => ({
          status: 200,
          ok: true,
          json: async () => RELEASE,
        }),
      },
    );

    expect(asset).toEqual(RELEASE.assets[0]);
  });

  it('reports a content-key mismatch from the shared asset boundary', async () => {
    await expect(
      getReleaseAsset('ForgeAX', 'forgeax-engine', 'wasm-artifacts', 'missing.tar.gz', {
        pkgLabel: 'codec',
        buildHint: 'build locally',
        env: ENV,
        fetchImpl: async () => ({
          status: 200,
          ok: true,
          json: async () => RELEASE,
        }),
      }),
    ).rejects.toMatchObject({ code: 'E4_HASH_MISMATCH' });
  });

  it('downloads an asset through gh with the exact repository, tag, and asset name', async () => {
    const destPath = await tempFile();
    const calls = [];
    await downloadAsset(ASSET, destPath, {
      owner: 'ForgeAX',
      repo: 'forgeax-engine',
      tag: 'wasm-artifacts',
      pkgLabel: 'codec',
      buildHint: 'build locally',
      env: ENV,
      platform: 'win32',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      commandRunner: (command, args) => {
        calls.push({ command, args });
        const outputPath = args[args.indexOf('--output') + 1];
        writeFileSync(outputPath, 'tarball');
        return { status: 0, stdout: '', stderr: '' };
      },
      log: () => {},
    });

    expect(await readFile(destPath, 'utf8')).toBe('tarball');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: 'gh',
      args: [
        'release',
        'download',
        'wasm-artifacts',
        '--repo',
        'ForgeAX/forgeax-engine',
        '--pattern',
        ASSET.name,
        '--output',
        destPath,
        '--clobber',
      ],
    });
  });

  it('uses curl.exe for the API asset endpoint when gh download fails', async () => {
    const destPath = await tempFile();
    const calls = [];
    await downloadAsset(ASSET, destPath, {
      owner: 'ForgeAX',
      repo: 'forgeax-engine',
      tag: 'wasm-artifacts',
      pkgLabel: 'codec',
      buildHint: 'build locally',
      env: ENV,
      platform: 'win32',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      commandRunner: (command, args) => {
        calls.push({ command, args });
        if (command === 'gh') return { status: 1, stdout: '', stderr: 'gh failed' };
        writeFileSync(args[args.indexOf('--output') + 1], 'tarball');
        return { status: 0, stdout: '200', stderr: '' };
      },
      log: () => {},
    });

    expect(await readFile(destPath, 'utf8')).toBe('tarball');
    expect(calls.map(({ command }) => command)).toEqual(['gh', 'curl.exe']);
    expect(calls[1].args).toContain(
      'https://api.github.com/repos/ForgeAX/forgeax-engine/releases/assets/42',
    );
  });

  it('reports TLS and exhausted native transports instead of saying only offline', async () => {
    await expect(
      getReleaseByTag('ForgeAX', 'forgeax-engine', 'wasm-artifacts', {
        pkgLabel: 'codec',
        buildHint: 'build locally',
        env: ENV,
        platform: 'win32',
        fetchImpl: async () => {
          throw tlsFailure();
        },
        commandRunner: (command) =>
          command === 'gh'
            ? { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } }
            : { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } },
        log: () => {},
      }),
    ).rejects.toMatchObject({
      code: 'E1_NETWORK',
      hint: expect.stringMatching(/TLS|certificate/),
    });

    await expect(
      getReleaseByTag('ForgeAX', 'forgeax-engine', 'wasm-artifacts', {
        pkgLabel: 'codec',
        buildHint: 'build locally',
        env: ENV,
        platform: 'win32',
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
        commandRunner: (command) =>
          command === 'gh'
            ? { status: 1, stdout: '', stderr: 'gh: Forbidden (HTTP 403)' }
            : { status: 22, stdout: 'forbidden\n403', stderr: '' },
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'E5_AUTH_FAILED' });
  });

  it('keeps HTTP 404 on the Node path as E2 without invoking native transports', async () => {
    const commandRunner = vi.fn();
    await expect(
      getReleaseByTag('ForgeAX', 'forgeax-engine', 'wasm-artifacts', {
        pkgLabel: 'codec',
        buildHint: 'build locally',
        env: ENV,
        fetchImpl: async () => ({ status: 404, ok: false, statusText: 'Not Found' }),
        commandRunner,
      }),
    ).rejects.toMatchObject({ code: 'E2_ASSET_NOT_FOUND' });
    expect(commandRunner).not.toHaveBeenCalled();
  });
});
