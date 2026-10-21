import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  createLazyScriptablePackDefinition,
  createScriptablePackModuleExecutorPool,
  createScriptablePackSourceSnapshot,
  loadScriptablePack,
} from '../scriptable-pack-node.js';

// Deliberately no import of the new helper: original owner must execute successfully
// through metadata, POD and cleanup before RED on the real absent derived-text wire.
interface TextRecord {
  key: string;
  filename: string;
  sourceDigest: string;
  recipeDigest: string;
  outputDigest: string;
  outputText: string;
}
interface LoadedWire {
  kind: 'loaded';
  definition: { name?: string };
  transpiles?: TextRecord[];
}
interface LoadWire {
  kind: 'load';
  sourcePath: string;
  compileRoot?: string;
  sources?: Record<string, string>;
  transpiles?: TextRecord[];
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const prefix = 'snapshot-transpile-real-fixture';
const runFile = promisify(execFile);

async function withFixture(
  run: (f: {
    root: string;
    source: string;
    dependency: string;
    loaded: LoadedWire[];
    posted: LoadWire[];
    roots: Set<string>;
    workers: Set<Worker>;
    pool: ReturnType<typeof createScriptablePackModuleExecutorPool>;
    corrupt: (transform: (entries: TextRecord[]) => TextRecord[]) => void;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-transpile-reuse-')));
  const source = join(root, 'owner.pack.ts');
  const dependency = join(root, 'dep.ts');
  const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 1 });
  const workers = new Set<Worker>();
  const roots = new Set<string>();
  const loaded: LoadedWire[] = [];
  const posted: LoadWire[] = [];
  let corruptNext: ((entries: TextRecord[]) => TextRecord[]) | undefined;
  const emit = Worker.prototype.emit;
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'online') workers.add(this);
    const value = args[0] as LoadedWire | undefined;
    if (
      event === 'message' &&
      value?.kind === 'loaded' &&
      value.definition?.name?.startsWith(prefix)
    ) {
      const url = value.definition.name.split('|')[1];
      if (url === undefined) throw new Error('missing actual compile-root witness');
      roots.add(fileURLToPath(url));
      loaded.push(structuredClone(value));
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  Worker.prototype.postMessage = function (...args: Parameters<Worker['postMessage']>): void {
    const value = args[0] as LoadWire | undefined;
    if (value?.kind === 'load' && value.sourcePath === source) {
      if (typeof value.compileRoot === 'string') roots.add(value.compileRoot);
      if (corruptNext !== undefined) {
        if (!Array.isArray(value.transpiles))
          throw new Error('missing actual reusable-cache transport');
        value.transpiles = corruptNext(value.transpiles);
        corruptNext = undefined;
      }
      posted.push(structuredClone(value));
    }
    Reflect.apply(postMessage, this, args);
  };
  try {
    await mkdir(join(root, 'node_modules', 'fixture-alias'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'fixture-alias', 'package.json'),
      JSON.stringify({
        name: 'fixture-alias',
        type: 'module',
        exports: './index.ts',
      }),
    );
    await symlink(dependency, join(root, 'node_modules', 'fixture-alias', 'index.ts'));
    await writeFile(
      dependency,
      `import { cycleValue } from './cycle.ts';
      export const shared = { value: 3 }; export const throughCycle = () => cycleValue();`,
    );
    await writeFile(
      join(root, 'cycle.ts'),
      `import { shared } from './dep.ts';
      export const cycleValue = () => shared.value;`,
    );
    await writeFile(join(root, 'reexport.ts'), `export { shared } from './dep.ts';`);
    await writeFile(join(root, 'dynamic.ts'), 'export const value = 4;');
    await writeFile(
      join(root, 'type-only.ts'),
      `throw new Error('type-only must not execute'); export interface Only { tag: string }`,
    );
    await writeFile(
      source,
      `
      import type { Only } from './type-only.ts';
      import { shared, throughCycle } from './dep.ts';
      import { shared as bare } from 'fixture-alias';
      import { shared as reexported } from './reexport.ts';
      // import('./comment-never-resolved.ts')
      const ordinary = "import('ordinary-never-resolved')";
      const escaped = 'a\\"b';
      const realm = ((globalThis as { fixtureRealm?: number }).fixtureRealm ?? 0) + 1;
      (globalThis as { fixtureRealm?: number }).fixtureRealm = realm;
      const typed: Only | undefined = undefined;
      export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(7),
        name: '${prefix}|' + new URL('.', import.meta.url).href,
        build: async () => {
          const dynamic = await import('./dynamic.ts');
          if (bare !== shared || reexported !== shared || typed !== undefined) throw new Error('module identity changed');
          if (ordinary !== "import('ordinary-never-resolved')" || escaped !== 'a\\"b') throw new Error('literal changed');
          return { ok: true, value: { texture: { kind: 'texture', width: 1, height: 1,
            format: 'rgba8unorm', colorSpace: 'linear', mipmap: false,
            data: new Uint8Array([realm, shared.value, throughCycle(), dynamic.value]) } } };
        } };`,
    );
    await run({
      root,
      source,
      dependency,
      loaded,
      posted,
      roots,
      workers,
      pool,
      corrupt: (transform) => {
        corruptNext = transform;
      },
    });
  } finally {
    Worker.prototype.emit = emit;
    Worker.prototype.postMessage = postMessage;
    try {
      await pool.dispose();
    } finally {
      // Only this serial test's actual workers/compile-root witnesses are cleaned.
      await Promise.all([...workers].map((worker) => worker.terminate()));
      await Promise.all(
        [...roots].map((directory) => rm(directory, { recursive: true, force: true })),
      );
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function metadata(
  source: string,
  snapshot: ReturnType<typeof createScriptablePackSourceSnapshot>,
) {
  const result = await loadScriptablePack(source, { metadataOnly: true, sourceSnapshot: snapshot });
  if (!result.ok) throw result.error;
  return result.value;
}
async function build(
  f: Parameters<Parameters<typeof withFixture>[0]>[0],
  snapshot: ReturnType<typeof createScriptablePackSourceSnapshot>,
  definition: Awaited<ReturnType<typeof metadata>>,
) {
  const lazy = createLazyScriptablePackDefinition({
    sourcePath: f.source,
    definition,
    sourceClosure: await snapshot.inventory(f.source),
    sourceSnapshot: snapshot,
    executors: f.pool,
  });
  const result = await lazy.build({
    packageId: definition.packageId,
    readByGuid: async () => {
      throw new Error('unexpected external fixture read');
    },
  } as never);
  if (!result.ok) throw result.error;
  return result.value;
}
async function retired(f: Parameters<Parameters<typeof withFixture>[0]>[0]) {
  await f.pool.dispose();
  for (const worker of f.workers) expect(worker.threadId).toBe(-1);
  for (const directory of f.roots)
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
}
function expectPod(value: unknown, expected = [1, 3, 3, 4]) {
  expect(value).toEqual({
    texture: {
      kind: 'texture',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mipmap: false,
      data: new Uint8Array(expected),
    },
  });
}

it('evaluates metadata once per source snapshot and rejects a silent edit before publication', async () => {
  await withFixture(async (f) => {
    const snapshot = createScriptablePackSourceSnapshot();
    const first = await metadata(f.source, snapshot);
    const repeated = await metadata(f.source, snapshot);
    expect(repeated.packageId).toEqual(first.packageId);
    expect(f.loaded).toHaveLength(1);
    expect(await snapshot.verify()).toEqual({ ok: true, value: undefined });

    await writeFile(f.source, `${await readFile(f.source, 'utf8')}\n// edited without a watcher\n`);
    expect(await snapshot.verify()).toMatchObject({
      ok: false,
      error: { code: 'pack-source-revision-conflict' },
    });

    const next = createScriptablePackSourceSnapshot();
    await metadata(f.source, next);
    expect(f.loaded).toHaveLength(2);
    expect(await next.verify()).toEqual({ ok: true, value: undefined });
  });
});

it('shares one metadata evaluation across the published scanner and Catalog entrypoints', async () => {
  await withFixture(async (f) => {
    const snapshot = createScriptablePackSourceSnapshot();
    const { scanInventory } = await import('../../dist/scanner.mjs');
    const { buildCatalogProjection } = await import('../../dist/build.mjs');
    const scanOptions = { scriptablePack: { metadataOnly: true, sourceSnapshot: snapshot } };
    expect((await scanInventory([f.root], scanOptions)).ok).toBe(true);
    const catalogOptions = {
      scanOptions: {
        scriptablePack: { metadataOnly: true, timeoutMs: 120_000, sourceSnapshot: snapshot },
      },
      importerPolicy: () => ({
        disposition: 'publish' as const,
        expected: 'fixture importer',
        hint: 'fixture importer',
      }),
    };
    const catalog = await buildCatalogProjection([f.root], catalogOptions);
    expect(catalog.authority).toBe('authoritative');
    expect(f.loaded).toHaveLength(1);
    expect(await snapshot.verify()).toEqual({ ok: true, value: undefined });

    await writeFile(f.source, `${await readFile(f.source, 'utf8')}\n// silent edit\n`);
    const stale = await buildCatalogProjection([f.root], catalogOptions);
    expect(stale.authority).toBe('degraded');
    expect(f.loaded).toHaveLength(1);
  });
});

it('actual metadata to lazy fresh realm preserves POD/import identity and transports exact unrewritten compiler text', async () => {
  await withFixture(async (f) => {
    const snapshot = createScriptablePackSourceSnapshot();
    const definition = await metadata(f.source, snapshot);
    const value = await build(f, snapshot, definition);
    expectPod(value);
    expect(await snapshot.verify()).toEqual({ ok: true, value: undefined });
    await retired(f);
    expect(f.loaded).toHaveLength(2);
    expect(f.workers.size).toBe(2);
    // Baseline meaningful RED occurs here, after successful actual metadata/body/cleanup.
    const first = f.loaded[0];
    if (first === undefined) throw new Error('missing native cold metadata message');
    expect(Array.isArray(first.transpiles)).toBe(true);
    const entries = first.transpiles;
    if (entries === undefined) throw new Error('missing derived-text wire');
    expect(entries.map((entry) => entry.filename)).not.toContain(join(f.root, 'type-only.ts'));
    expect(entries.some((entry) => entry.filename === f.source)).toBe(true);
    for (const entry of entries) {
      const original = await snapshot.readText(entry.filename);
      const native = ts.transpileModule(original, {
        fileName: entry.filename,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          isolatedModules: true,
          sourceMap: false,
        },
        reportDiagnostics: true,
      });
      expect(
        native.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error),
      ).toEqual([]);
      expect(entry.outputText).toBe(native.outputText);
      expect(entry.outputDigest).toBe(digest(native.outputText));
      expect(entry.sourceDigest).toBe(digest(original));
      expect(entry.outputText).not.toContain('forgeax-scriptable-pack-');
      expect(entry.outputText).not.toContain('?load=');
    }
    expect(f.posted).toHaveLength(2);
    expect(f.posted[0]?.transpiles).toEqual([]);
    expect(f.posted[1]?.transpiles).toEqual(entries);
    expect(f.loaded[1]?.transpiles).toEqual(entries);
  });
});

it('retains captured generation after same-size mtime-preserved mutation and gives the next snapshot no old text', async () => {
  await withFixture(async (f) => {
    const old = createScriptablePackSourceSnapshot();
    const definition = await metadata(f.source, old);
    const oldClosure = await old.inventory(f.source);
    const before = await stat(f.dependency);
    const body = await readFile(f.dependency, 'utf8');
    await writeFile(f.dependency, body.replace('value: 3', 'value: 5'));
    await utimes(f.dependency, before.atime, before.mtime);
    expect(await old.inventory(f.source)).toEqual(oldClosure);
    expect(await old.verify()).toMatchObject({
      ok: false,
      error: { code: 'pack-source-revision-conflict' },
    });
    expectPod(await build(f, old, definition));
    const fresh = createScriptablePackSourceSnapshot();
    expect(await fresh.inventory(f.source)).not.toEqual(oldClosure);
    const executor = await f.pool.acquire();
    const result = await loadScriptablePack(f.source, { executor, sourceSnapshot: fresh });
    if (!result.ok) throw result.error;
    const output = await result.value.build({
      packageId: result.value.packageId,
      readByGuid: async () => {
        throw new Error('unexpected fixture read');
      },
    } as never);
    if (!output.ok) throw output.error;
    expectPod(output.value, [1, 5, 5, 4]);
    expect(f.posted).toHaveLength(3);
    expect(f.posted[0]?.transpiles).toEqual([]);
    expect(f.posted[2]?.transpiles).toEqual([]);
    expect(await fresh.verify()).toEqual({ ok: true, value: undefined });
    await retired(f);
  });
});

it('reuses derived text without reusing module instances across later loadId on one real Worker', async () => {
  await withFixture(async (f) => {
    const reusable = createScriptablePackModuleExecutorPool({
      maxWorkers: 1,
      maxTasksPerWorker: 2,
    });
    try {
      const snapshot = createScriptablePackSourceSnapshot();
      const definition = await metadata(f.source, snapshot);
      const sameWorkerFixture = { ...f, pool: reusable };
      expectPod(await build(sameWorkerFixture, snapshot, definition));
      expectPod(await build(sameWorkerFixture, snapshot, definition), [2, 3, 3, 4]);
      expect(f.workers.size).toBe(2); // one retired metadata realm, one two-task realm
      expect(f.posted).toHaveLength(3);
      expect(f.posted[0]?.transpiles).toEqual([]);
      expect(f.posted[1]?.transpiles).toEqual(f.posted[2]?.transpiles);
      expect(f.loaded[1]?.transpiles).toEqual(f.loaded[2]?.transpiles);
      await retired(sameWorkerFixture);
    } finally {
      await reusable.dispose();
    }
  });
});

it('actually imports coherent warm derived text rather than ignoring transport and compiling cold again', async () => {
  await withFixture(async (f) => {
    const snapshot = createScriptablePackSourceSnapshot();
    const definition = await metadata(f.source, snapshot);
    // Negative control: unchanged real author source executes and emits original POD.
    expectPod(await build(f, snapshot, definition));
    const marker = 'owned-warm-cache-hit-marker';
    let injected = 0;
    f.corrupt((entries) =>
      entries.map((entry) => {
        if (entry.filename !== f.source) return entry;
        injected += 1;
        const outputText = `${entry.outputText}\nthrow new Error(${JSON.stringify(marker)});\n`;
        return { ...entry, outputText, outputDigest: digest(outputText) };
      }),
    );
    const lazy = createLazyScriptablePackDefinition({
      sourcePath: f.source,
      definition,
      sourceClosure: await snapshot.inventory(f.source),
      sourceSnapshot: snapshot,
      executors: f.pool,
    });
    const result = await lazy.build({
      packageId: definition.packageId,
      readByGuid: async () => {
        throw new Error('unexpected fixture read');
      },
    } as never);
    expect(injected).toBe(1);
    // An always-cold implementation succeeds here and fails this actual native HIT falsifier.
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'pack-parameter-invalid',
        detail: {
          phase: 'module-load',
          sourcePath: f.source,
          diagnostic: expect.stringContaining(marker),
        },
      },
    });
    expect(await snapshot.verify()).toEqual({ ok: true, value: undefined });
    await retired(f); // includes compileRoot from failed reusable load's real postMessage
  });
});

for (const field of [
  'outputText',
  'outputDigest',
  'key',
  'recipeDigest',
  'filename',
  'sourceDigest',
] as const) {
  it(`actual reusable load cold-falls back after ${field} transport corruption`, async () => {
    await withFixture(async (f) => {
      const snapshot = createScriptablePackSourceSnapshot();
      const definition = await metadata(f.source, snapshot);
      f.corrupt((entries) =>
        entries.map((entry) => ({
          ...entry,
          [field]:
            field === 'outputText'
              ? `${entry.outputText}\nthrow new Error('corrupt text executed');`
              : field === 'filename'
                ? `${entry.filename}.wrong`
                : '0'.repeat(64),
        })),
      );
      expectPod(await build(f, snapshot, definition));
      expect(f.loaded[1]?.transpiles).toEqual(f.loaded[0]?.transpiles);
      await retired(f);
    });
  });
}

it('a real unavailable recipe identity read remains optional, and no-snapshot load makes no identity read', async ({
  signal,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-transpile-identity-denial-')));
  const preloader = join(root, 'deny-optional-identity.cjs');
  const source = join(root, 'identity.pack.ts');
  const runner = join(root, 'run.mjs');
  try {
    await writeFile(
      preloader,
      `const fs = require('node:fs');
      const original = fs.readFileSync;
      fs.readFileSync = function (...args) {
        const stack = new Error().stack || '';
        if (stack.includes('tryTranspileRecipe')) {
          globalThis.fixtureIdentityDenied = (globalThis.fixtureIdentityDenied || 0) + 1;
          const failure = new Error('owned fixture optional identity EACCES'); failure.code = 'EACCES'; throw failure;
        }
        return Reflect.apply(original, this, args);
      };
      require('node:module').syncBuiltinESMExports();`,
    );
    await writeFile(
      source,
      `export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(8),
      name: 'identity-denied:' + (globalThis.fixtureIdentityDenied || 0) + '|' + new URL('.', import.meta.url).href, build: () => ({ ok: true, value: {} }) };`,
    );
    // Only this owning package's fresh worker dist, never a foreign or old engine checkout.
    const ownerModule = new URL('../../dist/scriptable-pack-node.mjs', import.meta.url).href;
    await writeFile(
      runner,
      `import assert from 'node:assert/strict';
      import { Worker } from 'node:worker_threads';
      import { stat, rm } from 'node:fs/promises';
      import { fileURLToPath } from 'node:url';
      import { createScriptablePackSourceSnapshot, loadScriptablePack } from ${JSON.stringify(ownerModule)};
      const wires = [], workers = new Set(), roots = new Set(); const emit = Worker.prototype.emit;
      Worker.prototype.emit = function(event,...args) {
        if(event==='online') workers.add(this);
        if(event==='message' && args[0]?.kind==='loaded') {
          wires.push(args[0]); roots.add(fileURLToPath(args[0].definition.name.split('|')[1]));
        }
        return Reflect.apply(emit,this,[event,...args]);
      };
      try {
        const cold = await loadScriptablePack(${JSON.stringify(source)}, { metadataOnly: true });
        assert.equal(cold.ok,true); assert.equal(cold.value.name.split('|')[0],'identity-denied:0');
        const snapshot = createScriptablePackSourceSnapshot();
        const fallback = await loadScriptablePack(${JSON.stringify(source)}, { metadataOnly:true, sourceSnapshot:snapshot });
        assert.equal(fallback.ok,true); assert.equal(fallback.value.name.split('|')[0],'identity-denied:1');
        assert.deepEqual(wires[1].transpiles,[]);
        assert.equal((await snapshot.verify()).ok,true);
        assert.equal(workers.size,2); for(const worker of workers) assert.equal(worker.threadId,-1);
        for(const directory of roots) await assert.rejects(stat(directory), { code:'ENOENT' });
        process.stdout.write(JSON.stringify({ noSnapshotIdentityReads:0, deniedIdentityReads:1,
          successfulOriginalColdLoads:2, cacheEntries:0, retiredWorkers:2 }));
      } finally { Worker.prototype.emit=emit; await Promise.all([...workers].map(w=>w.terminate()));
        await Promise.all([...roots].map(directory=>rm(directory,{recursive:true,force:true}))); }`,
    );
    const result = await runFile(process.execPath, ['--require', preloader, runner], { signal });
    expect(JSON.parse(result.stdout)).toEqual({
      noSnapshotIdentityReads: 0,
      deniedIdentityReads: 1,
      successfulOriginalColdLoads: 2,
      cacheEntries: 0,
      retiredWorkers: 2,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('malformed current author syntax still reports real TS owner and cleans its Worker', async () => {
  await withFixture(async (f) => {
    await writeFile(f.source, 'export const invalid = ;');
    const snapshot = createScriptablePackSourceSnapshot();
    const executor = await f.pool.acquire();
    const result = await loadScriptablePack(f.source, {
      executor,
      metadataOnly: true,
      sourceSnapshot: snapshot,
    });
    expect(f.roots.size).toBe(1); // real reusable load message, even though loaded never arrives
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'pack-parameter-invalid',
        detail: {
          phase: 'module-load',
          sourcePath: f.source,
          diagnostic: expect.stringContaining('TypeScript transpile failed'),
        },
      },
    });
    await retired(f);
  });
});
