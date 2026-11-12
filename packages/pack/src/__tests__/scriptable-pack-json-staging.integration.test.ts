import { unlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import {
  createScriptablePackModuleExecutorPool,
  createScriptablePackSourceSnapshot,
  loadScriptablePack,
} from '../scriptable-pack-node.js';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const declaration = (imports: string, name: string, body = 'return { ok: true, value: {} };') =>
  `${imports}\nexport default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1), name: ${name}, async build() { ${body} } };`;

it('keeps captured JSON text out of the Worker message while preserving canonical and raw observations', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-json-staging-')));
  const source = join(root, 'owner.pack.ts'),
    data = join(root, 'data.json');
  const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 1 });
  const messages: {
    sources: Record<string, string>;
    jsonInputs: Record<string, unknown>;
    compileRoot: string;
  }[] = [];
  const original = Worker.prototype.postMessage;
  const posted = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    if (args[0]?.kind === 'load' && args[0].sourcePath === source) messages.push(args[0]);
    return Reflect.apply(original, this, args);
  });
  const raw = ' { "__proto__": {"safe":true}, "zero":-0, "overflow":1e400, "name":"captured" }\r\n';
  try {
    await writeFile(data, raw);
    await writeFile(
      source,
      declaration(
        "import config from './data.json'; import raw from './data.json?raw';",
        'JSON.stringify({config,raw,negativeZero:Object.is(config.zero,-0),ownProto:Object.hasOwn(config,"__proto__")})',
      ),
    );
    const snapshot = createScriptablePackSourceSnapshot();
    await snapshot.moduleSources(source);
    await writeFile(data, '{"name":"live replacement"}');
    const loaded = await loadScriptablePack(source, {
      sourceSnapshot: snapshot,
      executor: await pool.acquire(),
      metadataOnly: true,
    });
    if (!loaded.ok) throw loaded.error;
    if (loaded.value.name === undefined) throw new Error('Missing projected observations');
    expect(JSON.parse(loaded.value.name)).toEqual({
      config: JSON.parse(JSON.stringify(JSON.parse(raw))),
      raw,
      negativeZero: false,
      ownProto: true,
    });
    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message === undefined) throw new Error('Missing Worker load message');
    expect(message.sources[data]).toBeUndefined();
    expect(message.jsonInputs[data]).toBeDefined();
    await expect(access(message.compileRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    posted.mockRestore();
    await pool.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves raw captured UTF-16 code units that cannot roundtrip through UTF-8', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-json-codeunits-')));
  try {
    const source = join(root, 'owner.pack.ts'),
      data = join(root, 'data.json');
    await writeFile(data, '{}');
    await writeFile(
      source,
      declaration("import raw from './data.json?raw';", 'JSON.stringify(raw)'),
    );
    const snapshot = createScriptablePackSourceSnapshot(),
      captured = await snapshot.moduleSources(source);
    const raw = '{"text":"' + '\ud800' + '"}\n';
    const loaded = await loadScriptablePack(source, {
      metadataOnly: true,
      sourceSnapshot: {
        ...snapshot,
        moduleSources: async () => ({ ...captured, sources: { ...captured.sources, [data]: raw } }),
      },
    });
    if (!loaded.ok) throw loaded.error;
    if (loaded.value.name === undefined) throw new Error('Missing raw observation');
    expect(JSON.parse(loaded.value.name)).toBe(raw);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('defers malformed on-demand JSON for static metadata and preserves malformed raw text', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-json-malformed-')));
  const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 1 });
  try {
    const source = join(root, 'owner.pack.ts'),
      data = join(root, 'data.json'),
      raw = '{ broken JSON';
    await writeFile(data, raw);
    await writeFile(source, declaration('', '"metadata"', "return await import('./data.json');"));
    const snapshot = createScriptablePackSourceSnapshot();
    const metadata = await loadScriptablePack(source, {
      metadataOnly: true,
      sourceSnapshot: snapshot,
    });
    expect(metadata.ok).toBe(true);
    const full = await loadScriptablePack(source, {
      metadataOnly: true,
      sourceSnapshot: snapshot,
      executor: await pool.acquire(),
    });
    expect(full).toMatchObject({ ok: false, error: { detail: { phase: 'module-load' } } });
    await writeFile(source, declaration("import raw from './data.json?raw';", 'raw'));
    const rawLoad = await loadScriptablePack(source, {
      metadataOnly: true,
      sourceSnapshot: createScriptablePackSourceSnapshot(),
    });
    if (!rawLoad.ok) throw rawLoad.error;
    expect(rawLoad.value.name).toBe(raw);
  } finally {
    await pool.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  'missing',
  'corrupt',
] as const)('rejects a %s captured artifact without returning to the live author file', async (mode) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-json-integrity-')));
  const source = join(root, 'owner.pack.ts'),
    data = join(root, 'data.json');
  const directories: string[] = [],
    original = Worker.prototype.postMessage;
  const posted = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    const message = args[0];
    if (message?.kind === 'load' && message.sourcePath === source) {
      directories.push(message.compileRoot);
      const artifact = join(message.compileRoot, message.jsonInputs[data].canonical.file);
      if (mode === 'missing') unlinkSync(artifact);
      else writeFileSync(artifact, '{"name":"corrupt"}');
    }
    return Reflect.apply(original, this, args);
  });
  try {
    await writeFile(data, '{"name":"original"}');
    await writeFile(source, declaration("import data from './data.json';", 'data.name'));
    const loaded = await loadScriptablePack(source, {
      metadataOnly: true,
      sourceSnapshot: createScriptablePackSourceSnapshot(),
    });
    expect(loaded).toMatchObject({ ok: false, error: { detail: { phase: 'module-load' } } });
    for (const directory of directories)
      await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    posted.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('waits for in-flight staging before timeout cleanup and never posts the retired load', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-json-staging-timeout-')));
  const source = join(root, 'owner.pack.ts');
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
      .writeFile,
    directories = new Set<string>();
  let postedLoad = false;
  const postMessage = Worker.prototype.postMessage;
  const posted = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    if (args[0]?.kind === 'load' && args[0].sourcePath === source) postedLoad = true;
    return Reflect.apply(postMessage, this, args);
  });
  let restoreWriting: (() => void) | undefined;
  try {
    await writeFile(join(root, 'data.json'), '{"name":"captured"}');
    await writeFile(source, declaration("import data from './data.json';", 'data.name'));
    const snapshot = createScriptablePackSourceSnapshot();
    await snapshot.moduleSources(source);
    const writing = vi
      .mocked(fs.writeFile)
      .mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        if (String(args[0]).includes('captured-json-')) {
          directories.add(String(args[0]).replace(/[\\/][^\\/]+$/, ''));
          entered.resolve();
          await release.promise;
        }
        return original(...args);
      });
    restoreWriting = () => {
      writing.mockImplementation(original);
    };
    const pending = loadScriptablePack(source, {
      sourceSnapshot: snapshot,
      metadataOnly: true,
      timeoutMs: 30,
    });
    const stagingStarted = await Promise.race([
      entered.promise.then(() => true),
      pending.then(() => false),
    ]);
    if (!stagingStarted) throw new Error('Load completed before staging was observed');
    await delay(50);
    expect(postedLoad).toBe(false);
    release.resolve();
    expect(await pending).toMatchObject({
      ok: false,
      error: { detail: { reason: 'timeout', phase: 'module-load' } },
    });
    for (const directory of directories)
      await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release.resolve();
    restoreWriting?.();
    posted.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('passes the original captured record to public custom executors', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-json-custom-')));
  try {
    const source = join(root, 'owner.pack.ts'),
      data = join(root, 'data.json'),
      text = ' { "name": "custom" } ';
    await writeFile(source, declaration("import data from './data.json';", 'data.name'));
    await writeFile(data, text);
    const load = vi.fn(async () => ({
      default: {
        schemaVersion: '2.0.0',
        packageId: new Uint8Array(16).fill(1),
        build: () => ({ ok: true, value: {} }),
      },
    }));
    const dispose = vi.fn();
    const result = await loadScriptablePack(source, {
      sourceSnapshot: createScriptablePackSourceSnapshot(),
      metadataOnly: true,
      executor: { load, dispose },
    });
    expect(result.ok).toBe(true);
    expect((load.mock.calls[0] as unknown as [string, Record<string, string>])[1][data]).toBe(text);
    expect(dispose).toHaveBeenCalledWith('complete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
