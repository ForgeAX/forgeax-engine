import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, normalizePath } from 'vite';
import { describe, expect, it } from 'vitest';
import { executionWorkerEntries } from '../build/execution-workers.js';
import { runtimeProgramIdentity } from '../build/pack-program-imports.js';
import {
  engineDoctorCommand,
  enginePackageRuntimeIdentity,
  engineStatusCommand,
  engineUnlinkCommand,
  engineUseLocalCommand,
} from '../engine-binding.js';
import { createEngineWorkspaceResolverForProject } from '../host.js';

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(
  dependencyMode: 'none' | 'workspace' | 'mixed' = 'none',
  rootPrefix = 'forgeax-engine-binding-',
): Promise<{
  readonly game: string;
  readonly engine: string;
}> {
  const root = await mkdtemp(resolve(tmpdir(), rootPrefix));
  const game = resolve(root, 'game');
  const engine = resolve(root, 'engine');
  await Promise.all([mkdir(game, { recursive: true }), mkdir(engine, { recursive: true })]);
  await Promise.all([
    mkdir(resolve(game, '.forgeax'), { recursive: true }),
    mkdir(resolve(engine, 'packages', 'engine', 'dist'), { recursive: true }),
    mkdir(resolve(engine, 'packages', 'engine-render', 'dist'), { recursive: true }),
    mkdir(resolve(engine, 'packages', 'engine-render', 'dist', 'engine-inputs', 'point-ssao'), {
      recursive: true,
    }),
    mkdir(resolve(engine, 'packages', 'engine-render', 'pkg'), { recursive: true }),
    mkdir(resolve(engine, 'packages', 'engine-render', 'assets'), { recursive: true }),
    mkdir(resolve(engine, 'packages', 'net-websocket', 'dist'), { recursive: true }),
    writeFile(resolve(engine, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n'),
    writeFile(resolve(game, 'main.ts'), 'export default {};\n'),
  ]);
  await writeJson(resolve(game, 'forge.json'), {
    id: 'binding-fixture',
    name: 'Binding Fixture',
    schemaVersion: '3.0.0',
    roots: {},
  });
  await writeJson(resolve(game, 'package.json'), {
    name: 'binding-fixture',
    ...(dependencyMode === 'workspace'
      ? { dependencies: { '@forgeax/engine': 'workspace:*' } }
      : dependencyMode === 'mixed'
        ? {
            dependencies: { '@forgeax/engine': 'workspace:*' },
            devDependencies: { '@forgeax/engine-render': '0.1.7' },
          }
        : {}),
  });
  for (const [directory, name] of [
    ['engine', '@forgeax/engine'],
    ['engine-render', '@forgeax/engine-render'],
  ] as const) {
    await writeJson(resolve(engine, 'packages', directory, 'package.json'), {
      name,
      version: '0.1.7',
      type: 'module',
      exports: { '.': './dist/index.mjs', './package.json': './package.json' },
    });
    await writeFile(
      resolve(engine, 'packages', directory, 'dist/index.mjs'),
      directory === 'engine-render'
        ? "export { value } from './chunk-render.mjs';\n"
        : 'export {};\n',
    );
  }
  await Promise.all([
    writeFile(
      resolve(engine, 'packages', 'engine-render', 'dist/chunk-render.mjs'),
      'export const value = 1;\n',
    ),
    writeFile(
      resolve(engine, 'packages', 'engine-render', 'pkg/fixture.wasm'),
      Buffer.from([0, 97, 115, 109]),
    ),
    writeFile(
      resolve(engine, 'packages', 'engine-render', 'assets/runtime.json'),
      '{"version":1}\n',
    ),
    writeFile(
      resolve(engine, 'packages', 'engine-render', 'dist/engine-inputs/point-ssao/imports.json'),
      '{}\n',
    ),
    writeFile(
      resolve(engine, 'packages', 'engine-render', 'dist/engine-inputs/point-ssao/manifest.json'),
      '{}\n',
    ),
  ]);
  await writeJson(resolve(engine, 'packages', 'net-websocket', 'package.json'), {
    name: '@forgeax/engine-net-websocket',
    version: '0.1.7',
    type: 'module',
    exports: {
      './browser': { types: './dist/browser.d.ts', import: './dist/browser.mjs' },
      './node': { types: './dist/node.d.ts', node: './dist/node.mjs', default: null },
      './package.json': './package.json',
    },
  });
  await Promise.all([
    writeFile(resolve(engine, 'packages', 'net-websocket', 'dist/browser.mjs'), 'export {};\n'),
    writeFile(resolve(engine, 'packages', 'net-websocket', 'dist/node.mjs'), 'export {};\n'),
  ]);
  return { game, engine };
}

describe('selected Engine runtime identity', () => {
  it('distinguishes different source bytes at the same package version', async () => {
    const a = await fixture();
    const b = await fixture();
    try {
      const first = resolve(a.engine, 'packages/engine-render');
      const second = resolve(b.engine, 'packages/engine-render');
      expect(await enginePackageRuntimeIdentity(first)).toBe(
        await enginePackageRuntimeIdentity(second),
      );
      await writeFile(resolve(second, 'dist/chunk-render.mjs'), 'export const value = 2;\n');
      expect(await enginePackageRuntimeIdentity(first)).not.toBe(
        await enginePackageRuntimeIdentity(second),
      );
    } finally {
      await rm(resolve(a.engine, '..'), { recursive: true, force: true });
      await rm(resolve(b.engine, '..'), { recursive: true, force: true });
    }
  });
});

describe('engine binding commands', () => {
  it('persists one local binding and returns to the SDK route on unlink', async () => {
    const { game, engine } = await fixture();
    const selected = await engineUseLocalCommand({ root: game, path: engine });
    expect(selected).toMatchObject({
      ok: true,
      value: {
        mode: 'local',
        binding: { path: await realpath(engine) },
        resolved: { source: 'local', version: '0.1.7', built: true },
        workspace: {
          packageCount: 3,
          builtPackages: 3,
          missingBuilds: [],
          digest: expect.stringMatching(/^sha256:/),
          builtAt: expect.any(String),
          packages: [
            expect.objectContaining({
              entryDigest: expect.stringMatching(/^sha256:/),
              manifestDigest: expect.stringMatching(/^sha256:/),
              runtimeDigest: expect.stringMatching(/^sha256:/),
              runtimeFiles: expect.any(Array),
              builtAt: expect.any(String),
            }),
            expect.objectContaining({
              entryDigest: expect.stringMatching(/^sha256:/),
              manifestDigest: expect.stringMatching(/^sha256:/),
              runtimeDigest: expect.stringMatching(/^sha256:/),
              runtimeFiles: expect.arrayContaining([
                expect.objectContaining({ path: 'dist/browser.mjs' }),
                expect.objectContaining({ path: 'dist/node.mjs' }),
              ]),
              builtAt: expect.any(String),
            }),
            expect.objectContaining({
              name: '@forgeax/engine-render',
              entryDigest: expect.stringMatching(/^sha256:/),
              manifestDigest: expect.stringMatching(/^sha256:/),
              runtimeDigest: expect.stringMatching(/^sha256:/),
              runtimeFiles: expect.arrayContaining([
                expect.objectContaining({
                  path: 'assets/runtime.json',
                  digest: expect.stringMatching(/^sha256:/),
                }),
                expect.objectContaining({
                  path: 'dist/chunk-render.mjs',
                  digest: expect.stringMatching(/^sha256:/),
                }),
                expect.objectContaining({
                  path: 'pkg/fixture.wasm',
                  digest: expect.stringMatching(/^sha256:/),
                }),
              ]),
              builtAt: expect.any(String),
            }),
          ],
        },
        healthy: true,
      },
    });
    await expect(engineDoctorCommand({ root: game })).resolves.toMatchObject({
      ok: true,
      value: { healthy: true },
    });

    const unlinked = await engineUnlinkCommand({ root: game });
    expect(unlinked).toMatchObject({
      ok: true,
      value: { mode: 'sdk', binding: null },
    });
    await expect(engineStatusCommand({ root: game })).resolves.toMatchObject({
      ok: true,
      value: { mode: 'sdk', healthy: false },
    });
  });

  it('derives workspace identity from built entry bytes', async () => {
    const { game, engine } = await fixture();
    const selected = await engineUseLocalCommand({ root: game, path: engine });
    if (!selected.ok || selected.value.workspace === null)
      throw new Error('fixture-binding-failed');
    const before = selected.value.workspace.digest;
    await writeFile(
      resolve(engine, 'packages', 'engine-render', 'dist', 'index.mjs'),
      'export const build = 2;\n',
    );
    const updated = await engineStatusCommand({ root: game });
    if (!updated.ok || updated.value.workspace === null) throw new Error('fixture-status-failed');
    expect(updated.value.workspace.digest).not.toBe(before);
  });

  it('excludes optional packaged shader input caches from runtime identity', async () => {
    const { game, engine } = await fixture();
    const selected = await engineUseLocalCommand({ root: game, path: engine });
    if (!selected.ok || selected.value.workspace === null) throw new Error('fixture-status-failed');
    const render = selected.value.workspace.packages.find(
      (item) => item.name === '@forgeax/engine-render',
    );
    if (render === undefined) throw new Error('fixture-render-package-missing');
    const before = { workspace: selected.value.workspace.digest, runtime: render.runtimeDigest };
    expect(render.runtimeFiles.some((file) => file.path.startsWith('dist/engine-inputs/'))).toBe(
      false,
    );

    await rm(resolve(engine, 'packages', 'engine-render', 'dist/engine-inputs'), {
      recursive: true,
    });
    const withoutCache = await engineStatusCommand({ root: game });
    if (!withoutCache.ok || withoutCache.value.workspace === null)
      throw new Error('fixture-status-failed');
    const updated = withoutCache.value.workspace.packages.find(
      (item) => item.name === '@forgeax/engine-render',
    );
    if (updated === undefined) throw new Error('fixture-render-package-missing');
    expect(withoutCache.value.workspace.digest).toBe(before.workspace);
    expect(updated.runtimeDigest).toBe(before.runtime);
  });

  it('changes identity when a consumed chunk or resolution manifest changes', async () => {
    const { game, engine } = await fixture();
    const selected = await engineUseLocalCommand({ root: game, path: engine });
    if (!selected.ok || selected.value.workspace === null) throw new Error('fixture-status-failed');
    const before = selected.value.workspace.digest;
    await writeFile(
      resolve(engine, 'packages', 'engine-render', 'dist/chunk-render.mjs'),
      'export const value = 2;\n',
    );
    const chunkChanged = await engineStatusCommand({ root: game });
    if (!chunkChanged.ok || chunkChanged.value.workspace === null)
      throw new Error('fixture-status-failed');
    expect(chunkChanged.value.workspace.digest).not.toBe(before);

    const chunkPath = resolve(engine, 'packages', 'engine-render', 'dist/chunk-render.mjs');
    await rm(chunkPath);
    const chunkDeleted = await engineStatusCommand({ root: game });
    if (!chunkDeleted.ok || chunkDeleted.value.workspace === null)
      throw new Error('fixture-status-failed');
    expect(chunkDeleted.value.workspace.digest).not.toBe(chunkChanged.value.workspace.digest);

    const manifestPath = resolve(engine, 'packages', 'engine-render', 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.description = 'identity-change';
    await writeJson(manifestPath, manifest);
    const manifestChanged = await engineStatusCommand({ root: game });
    if (!manifestChanged.ok || manifestChanged.value.workspace === null)
      throw new Error('fixture-status-failed');
    expect(manifestChanged.value.workspace.digest).not.toBe(chunkChanged.value.workspace.digest);
  });

  it.each([
    ['workspace', 'workspace'],
    ['mixed', 'mixed'],
  ] as const)('accepts a healthy %s dependency project while preserving npm compatibility facts', async (dependencyMode, projectDependencies) => {
    const { game, engine } = await fixture(dependencyMode);
    await expect(engineUseLocalCommand({ root: game, path: engine })).resolves.toMatchObject({
      ok: true,
      value: { healthy: true, projectDependencies, npmCompatible: false },
    });
    await expect(engineDoctorCommand({ root: game })).resolves.toMatchObject({
      ok: true,
      value: { healthy: true, projectDependencies, npmCompatible: false },
    });
  });

  it('still rejects an unhealthy mixed project with a missing Engine artifact', async () => {
    const { game, engine } = await fixture('mixed');
    await engineUseLocalCommand({ root: game, path: engine });
    await rm(resolve(engine, 'packages', 'engine-render', 'dist', 'index.mjs'));

    await expect(engineDoctorCommand({ root: game })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'engine-local-build-missing',
        detail: {
          status: {
            healthy: false,
            projectDependencies: 'mixed',
            npmCompatible: false,
            workspace: { missingBuilds: ['@forgeax/engine-render'] },
          },
        },
      },
    });
  });

  it('still rejects an invalid local binding before dependency classification', async () => {
    const { game, engine } = await fixture('workspace');
    await writeJson(resolve(game, '.forgeax', 'engine-binding.json'), {
      schemaVersion: '9.9.9',
      path: engine,
    });

    await expect(engineDoctorCommand({ root: game })).resolves.toMatchObject({
      ok: false,
      error: { code: 'engine-binding-version-unsupported' },
    });
  });

  it('still rejects a mixed project when local Engine package versions diverge', async () => {
    const { game, engine } = await fixture('mixed');
    await engineUseLocalCommand({ root: game, path: engine });
    const manifestPath = resolve(engine, 'packages', 'engine-render', 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeJson(manifestPath, { ...manifest, version: '0.1.8' });

    await expect(engineDoctorCommand({ root: game })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'engine-local-build-missing',
        detail: {
          status: {
            healthy: false,
            projectDependencies: 'mixed',
            npmCompatible: false,
            workspace: { versions: ['0.1.7', '0.1.8'] },
          },
        },
      },
    });
  });
});

it('uses the explicitly bound Engine for Vite program identity and imports', async () => {
  const { game, engine } = await fixture('none', 'forgeax engine binding path-');
  const installed = resolve(game, 'node_modules/@forgeax/engine');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await mkdir(resolve(installed, 'dist'), { recursive: true });
    await writeJson(resolve(installed, 'package.json'), {
      name: '@forgeax/engine',
      version: '9.0.0',
      type: 'module',
      exports: { '.': './dist/index.mjs', './package.json': './package.json' },
    });
    await writeFile(
      resolve(installed, 'dist/index.mjs'),
      "export const capabilitySource = 'installed-sdk';\n",
    );
    expect(
      await realpath(
        createRequire(resolve(game, 'package.json')).resolve('@forgeax/engine/package.json'),
      ),
    ).toBe(await realpath(resolve(installed, 'package.json')));
    expect((await engineUseLocalCommand({ root: game, path: engine })).ok).toBe(true);
    const resolver = await createEngineWorkspaceResolverForProject(game);
    expect(resolver).toBeDefined();
    const bound = resolve(engine, 'packages/engine');
    const boundEntry = resolve(bound, 'dist/index.mjs');
    const boundMarker = "export const capabilitySource = 'bound-engine';\n";
    const unrelated = resolve(bound, 'dist/unrelated.mjs');
    await Promise.all([writeFile(boundEntry, boundMarker), writeFile(unrelated, 'export {};\n')]);
    const boundIdentity = await runtimeProgramIdentity(resolve(bound, 'package.json'));
    const installedIdentity = await runtimeProgramIdentity(resolve(installed, 'package.json'));
    expect(boundIdentity).not.toBe(installedIdentity);
    server = await createServer({
      root: game,
      base: '/frontline/',
      configFile: false,
      logLevel: 'silent',
      plugins: [resolver, executionWorkerEntries(['@forgeax/engine'])],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        fs: { allow: [game] },
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
      },
    });
    const output = await server.transformRequest('virtual:forgeax/pack-program-imports');
    expect(output?.code).toContain(boundIdentity);
    expect(output?.code).not.toContain(installedIdentity);
    const canonicalEntry = await realpath(boundEntry);
    const normalizedEntry = normalizePath(canonicalEntry);
    const expectedImportPath = `/frontline/@fs${pathToFileURL(canonicalEntry).pathname}`;
    expect(output?.code).not.toContain(
      pathToFileURL(await realpath(resolve(installed, 'dist/index.mjs'))).pathname,
    );
    const importURLMatch = output?.code.match(
      /url: new URL\(("(?:[^"\\]|\\.)*"), globalThis\.location\.origin\)\.href/,
    );
    expect(importURLMatch).not.toBeNull();
    if (importURLMatch?.[1] === undefined) throw new Error('engine-import-url-missing');
    const importPath = JSON.parse(importURLMatch[1]) as string;
    expect(importPath).toBe(expectedImportPath);
    const expectedURL = new URL(expectedImportPath, 'http://127.0.0.1');
    expect(new URL(importPath, 'http://127.0.0.1').href).toBe(expectedURL.href);

    await server.listen();
    const address = server.httpServer?.address();
    if (address === undefined || address === null || typeof address === 'string')
      throw new Error('vite-server-address-missing');
    const origin = `http://127.0.0.1:${address.port}`;
    expect(server.config.server.fs.allow.map(normalizePath)).toContain(normalizedEntry);
    expect(server.config.server.fs.allow.map(normalizePath)).not.toContain(
      normalizePath(await realpath(engine)),
    );

    const loaded = await fetch(new URL(importPath, origin));
    expect(loaded.status).toBe(200);
    const loadedSource = await loaded.text();
    expect(loadedSource).toContain('bound-engine');
    expect(loadedSource).not.toContain('installed-sdk');
    const denied = await fetch(
      new URL(`/frontline/@fs${pathToFileURL(await realpath(unrelated)).pathname}`, origin),
    );
    expect(denied.status).toBe(403);
  } finally {
    await server?.close();
    await rm(resolve(game, '..'), { recursive: true, force: true });
  }
});
