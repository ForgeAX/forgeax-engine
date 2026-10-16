import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BuildDdcInput,
  DdcEntryStore,
  type DdcHead,
  DdcLifecycle,
  ddcOutputDigest,
  semanticBuildKey,
} from '@forgeax/engine-ddc';
import {
  ImporterRegistry,
  type ImportRunnerFs,
  type RunImportMeta,
  type RunImportResult,
  runImport,
} from '@forgeax/engine-import';
import type { Asset, ImportContext, ImportedAsset, SourceOverrideMap } from '@forgeax/engine-types';

export const SOURCE_OVERRIDE_FIXTURE_GUID = '11111111-1111-4111-8111-111111111111';

export interface SourceOverrideFixture {
  readonly received: { value?: SourceOverrideMap };
  readonly registry: ImporterRegistry;
  readonly fs: ImportRunnerFs;
  meta(sourceOverrides?: SourceOverrideMap): RunImportMeta;
  run(sourceOverrides?: SourceOverrideMap): Promise<RunImportResult>;
  semantic(sourceOverrides?: SourceOverrideMap): BuildDdcInput;
  publish(
    root: string,
    sourceOverrides?: SourceOverrideMap,
  ): Promise<{ readonly key: string; readonly head: DdcHead; readonly lifecycle: DdcLifecycle }>;
  fail(
    root: string,
    sourceOverrides: SourceOverrideMap,
    failure?: { readonly code: string; readonly detail: string },
  ): Promise<{ readonly key: string; readonly head: DdcHead; readonly lifecycle: DdcLifecycle }>;
}

function asset(): ImportedAsset {
  return {
    guid: SOURCE_OVERRIDE_FIXTURE_GUID,
    kind: 'mesh',
    payload: { vertices: new Float32Array(), indices: new Uint16Array(), attributes: {} } as Asset,
    refs: [],
    artifacts: {},
  };
}

async function writePack(root: string, key: string, payload: unknown): Promise<void> {
  const entry = {
    key,
    guid: SOURCE_OVERRIDE_FIXTURE_GUID,
    payload,
    refs: [],
    artifacts: {},
    receipt: {
      guid: SOURCE_OVERRIDE_FIXTURE_GUID,
      key,
      producer: 'source-overrides-fixture',
      inputFingerprint: key,
      outputDigest: '',
    },
  };
  await new DdcEntryStore(root).write({
    ...entry,
    receipt: { ...entry.receipt, outputDigest: ddcOutputDigest(entry) },
  });
}

export function createSourceOverrideProducerFixture(): SourceOverrideFixture {
  const received: { value?: SourceOverrideMap } = {};
  const registry = new ImporterRegistry();
  registry.register({
    key: 'fixture',
    import: (ctx: ImportContext) => {
      if (ctx.sourceOverrides === undefined) delete received.value;
      else received.value = ctx.sourceOverrides;
      return {
        ok: true,
        value: { assets: [asset()], sourceDependencies: [] },
      };
    },
  });
  const fs: ImportRunnerFs = {
    readSource: async () => ({ ok: true as const, value: new Uint8Array([1, 2, 3]) }),
  };

  const fixture: SourceOverrideFixture = {
    received,
    registry,
    fs,
    meta(sourceOverrides) {
      return {
        importer: 'fixture',
        source: 'fixture.source',
        ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
        subAssets: [
          {
            guid: SOURCE_OVERRIDE_FIXTURE_GUID,
            sourceIndex: 0,
            sourceKey: 'mesh/main',
            kind: 'mesh',
          },
        ],
      };
    },
    run(sourceOverrides) {
      return runImport(fixture.meta(sourceOverrides), registry, fs);
    },
    semantic(sourceOverrides) {
      return {
        schemaVersion: '2.0.0',
        importerVersion: 'source-overrides-fixture@1',
        codecVersion: 'fixture-codec@1',
        sourceDependencies: [{ path: 'fixture.source', digest: 'source-digest' }],
        settings: { profile: 'fixture' },
        declaredGuids: [SOURCE_OVERRIDE_FIXTURE_GUID],
        cookProfile: 'fixture',
        ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
      };
    },
    async publish(root, sourceOverrides) {
      const result = await fixture.run(sourceOverrides);
      if (!result.ok || 'skipped' in result.value) {
        throw new Error('source override fixture expected a successful import');
      }
      const key = semanticBuildKey(fixture.semantic(sourceOverrides));
      await writePack(root, key, result.value.pack);
      const lifecycle = new DdcLifecycle(root);
      const lease = await lifecycle.begin(SOURCE_OVERRIDE_FIXTURE_GUID, key);
      await lifecycle.commit(lease, key);
      return { key, lifecycle, head: await lifecycle.inspect(SOURCE_OVERRIDE_FIXTURE_GUID, key) };
    },
    async fail(
      root,
      sourceOverrides,
      failure = { code: 'validation-failed', detail: 'fixture failure' },
    ) {
      const key = semanticBuildKey(fixture.semantic(sourceOverrides));
      const lifecycle = new DdcLifecycle(root);
      const lease = await lifecycle.begin(SOURCE_OVERRIDE_FIXTURE_GUID, key);
      await lifecycle.fail(lease, failure);
      return { key, lifecycle, head: await lifecycle.inspect(SOURCE_OVERRIDE_FIXTURE_GUID, key) };
    },
  };
  return fixture;
}

export async function createTemporaryFixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forgeax-source-overrides-fixture-'));
}
