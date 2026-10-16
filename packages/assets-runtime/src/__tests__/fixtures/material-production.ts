import { resolve } from 'node:path';
import {
  type BuildProductionFile,
  ImporterRegistry,
  produceBuildAssets,
} from '@forgeax/engine-import';
import { serializeCookedMaterialRecord } from '@forgeax/engine-pack';
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
