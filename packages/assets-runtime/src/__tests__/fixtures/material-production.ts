import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, posix, resolve } from 'node:path';
import {
  type BuildProductionFile,
  ImporterRegistry,
  produceBuildAssets,
} from '@forgeax/engine-import';
import { serializeCookedMaterialRecord } from '@forgeax/engine-pack';
import { planAssetBundles } from '../../../../devkit/src/delivery-bundles';
import { materialRecordFixture } from './material-publication.js';

export async function materialProductionFixture(external = true, record = materialRecordFixture()) {
  const root = resolve('/fixture');
  const sourcePath = resolve(root, 'materials.pack.json');
  const files = new Map<string, BuildProductionFile>();
  const original = JSON.parse(serializeCookedMaterialRecord(record));
  const authored = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: record.guid,
        kind: 'material',
        execution: 'cooked',
        payload: { kind: 'material', ...record.resolved },
        refs: [],
      },
    ],
  } as const;
  const entries = await produceBuildAssets({
    inventory: {
      schemaVersion: 'catalog-legacy-v1',
      authority: 'authoritative',
      diagnostics: [],
      declarations: new Map(),
      entries: [
        { guid: record.guid, kind: 'material', packageUrl: '/source.pack.json', sourcePath },
      ],
      sourceDeclarations: new Map([
        [
          sourcePath,
          {
            format: 'pack.json',
            sourceRevision: 'fixture-revision',
            sourcePath,
            sourceText: JSON.stringify(authored),
            value: authored,
          },
        ],
      ]),
    },
    cwd: root,
    basePrefix: '',
    generation: 7,
    importerRegistry: new ImporterRegistry(),
    fsForImport: {
      readSource: async () => {
        throw new Error('captured declaration must be used');
      },
    },
    cookedCurrentProjection: {},
    directCurrentProjection: {},
    authoredCookedCurrentProjection: {},
    cookers: [
      {
        key: 'material',
        cook: () => ({
          guid: record.guid,
          payload: { kind: 'material', ...record.resolved, cooked: original },
          refs: [],
          artifacts: external
            ? Object.fromEntries(
                record.programs.map(({ artifact }) => [
                  artifact.path,
                  { mediaType: artifact.mediaType, bytes: artifact.bytes },
                ]),
              )
            : {},
          inputFingerprint: 'fixture-cooker',
        }),
      },
    ],
    sink: {
      emitFile(file) {
        const name = file.fileName ?? file.name;
        if (!name) throw new Error('missing emitted path');
        files.set(name, file);
        return name;
      },
      getFileName: (ref) => ref,
      fileUrl: (name) => `/${name}`,
    },
    fail: (failure) => new Error(JSON.stringify(failure)),
  });
  const entry = entries[0];
  const firstProgram = record.programs[0];
  if (!entry || !firstProgram) throw new Error('missing actual material output');
  const file = files.get(entry.packageUrl.slice(1));
  if (!file) throw new Error('missing actual emitted Pack');
  const emitted =
    typeof file.source === 'string'
      ? file.source
      : new TextDecoder('utf-8', { fatal: true }).decode(file.source);
  return {
    record,
    original,
    entries,
    entry,
    firstProgram,
    files,
    pack: JSON.parse(emitted),
    emitted,
  };
}

/** Import emits loose artifacts; DevKit owns the actual player Bundle projection. */
export async function bundleMaterialFixture(
  fixture: Awaited<ReturnType<typeof materialProductionFixture>>,
) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-material-bundle-'));
  try {
    const artifacts = new Map();
    for (const [path, file] of fixture.files) {
      const bytes = typeof file.source === 'string' ? Buffer.from(file.source) : file.source;
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await writeFile(resolve(root, path), bytes);
      artifacts.set(path, {
        path,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mediaType: path.endsWith('.json') ? 'application/json' : 'text/wgsl',
      });
    }
    const output = await planAssetBundles({
      sourceRoot: root,
      outputRoot: root,
      artifacts,
      catalog: fixture.entries,
      packIndexPath: 'pack-index.json',
      delivery: {},
      pathOf: (url, from) =>
        url.startsWith('/') ? url.slice(1) : posix.join(posix.dirname(from), url),
    });
    for (const file of output.written)
      fixture.files.set(file.path, {
        type: 'asset',
        fileName: file.path,
        source: await readFile(resolve(root, file.path)),
      });
    fixture.pack = JSON.parse(
      await readFile(resolve(root, fixture.entry.packageUrl.slice(1)), 'utf8'),
    );
    return output.report;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
