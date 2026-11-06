import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeRuntimeSource, checkRuntimeBoundaries } from '../check-runtime-boundaries.mjs';

const codes = (source, options) => analyzeRuntimeSource(source, options).map((entry) => entry.code);

test('rejects tool metadata through casts, brackets, aliases and destructuring', () => {
  for (const source of [
    'export const dev = import.meta.env?.DEV;',
    'export const dev = (import.meta as { env?: object }).env;',
    'export const hot = import.meta["hot"];',
    'const metadata = import.meta; export const dev = metadata.env;',
    'const { env } = import.meta;',
    'export const glob = import.meta.glob("./*.ts");',
  ])
    assert.ok(codes(source).includes('runtime-tool-metadata'), source);
  assert.deepEqual(codes('export const url = new URL("./worker.mjs", import.meta.url);'), []);
});

test('portable import.meta.url remains valid through aliases and destructuring', () => {
  for (const source of [
    'const metadata = import.meta; export const url = metadata.url;',
    'const { url } = import.meta; export { url };',
    'const metadata = import.meta; const { url } = metadata; export { url };',
    'const { ["url"]: url } = import.meta; export { url };',
    'const key = "url"; export const url = import.meta[key];',
    'const key = "url"; const metadata = import.meta; export const url = metadata[key];',
    'const metadata = import.meta; type Url = typeof metadata.url; type Env = typeof metadata.env;',
  ])
    assert.deepEqual(codes(source), [], source);

  for (const source of [
    'const metadata = import.meta; export const dev = metadata.env.DEV;',
    'const { env } = import.meta;',
    'const metadata = import.meta; use(metadata);',
  ])
    assert.ok(codes(source).includes('runtime-tool-metadata'), source);
});

test('detects ambient environment reads through aliases and computed keys', () => {
  for (const source of [
    'export const dev = process.env.NODE_ENV;',
    'const p = (globalThis as { process?: unknown }).process; export const dev = p?.env;',
    'const host = globalThis; const p = host["process"]; export const env = p["env"];',
    'const { env } = process;',
    'const { ["env"]: env } = process; export const mode = env.NODE_ENV;',
    'const key = "env"; const { [key]: env } = process; export const mode = env.NODE_ENV;',
    'const { process: p } = globalThis; export const env = p.env;',
    'const { process: { env } } = globalThis;',
    'const key = "env"; export const values = process[key];',
    'import nodeProcess from "node:process"; export const env = nodeProcess.env;',
  ])
    assert.ok(codes(source).includes('runtime-host-environment'), source);
});

test('ignores local process-like values, comments, type shapes and generated strings', () => {
  const source = `
    // import.meta.env.DEV and process.env.NODE_ENV are not executed.
    type Shape = { process?: { env?: object } };
    export function read(process: Shape) { return process.env; }
    export function nested() { const globalThis = { process: { env: 1 } }; return globalThis.process.env; }
    export const generated = "import.meta.env.DEV; process.env.NODE_ENV";
  `;
  assert.deepEqual(codes(source), []);
});

test('runtime imports cannot depend on build tools even through a constant specifier', () => {
  for (const source of [
    'import type { Plugin } from "vite";',
    'export { build } from "esbuild";',
    'import ts from "typescript";',
    'import { transform } from "@babel/core";',
    'import { transform } from "@swc/core";',
    'import { rspack } from "@rspack/core";',
    'import { createRsbuild } from "@rsbuild/core";',
    'const tool = "vitest/node"; export const module = import(tool);',
    'import "@forgeax/engine-vite-plugin-shader";',
    'import "@forgeax/engine/devkit";',
    'import "@forgeax/engine-shader-compiler";',
    'import "@forgeax/engine/vfx-compiler";',
    'import "@forgeax/engine-dsh";',
    'import "@forgeax/engine-three/build";',
    'import "virtual:forgeax/bundler";',
  ])
    assert.ok(codes(source).includes('runtime-tool-import'), source);
  assert.deepEqual(
    codes('import "@babel/runtime/helpers/extends"; import "@swc/helpers/_/_extends";'),
    [],
  );
  assert.deepEqual(
    codes('import { cook } from "@forgeax/engine-shader-compiler";', {
      file: 'packages/three/src/build/materials.ts',
    }),
    [],
  );
  assert.ok(
    codes('export * from "./build/materials";', {
      file: 'packages/three/src/index.ts',
    }).includes('runtime-tool-import'),
  );
});

test('Pack Node tool exports allow erased type contracts but reject runtime dependencies', () => {
  for (const source of [
    'import type { CatalogBuildResult } from "@forgeax/engine-pack/build";',
    'import { type NativeCooker } from "@forgeax/engine-pack/native-cooker";',
    'export type { ScanOptions } from "@forgeax/engine-pack/scanner";',
    'type Draft = import("@forgeax/engine-pack/build").CatalogBuildResult;',
  ])
    assert.deepEqual(codes(source), [], source);

  for (const source of [
    'import { NativeCookerRegistry } from "@forgeax/engine-pack/native-cooker";',
    'import { createRuntimePackPublication } from "@forgeax/engine-pack/build";',
    'import { loadScriptablePack } from "@forgeax/engine-pack/source-node";',
    'import type { SourceFile } from "typescript";',
    'import type { Plugin } from "vite";',
  ])
    assert.ok(codes(source).includes('runtime-tool-import'), source);

  assert.deepEqual(
    codes('import ts from "typescript"; import "./pack-authoring-literals.js";', {
      file: 'packages/pack/src/scriptable-pack-node.ts',
    }),
    [],
  );
  assert.ok(
    codes('import ts from "typescript";', { file: 'packages/pack/src/index.ts' }).includes(
      'runtime-tool-import',
    ),
  );
  assert.ok(
    codes('import "./pack-authoring-literals.js";', {
      file: 'packages/pack/src/index.ts',
    }).includes('runtime-tool-import'),
  );
  assert.ok(
    codes('import "./pack-authoring-literals";', {
      file: 'packages/pack/src/index.ts',
    }).includes('runtime-tool-import'),
  );
  assert.ok(
    codes('export * from "./build";', {
      file: 'packages/three/src/index.ts',
    }).includes('runtime-tool-import'),
  );
});

test('engine tool authority is limited to tool facades and its CLI binary', () => {
  for (const file of ['packages/engine/dist/index.mjs', 'packages/engine/dist/facades/render.mjs'])
    for (const source of [
      'import "@forgeax/engine-devkit/cli";',
      'import "@forgeax/engine-vite-plugin-shader";',
    ])
      assert.ok(
        codes(source, { file, mode: 'dist' }).includes('runtime-tool-import'),
        `${file}: ${source}`,
      );

  for (const [source, file] of [
    ['export * from "@forgeax/engine-devkit";', 'packages/engine/dist/facades/devkit.mjs'],
    [
      'export * from "@forgeax/engine-vite-plugin-shader";',
      'packages/engine/dist/facades/vite-plugin-shader.mjs',
    ],
    ['export * from "@forgeax/engine-pack/build";', 'packages/engine/dist/facades/pack/build.mjs'],
    ['import "@forgeax/engine-devkit/cli";', 'packages/engine/dist/bin/forgeax.mjs'],
  ])
    assert.deepEqual(codes(source, { file, mode: 'dist' }), [], `${file}: ${source}`);
});

test('explicit tooling and Node adapters retain their own environment authority', () => {
  assert.deepEqual(
    codes('export const path = import.meta.resolve("msdf-generator");', {
      file: 'packages/font/src/font-importer.ts',
    }),
    [],
  );
  assert.deepEqual(
    codes('const { resolve } = import.meta;', {
      file: 'packages/font/src/font-importer.ts',
    }),
    [],
  );
  assert.ok(
    codes('const { resolve } = import.meta;', {
      file: 'packages/app/src/new-feature.ts',
    }).includes('runtime-host-metadata'),
  );
  assert.ok(
    codes('export const path = import.meta.resolve("msdf-generator");', {
      file: 'packages/font/src/runtime.ts',
    }).includes('runtime-host-metadata'),
  );
  assert.deepEqual(
    codes('export const config = process.env.VALUE;', {
      file: 'packages/devkit/src/host.ts',
    }),
    [],
  );
  assert.deepEqual(
    codes('export const config = process.env.VALUE;', {
      file: 'packages/rhi-wgpu-native/src/binding.ts',
    }),
    [],
  );
  assert.ok(
    codes('export const config = process.env.VALUE;', {
      file: 'packages/rhi/src/new-feature.ts',
    }).includes('runtime-host-environment'),
  );
  assert.ok(
    codes('export const dev = import.meta.env.DEV;', {
      file: 'packages/rhi-wgpu-native/src/binding.ts',
    }).includes('runtime-tool-metadata'),
  );
});

test('Scriptable Pack transport cache has exact Node host authority', () => {
  const file = 'packages/import/src/scriptable-pack-transport-cache.ts';
  assert.deepEqual(
    codes(
      'export const timing = process.env.FORGEAX_WORKSPACE_TIMING; export const pack = import.meta.resolve("@forgeax/engine-pack/build"); import type { finalizePackageTransportSource } from "@forgeax/engine-pack/build"; import type { ScriptablePackInput } from "./scriptable-pack-host.js";',
      { file },
    ),
    [],
  );
  assert.ok(
    codes('export const timing = process.env.FORGEAX_WORKSPACE_TIMING;', {
      file: 'packages/import/src/transport-cache.ts',
    }).includes('runtime-host-environment'),
  );
  assert.ok(
    codes('export const pack = import.meta.resolve("@forgeax/engine-pack/build");', {
      file: 'packages/import/src/transport-cache.ts',
    }).includes('runtime-host-metadata'),
  );
  assert.ok(
    codes('import { finalizePackageTransportSource } from "@forgeax/engine-pack/build";', {
      file: 'packages/import/src/transport-cache.ts',
    }).includes('runtime-tool-import'),
  );
  assert.ok(
    codes('import type { ScriptablePackInput } from "./scriptable-pack-host.js";', {
      file: 'packages/import/src/transport-cache.ts',
    }).includes('runtime-tool-import'),
  );
});

test('runtime hints report contracts without assuming a producer tool', () => {
  assert.ok(
    codes('const error = { hint: "rebuild with the Vite shader plugin" };').includes(
      'runtime-tool-hint',
    ),
  );
  assert.deepEqual(codes('const error = { hint: "publish the required shader entries" };'), []);
});

test('implicit build globals cannot replace the removed metadata probes', () => {
  assert.ok(
    codes('if (__DEV__) console.info("capacity changed");').includes('runtime-tool-global'),
  );
  assert.ok(
    codes('declare const __DEV__: boolean; if (__DEV__) run();').includes('runtime-tool-global'),
  );
  assert.ok(codes('if (globalThis.__DEV__) run();').includes('runtime-tool-global'));
  assert.deepEqual(codes('function inspect(__DEV__) { return __DEV__; }'), []);
});

test('source asset transforms require an owned producer and may not survive into dist', () => {
  const source = 'import text from "./shader.wgsl?raw";';
  assert.ok(codes(source).includes('runtime-tool-resource'));
  assert.deepEqual(codes(source, { file: 'packages/shader/src/auto-exposure-source.ts' }), []);
  assert.ok(
    codes(source, { file: 'packages/shader/dist/index.mjs', mode: 'dist' }).includes(
      'runtime-tool-resource',
    ),
  );
  assert.ok(
    codes('export const dev = process.env.NODE_ENV;', {
      file: 'packages/new-package/dist/index.mjs',
      mode: 'dist',
    }).includes('runtime-host-environment'),
  );
});

test('static tool URL transforms are fenced while standard URLs and API queries remain valid', () => {
  for (const source of [
    'new URL("./wgpu_wasm.js?raw", import.meta.url);',
    'new URL("../shader.wgsl?url", base);',
    'new URL("./worker.mjs?worker", import.meta.url);',
    'const resource = "./module.wasm?url"; new URL(resource, import.meta.url);',
  ])
    assert.ok(codes(source).includes('runtime-tool-resource'), source);

  for (const source of [
    'new URL("./worker.mjs", import.meta.url);',
    'new URL("./worker.mjs?version=3", import.meta.url);',
    'new URL("/api/snapshot?raw=true", apiOrigin);',
    'new URL("https://service.test/module.wasm?raw=1", apiOrigin);',
    'new URL();',
  ])
    assert.deepEqual(codes(source), [], source);

  assert.deepEqual(
    codes('new URL("./wgpu_wasm.js?raw", import.meta.url);', {
      file: 'packages/pack/src/scriptable-pack-worker.ts',
    }),
    [],
  );
  assert.deepEqual(
    codes('new URL("./shader.wgsl?raw", import.meta.url);', {
      file: 'packages/shader/src/auto-exposure-source.ts',
    }),
    [],
  );
  assert.deepEqual(
    codes('new URL("./worker.mjs?worker", import.meta.url);', {
      file: 'packages/pack/dist/scriptable-pack-worker.mjs',
      mode: 'dist',
    }),
    [],
  );
  assert.ok(
    codes('new URL("./wgpu_wasm.js?raw", import.meta.url);', {
      file: 'packages/shader/dist/index.mjs',
      mode: 'dist',
    }).includes('runtime-tool-resource'),
  );
});

test('public entrypoints do not export test-only reset APIs', () => {
  assert.ok(
    codes('export const __resetForTests = () => {};', {
      file: 'packages/example/dist/index.mjs',
      mode: 'dist',
      publicEntry: true,
    }).includes('runtime-test-export'),
  );
  assert.ok(
    codes('const __resetForTests = () => {}; export default __resetForTests;', {
      file: 'packages/example/src/index.ts',
      publicEntry: true,
    }).includes('runtime-test-export'),
  );
  assert.deepEqual(
    codes('export const __resetForTests = () => {};', {
      file: 'packages/example/src/internal/cache.ts',
    }),
    [],
  );
  assert.ok(
    codes('export { reset as _resetThingForTests } from "./internal.mjs";', {
      file: 'packages/example/src/index.ts',
      publicEntry: true,
    }).includes('runtime-test-export'),
  );
  for (const source of [
    'export { __resetForTests as clearCache } from "./internal.mjs";',
    'export { clearCache as __resetForTests } from "./internal.mjs";',
    'export const { __resetForTests } = createTestHooks();',
  ])
    assert.ok(
      codes(source, { file: 'packages/example/src/index.ts', publicEntry: true }).includes(
        'runtime-test-export',
      ),
      source,
    );
});

test('public export stars follow local re-export chains without exposing unrelated internals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-export-star-'));
  try {
    const directory = join(root, 'packages/example');
    await mkdir(join(directory, 'src/internal'), { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: '@forgeax/engine-example', exports: { '.': './dist/index.mjs' } }),
    );
    await writeFile(join(directory, 'src/index.ts'), 'export * from "./internal/barrel.js";');
    await writeFile(join(directory, 'src/internal/barrel.ts'), 'export * from "./bridge.js";');
    await writeFile(
      join(directory, 'src/internal/bridge.ts'),
      'export { __resetForTests as clearCache } from "./cache.js";',
    );
    await writeFile(
      join(directory, 'src/internal/cache.ts'),
      'export const __resetForTests = () => {}; export const cacheSize = 1;',
    );

    const result = await checkRuntimeBoundaries({ root });
    const findings = result.violations.filter((entry) => entry.code === 'runtime-test-export');
    assert.deepEqual(
      findings.map((entry) => entry.file),
      ['packages/example/src/index.ts'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source public entries include default JS/TS indexes and manifest-declared source targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-public-source-'));
  try {
    const directory = join(root, 'packages/example');
    await mkdir(join(directory, 'src/internal'), { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-example',
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
          './testing': { types: './dist/testing.d.ts', import: './src/testing.mjs' },
        },
      }),
    );
    await writeFile(join(directory, 'src/index.mjs'), 'export const resetForTests = () => {};');
    await writeFile(join(directory, 'src/testing.mjs'), 'export const clearForTests = () => {};');
    await writeFile(
      join(directory, 'src/internal/cache.ts'),
      'export const resetCacheForTests = () => {};',
    );

    const result = await checkRuntimeBoundaries({ root });
    const publicFindings = result.violations.filter(
      (entry) => entry.code === 'runtime-test-export',
    );
    assert.deepEqual(publicFindings.map((entry) => entry.file).sort(), [
      'packages/example/src/index.mjs',
      'packages/example/src/testing.mjs',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('whole-package scan defaults new packages to runtime and checks declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-boundary-'));
  try {
    const dir = join(root, 'packages/new-package');
    await mkdir(join(dir, 'src/__tests__'), { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-new-package',
        dependencies: { vite: '1' },
        exports: { '.': './dist/index.mjs' },
      }),
    );
    await writeFile(join(dir, 'src/index.ts'), 'export const dev = process.env.NODE_ENV;');
    await writeFile(
      join(dir, 'src/__tests__/fixture.ts'),
      'export const dev = import.meta.env.DEV;',
    );
    let result = await checkRuntimeBoundaries({ root });
    assert.equal(result.packages, 1);
    assert.equal(result.files, 1);
    assert.deepEqual(
      new Set(result.violations.map((entry) => entry.code)),
      new Set(['runtime-host-environment', 'runtime-tool-dependency']),
    );
    result = await checkRuntimeBoundaries({ root, mode: 'dist' });
    assert.ok(result.violations.some((entry) => entry.code === 'runtime-dist-missing'));
    await mkdir(join(dir, 'dist'));
    result = await checkRuntimeBoundaries({ root, mode: 'dist' });
    assert.ok(result.violations.some((entry) => entry.code === 'runtime-dist-entry-missing'));
    await writeFile(join(dir, 'dist/index.mjs'), 'export const dev = import.meta.env.DEV;');
    result = await checkRuntimeBoundaries({ root, mode: 'dist' });
    assert.ok(result.violations.some((entry) => entry.code === 'runtime-tool-metadata'));
    await writeFile(
      join(dir, 'dist/index.mjs'),
      'export const bytes = new URL("./glue.bytes", import.meta.url);',
    );
    result = await checkRuntimeBoundaries({ root, mode: 'dist' });
    assert.ok(result.violations.some((entry) => entry.code === 'runtime-resource-missing'));
    await writeFile(join(dir, 'dist/glue.bytes'), 'original glue bytes');
    result = await checkRuntimeBoundaries({ root, mode: 'dist' });
    assert.ok(!result.violations.some((entry) => entry.code === 'runtime-resource-missing'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Pack permits TypeScript as its sole mixed runtime tool dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-tool-dependency-'));
  try {
    const directory = join(root, 'packages/pack');
    await mkdir(join(directory, 'src'), { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-pack',
        dependencies: { typescript: '6.0.3', vite: '1.0.0' },
        exports: { '.': './dist/index.mjs' },
      }),
    );
    await writeFile(join(directory, 'src/index.ts'), 'export const valid = true;');

    const result = await checkRuntimeBoundaries({ root });
    assert.deepEqual(
      result.violations
        .filter((entry) => entry.code === 'runtime-tool-dependency')
        .map((entry) => entry.message),
      ['vite must not be a runtime dependency of @forgeax/engine-pack.'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
