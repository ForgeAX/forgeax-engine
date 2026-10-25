// @perf-budget-skip: bundles the published standards entry and native UI consumer into an isolated realm.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createContext, runInContext } from 'node:vm';
import { build } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';

const NativeEncoder = TextEncoder;
const NativeDecoder = TextDecoder;
const NativeURL = URL;
let temporary: string;
let encoding: {
  TextEncoder: typeof TextEncoder;
  TextDecoder: typeof TextDecoder;
  URL: typeof URL;
  URLSearchParams: typeof URLSearchParams;
  runtimeMesh(): Promise<{
    guid: string;
    generations: number[];
    bounds: number[][];
    typed: boolean;
  }>;
  nativeUi: boolean;
};

beforeAll(async () => {
  const owner = resolve(import.meta.dirname, '../..');
  temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-wechat-encoding-'));
  // Use the package's actual publication config, without writing shared dist.
  await promisify(execFile)('pnpm', ['exec', 'tsup', '--out-dir', temporary, '--silent'], {
    cwd: owner,
    maxBuffer: 1024 * 1024,
  });
  // The first entry must execute before any Engine chunks and native globals.
  const standards = await readFile(resolve(temporary, 'standards.mjs'), 'utf8');
  const standalone = createContext({ setTimeout, clearTimeout });
  // Removing only the published export leaves any external import as a syntax
  // error, and evaluates the complete bootstrap with no native encoders.
  runInContext(
    `(function () { 'use strict';
    ${standards.replace('export { installWechatStandards };', '')}
    installWechatStandards().unwrap();
  })()`,
    standalone,
  );
  expect(runInContext('typeof TextEncoder', standalone)).toBe('function');
  expect(runInContext('typeof TextDecoder', standalone)).toBe('function');
  await symlink(resolve(owner, 'node_modules'), resolve(temporary, 'node_modules'), 'dir');
  const entry = resolve(temporary, 'bootstrap.js');
  const meshProgram =
    "import { createBoxGeometry } from '@forgeax/engine-geometry'; export function build({ values }) { return { ok: true, value: { mesh: createBoxGeometry(values.width, 2, 3).unwrap() } }; }";
  await writeFile(resolve(temporary, 'mesh-program.mjs'), meshProgram);
  await writeFile(
    entry,
    `export const ready = import('./standards.mjs').then(({ installWechatStandards }) => {
      installWechatStandards().unwrap();
      return import(${JSON.stringify(resolve(owner, '../ui-blitz/pkg/ui-native.mjs'))});
    }).then(binding => ({ TextEncoder, TextDecoder, URL, URLSearchParams,
      nativeUi: typeof binding.UiDocument === 'function',
      async runtimeMesh() {
        const [{ RuntimePackProducer }, { AssetRegistry, validateAssetPublication },
          { createStaticPackProgramHost, preparePackProgram }, { meshAssetContribution }] = await Promise.all([
          import('@forgeax/engine-import'), import('@forgeax/engine-assets-runtime'),
          import('@forgeax/engine-pack/runtime'), import('@forgeax/engine-geometry')]);
        const parent = '01900000-0000-7000-8000-000000000101';
        const instance = '01900000-0000-7000-8000-000000000102';
        const modules = { 'mesh-program.mjs': ${JSON.stringify(meshProgram)} };
        const imports = { '@forgeax/engine-geometry': { identity: 'native-test', url: 'https://forgeax.package/host/geometry.mjs' } };
        const programHost = createStaticPackProgramHost([{ modules, load: () => import('./mesh-program.mjs') }], imports);
        const producer = new RuntimePackProducer({ scopeId: 'wechat-runtime-url', programHost, imports,
          validate: (publication, fetcher, dependencies) => validateAssetPublication(publication.rows, fetcher,
            { catalog: producer.catalog, fetcher: producer.fetch }, { dependencies, decoders: [meshAssetContribution] }) });
        const assets = new AssetRegistry({ scopeId: 'wechat-runtime-url' });
        assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
        assets.setCatalogSource(producer.catalog, producer.fetch);
        try {
          (await producer.admit({ source: { schemaVersion: '2.0.0', kind: 'scriptable-pack-source',
            source: 'runtime/mesh', packageId: parent, runtime: { dependencies: [] },
            parameters: [{ name: 'width', type: 'f32', default: 1 }], program: 'mesh' },
            programs: { mesh: { artifact: preparePackProgram({ entry: 'mesh-program.mjs', export: 'build', modules,
              imports: { '@forgeax/engine-geometry': 'native-test' } }).unwrap() } }
          })).unwrap();
          const generations = [], bounds = [];
          let guid, handle, typed = true;
          for (const width of [1, 4]) {
            const generated = (await producer.generate({ schemaVersion: '3.0.0', packageId: instance,
              parent, values: { width } })).unwrap();
            const row = producer.rows()[0];
            if (!row || guid && row.guid !== guid) throw new Error('runtime mesh identity changed');
            guid = row.guid;
            if (handle !== undefined) (await assets.reload(handle, { conflict: 'overwrite' })).unwrap();
            handle = (await assets.load(guid, 'mesh')).unwrap();
            const mesh = assets.read(handle).unwrap();
            generations.push(generated.publication.generation);
            bounds.push(Array.from(mesh.aabb));
            typed = typed && mesh.vertices instanceof Float32Array && ArrayBuffer.isView(mesh.indices);
          }
          return { guid, generations, bounds, typed };
        } finally { producer.dispose(); }
      }
    }));`,
  );
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { conditions: ['forgeax-native', 'module', 'browser', 'production'] },
    build: {
      target: 'chrome70',
      modulePreload: false,
      lib: { entry, formats: ['cjs'] },
      write: false,
      rollupOptions: {
        preserveEntrySignatures: 'strict',
        input: entry,
        output: { format: 'cjs' },
      },
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  if (!bundle || !('output' in bundle)) throw new Error('Expected one native bundle');
  const chunk = bundle.output.find((item) => item.type === 'chunk' && item.isEntry);
  if (chunk?.type !== 'chunk') throw new Error('Expected JavaScript output');
  const chunks = new Map(
    bundle.output.flatMap((item) => (item.type === 'chunk' ? [[item.fileName, item.code]] : [])),
  );
  const modules = new Map<string, Record<string, unknown>>();
  const context = createContext({
    setTimeout,
    clearTimeout,
    TextEncoder: undefined,
    TextDecoder: undefined,
    URL: undefined,
    URLSearchParams: undefined,
    Buffer: undefined,
    process: undefined,
    WebAssembly: undefined,
  });
  const load = (name: string): Record<string, unknown> => {
    const cached = modules.get(name);
    if (cached) return cached;
    const code = chunks.get(name);
    if (code === undefined) throw new Error(`Unexpected native import: ${name}`);
    const exports = {};
    modules.set(name, exports);
    runInContext(`(function (require, exports) { ${code}\n })`, context)(
      (id: string) => load(posix.normalize(posix.join(posix.dirname(name), id))),
      exports,
    );
    return exports;
  };
  const exports = load(chunk.fileName) as { ready: Promise<typeof encoding> };
  encoding = await exports.ready;
}, 60_000);

afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

it('installs encoders before loading the real native UI binding without browser or Node globals', () => {
  expect(encoding.nativeUi).toBe(true);
  expect(encoding.TextEncoder).not.toBe(NativeEncoder);
  expect(encoding.TextDecoder).not.toBe(NativeDecoder);
});

it('bootstraps WHATWG URL parsing and live search parameters without native URL globals', () => {
  const url = new encoding.URL(
    '../mesh%20body.bin?label=caf%C3%A9+vase',
    'https://game.invalid/a/b/pack.json',
  );
  const expected = new NativeURL(url.href);
  expect(url.href).toBe('https://game.invalid/a/mesh%20body.bin?label=caf%C3%A9+vase');
  expect(url.searchParams.get('label')).toBe('caf\u00e9 vase');
  url.searchParams.append('tag', '\u4e2d\u6587');
  expected.searchParams.append('tag', '\u4e2d\u6587');
  expect(url.href).toBe(expected.href);
  url.search = '?a=1&a=2';
  expect([...url.searchParams]).toEqual([
    ['a', '1'],
    ['a', '2'],
  ]);
  expect([...new encoding.URLSearchParams(url.searchParams)]).toEqual([
    ['a', '1'],
    ['a', '2'],
  ]);
  expect(() => new encoding.URL('invalid relative URL')).toThrow();
});

it('generates and loads two real native runtime mesh publications after URL bootstrap', async () => {
  const result = await encoding.runtimeMesh();
  expect(result.guid).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.generations).toHaveLength(2);
  expect(
    result.generations.every((generation) => Number.isSafeInteger(generation) && generation > 0),
  ).toBe(true);
  expect(result.generations[1]).not.toBe(result.generations[0]);
  expect(result.bounds).toEqual([
    [-0.5, -1, -1.5, 0.5, 1, 1.5],
    [-2, -1, -1.5, 2, 1, 1.5],
  ]);
  expect(result.typed).toBe(true);
});

it('encodes scalar values and replaces malformed UTF-16 like the native standard', () => {
  for (const text of [
    '',
    'ASCII',
    'a\u20ac\ud83d\ude00\ud800\udc00',
    '\ud800',
    '\udc00',
    'A\ud800B\udc00',
    '\ud800\ud800\udc00',
  ]) {
    expect([...new encoding.TextEncoder().encode(text)]).toEqual([
      ...new NativeEncoder().encode(text),
    ]);
  }
  expect(new encoding.TextEncoder().encoding).toBe('utf-8');
});

it('encodeInto respects capacity, view bounds and UTF-16 read counts without partial characters', () => {
  for (const text of ['a\u20ac\ud83d\ude00z', '\ud800x', '\ud83d\ude00']) {
    for (let capacity = 0; capacity <= 12; capacity++) {
      const expected = new Uint8Array(16).fill(0xcc);
      const actual = new Uint8Array(16).fill(0xcc);
      const reference = new NativeEncoder().encodeInto(text, expected.subarray(2, 2 + capacity));
      expect(new encoding.TextEncoder().encodeInto(text, actual.subarray(2, 2 + capacity))).toEqual(
        reference,
      );
      expect([...actual]).toEqual([...expected]);
    }
  }
});

it('streams split UTF-8 code points and BOM while preserving decoder options and reset', () => {
  const bytes = new NativeEncoder().encode('\ufeffA\u20ac\ud83d\ude00\ufeffZ');
  for (const ignoreBOM of [false, true]) {
    for (let split = 0; split <= bytes.length; split++) {
      const actual = new encoding.TextDecoder(' UTF-8 ', { fatal: true, ignoreBOM });
      const reference = new NativeDecoder(' UTF-8 ', { fatal: true, ignoreBOM });
      expect([actual.encoding, actual.fatal, actual.ignoreBOM]).toEqual(['utf-8', true, ignoreBOM]);
      for (const part of [bytes.subarray(0, split), bytes.subarray(split)]) {
        expect(actual.decode(part, { stream: true })).toBe(
          reference.decode(part, { stream: true }),
        );
      }
      expect(actual.decode()).toBe(reference.decode());
      expect(actual.decode(bytes)).toBe(reference.decode(bytes));
    }
  }
});

it('replaces malformed UTF-8 by maximal subparts and rejects it in fatal mode', () => {
  for (const input of [
    [0xc0, 0xaf],
    [0xed, 0xa0, 0x80],
    [0xe2, 0x28, 0xa1],
    [0xf4, 0x90, 0x80, 0x80],
    [0xe2, 0x82],
  ]) {
    const bytes = Uint8Array.from(input);
    expect(new encoding.TextDecoder().decode(bytes)).toBe(new NativeDecoder().decode(bytes));
    const fatal = new encoding.TextDecoder('utf-8', { fatal: true });
    expect(() => fatal.decode(bytes)).toThrow(expect.objectContaining({ name: 'TypeError' }));
    expect(fatal.decode(Uint8Array.of(65))).toBe('A');
  }
  const pending = new encoding.TextDecoder('utf-8', { fatal: true });
  expect(pending.decode(Uint8Array.of(0xe2, 0x82), { stream: true })).toBe('');
  expect(() => pending.decode()).toThrow(expect.objectContaining({ name: 'TypeError' }));
});

it('decodes UTF-16 in native glue and honors byte views, BOM and incomplete input', () => {
  for (const label of ['utf-16le', 'utf-16be']) {
    for (const input of [
      [0xff, 0xfe, 0x41, 0],
      [0xfe, 0xff, 0, 0x41],
      [0x3d, 0xd8, 0, 0xde],
      [0x00, 0xd8, 0x41, 0],
      [0x41],
    ]) {
      const bytes = Uint8Array.from([0xcc, ...input, 0xcc]);
      const view = new DataView(bytes.buffer, 1, input.length);
      expect(new encoding.TextDecoder(label).decode(view)).toBe(
        new NativeDecoder(label).decode(view),
      );
    }
  }
  expect(() => new encoding.TextDecoder('not-an-encoding')).toThrow(
    expect.objectContaining({ name: 'RangeError' }),
  );
});
