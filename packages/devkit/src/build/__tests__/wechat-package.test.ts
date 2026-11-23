import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { brotliDecompressSync } from 'node:zlib';
import { FixedTime, Time, World } from '@forgeax/engine-ecs';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { resolveLoadProgressLabels } from '@forgeax/engine-types';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { verifyDist, writeDistManifest } from '../../dist.js';
import type { ProjectFacts } from '../../types.js';
import { executionWorkerEntries } from '../execution-workers.js';
import { prepareWechatBuild, verifyWechatPackageBudget, writeWechatProject } from '../wechat.js';
import { generatedWechatConfiguration } from './configuration-host.fixture';

it('bundles an ordinary Runtime Pack into a lazy native WeChat module', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-wechat-runtime-pack-'));
  try {
    const scope = resolve(root, 'node_modules/@forgeax');
    await mkdir(scope, { recursive: true });
    await symlink(
      resolve(import.meta.dirname, '../../../../engine'),
      resolve(scope, 'engine'),
      'dir',
    );
    const program = preparePackProgram({
      entry: 'runtime.mjs',
      export: 'generate',
      modules: {
        'runtime.mjs':
          "export function generate() { return { ok: true, value: { s: { kind: 'sampler' } } }; }",
      },
    }).unwrap();
    await prepareWechatBuild(
      {
        root,
        id: 'inline-runtime',
        name: 'Inline Runtime',
        roots: {},
        assetRoots: ['assets'],
        assetLibraries: [],
        packageJson: {},
      },
      root,
      {
        assets: new Map(),
        deferred: [],
        sourceInputs: new Map(),
        sourceSnapshot: createScriptablePackSourceSnapshot(),
        filesystemInputs: undefined,
      },
      {},
      [
        {
          source: {
            schemaVersion: '2.0.0',
            kind: 'scriptable-pack-source',
            source: 'runtime.pack.ts',
            program: program.digest,
            packageId: '01900000-0000-7000-8000-000000000197',
            runtime: { export: 'generate', outputs: { s: 'sampler' }, dependencies: [] },
          },
          program,
        },
      ],
    );
    const host = await readFile(resolve(root, 'wechat-main.ts'), 'utf8');
    expect(host).toContain(`createWechatRecordStore(wx, "inline-runtime", 'runtime-packs-v1')`);
    expect(host).toContain(
      'runtimePacks: { scopeId: runtimeBinding.scopeId, authored, imports, programHost, cache: runtimePackCache }',
    );
    await writeFile(
      resolve(root, 'probe.ts'),
      `
import { loadPackProgram } from '@forgeax/engine/pack/runtime';
import { authored, imports, programHost } from './wechat-programs.ts';
export async function generate() {
  const generator = (await loadPackProgram(authored[0].program, imports, programHost)).unwrap();
  return generator({});
}
`,
    );
    await build({
      root,
      configFile: false,
      logLevel: 'error',
      plugins: [executionWorkerEntries([], 'native')],
      build: {
        modulePreload: false,
        rollupOptions: {
          input: resolve(root, 'probe.ts'),
          preserveEntrySignatures: 'strict',
          output: {
            format: 'cjs',
            entryFileNames: 'probe.cjs',
            chunkFileNames: 'assets/[name]-[hash].cjs',
          },
        },
      },
    });
    const { generate } = createRequire(import.meta.url)(resolve(root, 'dist/probe.cjs'));
    await expect(generate()).resolves.toEqual({ ok: true, value: { s: { kind: 'sampler' } } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  undefined,
  256 * 1024 * 1024,
])('passes the projected native mesh budget %s to the actual Renderer owner', async (budget) => {
  const time = { fixedDeltaSeconds: 1 / 20, maxStepsPerUpdate: 2, maxDeltaSeconds: 3 * (1 / 20) };
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-wechat-app-options-'));
  try {
    await prepareWechatBuild(
      {
        root,
        id: 'native-app-options',
        name: 'Native App options',
        roots: {},
        assetRoots: ['assets'],
        assetLibraries: [],
        packageJson: { version: '1.2.3' },
      },
      root,
      {
        assets: new Map(),
        deferred: [],
        sourceInputs: new Map(),
        sourceSnapshot: createScriptablePackSourceSnapshot(),
        filesystemInputs: undefined,
      },
      budget === undefined
        ? {}
        : { dynamicGeometryMeshBudgetBytes: budget, textureMipSkip: 2, time },
    );
    const source = await readFile(resolve(root, 'wechat-main.ts'), 'utf8');
    expect(source).toContain('Game 1.2.3 | Engine ');
    const { plan, configured } = generatedWechatConfiguration(source);
    const call = source.slice(
      source.indexOf('graphics = value(await constructRuntimeRendererHost('),
      source.indexOf('releases.push(() => graphics.renderer.dispose());'),
    );
    const options = await runInNewContext(
      `(async () => { let graphics; ${call} return graphics; })()`,
      {
        plan,
        configured,
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
        gameFeatures: { features: [] },
        forgeaxBundlerAdapter: () => ({}),
      },
    );
    expect(options.dynamicGeometryMeshBudgetBytes).toBe(budget);
    expect(options.textureMipSkip).toBe(budget === undefined ? 0 : 2);
    const world = runInNewContext(
      `${source.slice(source.indexOf('const world = new World('), source.indexOf('let game;'))} world`,
      { World, plan, configured },
    ) as World;
    world.update(1 / 60).unwrap();
    expect(world.getResource(Time).maxDeltaSeconds).toBe(
      budget === undefined ? 0.1 : time.maxDeltaSeconds,
    );
    expect(world.getResource(FixedTime).delta).toBe(
      budget === undefined ? 1 / 60 : time.fixedDeltaSeconds,
    );
    expect(world.getResource(FixedTime).maxStepsPerUpdate).toBe(budget === undefined ? 4 : 2);
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
    let progress: ((event: object) => void) | undefined;
    let loaded: (() => void) | undefined;
    const startup = runInNewContext(`${bootstrap}; globalThis.__forgeaxGameInspection`, {
      wx: {
        loadSubpackage: (options: { success(): void }) => {
          loaded = options.success;
          return {
            onProgressUpdate: (callback: (event: object) => void) => {
              progress = callback;
            },
          };
        },
      },
      console: { info() {} },
    });
    expect(progress).toBeTypeOf('function');
    progress?.({ progress: 25, totalBytesWritten: 100, totalBytesExpectedToWrite: 400 });
    expect(startup.renderer().packageLoad).toMatchObject({
      progressAvailable: true,
      events: 1,
      progress: 25,
      totalBytesWritten: 100,
      totalBytesExpectedToWrite: 400,
    });
    progress?.({ progress: NaN, totalBytesWritten: -1, totalBytesExpectedToWrite: '400' });
    expect(startup.renderer().packageLoad).toMatchObject({
      events: 2,
      progress: 25,
      invalidFields: 3,
    });
    loaded?.();
    progress?.({ progress: 100, totalBytesWritten: 400, totalBytesExpectedToWrite: 400 });
    expect(startup.renderer().phase).toBe('subpackage-loaded');
    expect(startup.renderer().packageLoad.events).toBe(2);
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

it.each(
  ['en', 'zh-CN'].flatMap((lang) =>
    ([undefined, 'default', 'none', { html: '' }] as const).map((failure) => ({ lang, failure })),
  ),
)('honors failure presentation $failure in $lang before the native subpackage loads', async ({
  lang,
  failure,
}) => {
  const labels = resolveLoadProgressLabels({ lang });
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-wechat-presentation-'));
  const generated = resolve(root, 'generated');
  const output = resolve(root, 'output');
  const facts: ProjectFacts = {
    root,
    id: 'native-presentation',
    name: 'Native presentation',
    roots: {},
    assetRoots: ['assets'],
    assetLibraries: [],
    packageJson: {},
  };
  try {
    await mkdir(generated);
    await mkdir(output);
    const { plugin } = await prepareWechatBuild(
      facts,
      generated,
      {
        assets: new Map(),
        deferred: [],
        sourceInputs: new Map(),
        sourceSnapshot: createScriptablePackSourceSnapshot(),
        filesystemInputs: undefined,
      },
      { loadingLabels: { lang }, startupUi: { ...(failure === undefined ? {} : { failure }) } },
    );
    const hook = plugin.generateBundle;
    const emitted: { fileName: string; source: string }[] = [];
    if (hook)
      Reflect.apply(
        typeof hook === 'function' ? hook : hook.handler,
        { emitFile: (asset: { fileName: string; source: string }) => emitted.push(asset) },
        [{}, {}, false],
      );
    for (const asset of emitted) await writeFile(resolve(output, asset.fileName), asset.source);
    await writeFile(resolve(output, 'game.js'), '');
    await writeFile(resolve(output, 'pack-index.json'), '[]');
    await mkdir(resolve(output, 'shaders'));
    await writeFile(resolve(output, 'shaders/manifest.json'), '{}');
    await writeWechatProject(facts, { target: 'wechat', appid: 'wx0000000000000000' }, output);
    const bootstrap = await readFile(resolve(output, 'game.js'), 'utf8');
    const modals: unknown[] = [];
    const inspection = runInNewContext(`${bootstrap}; globalThis.__forgeaxGameInspection`, {
      wx: {
        loadSubpackage(options: { fail(error: unknown): void }) {
          options.fail({ errMsg: 'Native package transport rejected' });
        },
        showModal: (modal: unknown) => modals.push(modal),
      },
      console: { info() {}, error() {} },
    });
    expect(inspection.phase).toBe('failed');
    expect(inspection.error).toMatchObject({
      operation: 'wx.loadSubpackage',
      message: 'Native package transport rejected',
    });
    expect(modals).toHaveLength(failure === undefined || failure === 'default' ? 1 : 0);
    if (modals.length > 0) {
      expect(modals[0]).toMatchObject({
        title: labels.host.nativePackageFailureTitle,
        confirmText: labels.host.confirm,
        content: 'Native package transport rejected',
      });
    }
    await expect(readFile(resolve(output, 'forgeax-wechat-startup.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(resolve(output, 'payload/forgeax-wechat-startup.json.br')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
