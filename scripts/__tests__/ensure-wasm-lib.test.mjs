import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureWasm } from '../lib/ensure-wasm-lib.mjs';

const tempRoots = [];

async function tempPkgDir() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-ensure-wasm-'));
  tempRoots.push(root);
  const pkg = join(root, 'pkg');
  await mkdir(pkg);
  return pkg;
}

const CFG = {
  pkgLabel: 'fbx',
  skipEnv: 'FORGEAX_SKIP_FBX_WASM_FETCH',
  fetchScript: '/fixture/fetch-wasm.mjs',
  buildHint: 'pnpm -F @forgeax/engine-fbx fetch-wasm',
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ensureWasm (shared lib)', () => {
  it('skips fetching when every presence marker exists', async () => {
    const pkg = await tempPkgDir();
    await Promise.all([writeFile(join(pkg, 'a.wasm'), ''), writeFile(join(pkg, 'b.wasm'), '')]);
    const spawn = vi.fn();
    const log = vi.fn();

    expect(
      ensureWasm({
        ...CFG,
        presenceMarkers: [join(pkg, 'a.wasm'), join(pkg, 'b.wasm')],
        spawn,
        log,
      }),
    ).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already present'));
  });

  it('honors the explicit fetch opt-out before starting a child process', async () => {
    const pkg = await tempPkgDir();
    const spawn = vi.fn();
    const log = vi.fn();

    expect(
      ensureWasm({
        ...CFG,
        presenceMarkers: [join(pkg, 'missing.wasm')],
        env: { FORGEAX_SKIP_FBX_WASM_FETCH: '1' },
        spawn,
        log,
      }),
    ).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('FORGEAX_SKIP_FBX_WASM_FETCH'));
  });

  it('invokes the fetcher when a marker is missing', async () => {
    const pkg = await tempPkgDir();
    await writeFile(join(pkg, 'a.wasm'), '');
    const spawn = vi.fn(() => ({ status: 0 }));

    expect(
      ensureWasm({
        ...CFG,
        presenceMarkers: [join(pkg, 'a.wasm'), join(pkg, 'missing.wasm')],
        env: {},
        spawn,
        log: vi.fn(),
      }),
    ).toBe(0);
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['/fixture/fetch-wasm.mjs'], {
      stdio: 'inherit',
    });
  });

  it('invokes the fetcher when markers exist but freshness validation rejects the bundle', async () => {
    const pkg = await tempPkgDir();
    await Promise.all([writeFile(join(pkg, 'a.wasm'), ''), writeFile(join(pkg, 'b.wasm'), '')]);
    const spawn = vi.fn(() => ({ status: 0 }));
    const log = vi.fn();

    expect(
      ensureWasm({
        ...CFG,
        presenceMarkers: [join(pkg, 'a.wasm'), join(pkg, 'b.wasm')],
        ready: false,
        env: {},
        spawn,
        log,
      }),
    ).toBe(0);
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['/fixture/fetch-wasm.mjs'], {
      stdio: 'inherit',
    });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('already present'));
  });

  it('keeps installation successful when fetching fails', async () => {
    const pkg = await tempPkgDir();
    const log = vi.fn();

    expect(
      ensureWasm({
        ...CFG,
        presenceMarkers: [join(pkg, 'missing.wasm')],
        env: {},
        spawn: vi.fn(() => ({ status: 1 })),
        log,
      }),
    ).toBe(0);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining('pnpm -F @forgeax/engine-fbx fetch-wasm'),
    );
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('OS-native fallbacks'));
  });

  it('keeps stale bundles uncertified when the replacement fetch is unavailable', async () => {
    const pkg = await tempPkgDir();
    await Promise.all([writeFile(join(pkg, 'a.wasm'), ''), writeFile(join(pkg, 'b.wasm'), '')]);
    const log = vi.fn();

    expect(
      ensureWasm({
        ...CFG,
        presenceMarkers: [join(pkg, 'a.wasm'), join(pkg, 'b.wasm')],
        ready: false,
        env: {},
        spawn: vi.fn(() => ({ status: 1 })),
        log,
      }),
    ).toBe(0);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('already present'));
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining('pnpm -F @forgeax/engine-fbx fetch-wasm'),
    );
  });
});

describe('Codec postinstall bundle completeness', () => {
  it.each([
    'basis_transcoder.mjs',
    'encode/basis_encoder.mjs',
  ])('fetches a WASM-only partial bundle missing %s, then skips a complete bundle', async (missingGlue) => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-codec-ensure-'));
    tempRoots.push(root);
    const scripts = join(root, 'packages/codec/scripts');
    const pkg = join(root, 'packages/codec/pkg');
    await mkdir(scripts, { recursive: true });
    await mkdir(join(pkg, 'encode'), { recursive: true });
    await mkdir(join(root, 'scripts/lib'), { recursive: true });
    await copyFile(
      fileURLToPath(new URL('../../packages/codec/scripts/ensure-wasm.mjs', import.meta.url)),
      join(scripts, 'ensure-wasm.mjs'),
    );
    await copyFile(
      fileURLToPath(new URL('../lib/ensure-wasm-lib.mjs', import.meta.url)),
      join(root, 'scripts/lib/ensure-wasm-lib.mjs'),
    );
    const receipt = join(root, 'fetch-receipt');
    await writeFile(
      join(scripts, 'fetch-wasm.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CODEC_TEST_RECEIPT, 'fetched');`,
    );
    for (const file of [
      'basis_transcoder.mjs',
      'basis_transcoder.wasm',
      'encode/basis_encoder.mjs',
      'encode/basis_encoder.wasm',
    ]) {
      if (file !== missingGlue) await writeFile(join(pkg, file), 'fixture');
    }
    const env = { ...process.env, CODEC_TEST_RECEIPT: receipt };
    delete env.FORGEAX_SKIP_CODEC_WASM_FETCH;
    const run = () =>
      spawnSync(process.execPath, [join(scripts, 'ensure-wasm.mjs')], {
        env,
        encoding: 'utf8',
        timeout: 5000,
      });
    const partial = run();
    expect(partial.status).toBe(0);
    expect(partial.stdout).toContain('fetching pre-built WASM');
    expect(await readFile(receipt, 'utf8')).toBe('fetched');
    await rm(receipt);
    await writeFile(join(pkg, missingGlue), 'fixture');
    const complete = run();
    expect(complete.status).toBe(0);
    expect(complete.stdout).toContain('already present');
    await expect(readFile(receipt, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
