import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { brotliDecompressSync } from 'node:zlib';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { expect, it } from 'vitest';
import { verifyDist, writeDistManifest } from '../../dist.js';
import type { ProjectFacts } from '../../types.js';
import { prepareWechatBuild, verifyWechatPackageBudget, writeWechatProject } from '../wechat.js';

it.each([
  undefined,
  256 * 1024 * 1024,
])('passes the projected native mesh budget %s to the actual Renderer owner', async (budget) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-wechat-app-options-'));
  try {
    await prepareWechatBuild(
      { name: 'Native App options', roots: {} } as ProjectFacts,
      root,
      {
        assets: new Map(),
        deferred: [],
        sourceInputs: new Map(),
        sourceSnapshot: createScriptablePackSourceSnapshot(),
        filesystemInputs: undefined,
      },
      budget === undefined ? {} : { dynamicGeometryMeshBudgetBytes: budget },
    );
    const source = await readFile(resolve(root, 'wechat-main.ts'), 'utf8');
    const call = source.slice(
      source.indexOf('graphics = value(await constructRuntimeRendererHost('),
      source.indexOf('releases.push(() => graphics.renderer.dispose());'),
    );
    const options = await runInNewContext(
      `(async () => { let graphics; ${call} return graphics; })()`,
      {
        constructRuntimeRendererHost: async (_canvas: unknown, options: unknown) => ({
          ok: true,
          value: options,
        }),
        value: (result: { value: unknown }) => result.value,
        canvas: {},
        rhi: {},
        gpuShaders: {},
        ui: {},
        gameVfx: { feature: {} },
        forgeaxBundlerAdapter: () => ({}),
      },
    );
    expect(options.dynamicGeometryMeshBudgetBytes).toBe(budget);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes one subpackage with unchanged local JavaScript and lossless package resources', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-wechat-package-'));
  try {
    await mkdir(resolve(root, 'assets'));
    await mkdir(resolve(root, 'shaders'));
    const entry = "require('./assets/game.js');";
    const program = 'module.exports = { value: 7 };';
    const source = new Uint8Array([0, 97, 115, 109, 0, 255]);
    await writeFile(resolve(root, 'game.js'), entry);
    await writeFile(resolve(root, 'assets/game.js'), program);
    await writeFile(resolve(root, 'assets/source.wasm'), source);
    await writeFile(resolve(root, 'pack-index.json'), '[]');
    await writeFile(resolve(root, 'shaders/manifest.json'), '{}');
    await writeWechatProject(
      { name: 'Native game' } as ProjectFacts,
      { target: 'wechat', appid: 'wx0000000000000000' },
      root,
    );
    expect(await readFile(resolve(root, 'payload/game.js'), 'utf8')).toBe(entry);
    expect(await readFile(resolve(root, 'payload/assets/game.js'), 'utf8')).toBe(program);
    expect(
      new Uint8Array(
        brotliDecompressSync(await readFile(resolve(root, 'payload/assets/source.wasm.br'))),
      ),
    ).toEqual(source);
    await expect(readFile(resolve(root, 'payload/assets/source.wasm'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const bootstrap = await readFile(resolve(root, 'game.js'), 'utf8');
    expect(bootstrap).toContain('wx.loadSubpackage');
    expect(bootstrap).not.toContain('require(');
    expect(JSON.parse(await readFile(resolve(root, 'game.json'), 'utf8')).subpackages).toEqual([
      { name: 'payload', root: 'payload/' },
    ]);
    expect(
      JSON.parse(await readFile(resolve(root, 'project.config.json'), 'utf8')).setting,
    ).toEqual({
      es6: false,
      enhance: false,
      minified: false,
    });
    const manifest = await writeDistManifest(
      { id: 'native-game', name: 'Native game' } as ProjectFacts,
      '/',
      root,
      'wechat',
    );
    expect(manifest.target).toBe('wechat');
    expect(manifest.runtime).toEqual({
      packIndexUrl: 'payload/pack-index.json.br',
      shaderManifestUrl: 'payload/shaders/manifest.json.br',
    });
    expect(await verifyDist(root)).toEqual({ ok: true, value: manifest });
    await writeFile(resolve(root, 'payload/assets/source.wasm.br'), new Uint8Array([0]));
    expect(await verifyDist(root)).toMatchObject({
      ok: false,
      error: { code: 'dist-artifact-mismatch' },
    });
    await expect(verifyWechatPackageBudget(root)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects either the main-package or total deployed-byte limit', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-wechat-budget-'));
  try {
    const main = await open(resolve(root, 'main.bin'), 'w');
    try {
      await main.truncate(4 * 1024 * 1024 + 1);
    } finally {
      await main.close();
    }
    await expect(verifyWechatPackageBudget(root)).rejects.toThrow('main 4194305/4194304');
    await rm(resolve(root, 'main.bin'));
    await mkdir(resolve(root, 'payload'));
    const payload = await open(resolve(root, 'payload/data.br'), 'w');
    try {
      await payload.truncate(20 * 1024 * 1024 + 1);
    } finally {
      await payload.close();
    }
    await expect(verifyWechatPackageBudget(root)).rejects.toThrow('total 20971521/20971520');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
