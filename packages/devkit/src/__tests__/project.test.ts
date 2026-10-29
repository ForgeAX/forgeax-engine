import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandError, readProjectFacts, readProjectStartupTimeoutMs } from '../project.js';

const temporary: string[] = [];
const guid = '01900000-0000-7000-8000-000000000100';
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function project(fields: object = {}, packageFields: object = {}) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-project-')));
  temporary.push(root);
  await writeFile(
    resolve(root, 'forge.json'),
    JSON.stringify({ id: 'game', name: 'Game', schemaVersion: '3.0.0', roots: {}, ...fields }),
  );
  await writeFile(
    resolve(root, 'package.json'),
    JSON.stringify({ name: 'game', ...packageFields }),
  );
  return root;
}
describe('readProjectFacts', () => {
  it('uses the asset directories declared in forge.json', async () => {
    const assetRoots = ['content/art', 'shared'];
    expect(await readProjectFacts(await project({ assetRoots }))).toMatchObject({
      ok: true,
      value: { assetRoots },
    });
    for (const path of [
      '../outside',
      '/absolute',
      'C:/outside',
      'assets/../src',
      '.',
      'assets\\models',
    ]) {
      expect(await readProjectFacts(await project({ assetRoots: [path] }))).toMatchObject({
        ok: false,
        error: { code: 'project-manifest-invalid' },
      });
    }
  });
  it('reads root references without resolving or executing runtime code', async () => {
    const roots = { engine: guid, host: guid, build: guid };
    const root = await project({ roots });
    expect(await readProjectFacts(root)).toMatchObject({
      ok: true,
      value: { root, roots, assetRoots: ['assets'] },
    });
  });
  it('reads a project startup deadline from the ForgeaX package extension', async () => {
    const root = await project({}, { forgeax: { startupTimeoutMs: 120_000 } });
    expect(await readProjectFacts(root)).toMatchObject({
      ok: true,
      value: { startupTimeoutMs: 120_000 },
    });
    const unbounded = await project({}, { forgeax: { startupTimeoutMs: null } });
    expect(await readProjectFacts(unbounded)).toMatchObject({
      ok: true,
      value: { startupTimeoutMs: null },
    });
    expect(await readProjectStartupTimeoutMs(root)).toEqual({ ok: true, value: 120_000 });
    expect(await readProjectStartupTimeoutMs(unbounded)).toEqual({ ok: true, value: null });
  });
  it('validates the independent subsequent-frame deadline policy', async () => {
    for (const frameTimeoutMs of [null, 5000]) {
      expect(
        await readProjectFacts(await project({}, { forgeax: { frameTimeoutMs } })),
      ).toMatchObject({ ok: true, value: { frameTimeoutMs } });
    }
    for (const frameTimeoutMs of [0, -1, 1.5, 2_147_483_648, '2000']) {
      expect(
        await readProjectFacts(await project({}, { forgeax: { frameTimeoutMs } })),
      ).toMatchObject({ ok: false, error: { code: 'package-manifest-invalid' } });
    }
  });
  it('reads the point-shadow shader opt-in and rejects non-boolean values', async () => {
    expect(
      await readProjectFacts(await project({}, { forgeax: { pointShadows: true } })),
    ).toMatchObject({ ok: true, value: { pointShadows: true } });
    for (const forgeax of [{}, { pointShadows: false }]) {
      const facts = await readProjectFacts(await project({}, { forgeax }));
      expect(facts.ok && 'pointShadows' in facts.value).toBe(false);
    }
    expect(
      await readProjectFacts(await project({}, { forgeax: { pointShadows: 'yes' } })),
    ).toMatchObject({ ok: false, error: { code: 'package-manifest-invalid' } });
  });
  it('reads backend startup policy from a package root without forge.json', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-workspace-')));
    temporary.push(root);
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'workspace', forgeax: { startupTimeoutMs: null } }),
    );
    expect(await readProjectStartupTimeoutMs(root)).toEqual({ ok: true, value: null });
  });
  it('rejects an invalid project startup deadline before generating a Host', async () => {
    for (const startupTimeoutMs of [0, -1, 1.5, 2_147_483_648, '120000']) {
      const root = await project({}, { forgeax: { startupTimeoutMs } });
      expect(await readProjectFacts(root)).toMatchObject({
        ok: false,
        error: { code: 'package-manifest-invalid' },
      });
    }
  });
  it('canonicalizes symlinked paths before generating host paths', async () => {
    const root = await project();
    const parent = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-alias-')));
    temporary.push(parent);
    await symlink(root, resolve(parent, 'game'), 'dir');
    expect(await readProjectFacts(resolve(parent, 'game'))).toMatchObject({
      ok: true,
      value: { root: await realpath(root) },
    });
  });
  it('rejects the removed project authoring paths', async () => {
    for (const fields of [{ plugins: [] }, { defaultScene: guid }, { schemaVersion: '2.0.0' }]) {
      expect(await readProjectFacts(await project(fields))).toMatchObject({
        ok: false,
        error: { code: 'project-manifest-invalid' },
      });
    }
  });
  it('uses the fixed assets content root and supports an empty project', async () => {
    const root = await project();
    await mkdir(resolve(root, 'assets'));
    expect(await readProjectFacts(root)).toMatchObject({
      ok: true,
      value: { roots: {}, assetRoots: ['assets'] },
    });
  });
  it('ships game-3d with asset-owned host and engine roots', async () => {
    const result = await readProjectFacts(
      resolve(import.meta.dirname, '../../../../templates/game-3d'),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { roots: { frontend: expect.any(String), engine: expect.any(String) } },
    });
    if (result.ok) {
      expect(result.value).not.toHaveProperty('plugins');
      expect(result.value).not.toHaveProperty('defaultScene');
    }
  });
});

describe('commandError', () => {
  it('retains the original message after build-process Error serialization', () => {
    const cause = {
      name: 'TypeError',
      message: 'devkitAppOptions must contain only public project App options',
      stack: 'remote build stack',
    };
    expect(commandError(cause, 'game-build-failed')).toMatchObject({
      code: 'game-build-failed',
      detail: { reason: cause.message },
    });
    expect(commandError(new TypeError(cause.message), 'game-build-failed').detail).toEqual({
      reason: cause.message,
    });
  });
  it('preserves structured owner diagnostics and primitive fallback reasons', () => {
    const cause = {
      code: 'pack-parameter-invalid',
      expected: 'an authored module',
      hint: 'repair the source module',
      detail: { phase: 'module-load' },
    };
    expect(commandError(cause, 'game-build-failed')).toBe(cause);
    for (const value of [null, undefined, 0, 'build stopped', { message: 42 }])
      expect(commandError(value, 'game-build-failed').detail).toEqual({ reason: String(value) });
  });
});
