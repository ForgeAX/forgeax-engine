import { join } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';
import { pluginPack } from '@forgeax/engine/vite-plugin-pack';
import { defineFeature } from '../../lab/feature';
import { type FixtureFiles, withFixture } from './support/fixture';

const PACKAGE = '0190a1b2-0000-7000-8000-00000000b201';
const GENERATED = '0190a1b2-0000-7000-8000-00000000b202';

interface Emitted {
  readonly fileName?: string;
  readonly name?: string;
  readonly source?: string | Uint8Array;
}
interface IndexRow {
  readonly guid: string;
  readonly kind: string;
  readonly packageUrl: string;
  readonly sourceKey?: string;
  readonly publication?: {
    readonly outputs: ReadonlyArray<{ readonly sourceKey: string; readonly digest: string }>;
  };
}

const files = (magFilter: string): FixtureFiles => ({
  'forge.json': JSON.stringify({
    schemaVersion: '3.0.0',
    id: 'feature-lab-pack-index',
    name: 'Pack index',
    roots: {},
  }),
  'assets/direct.pack.json': JSON.stringify({
    schemaVersion: '3.0.0',
    packageId: PACKAGE,
    assets: { 'sampler/direct': { kind: 'sampler', payload: { magFilter }, refs: [] } },
  }),
  'assets/generated.pack.ts': `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${GENERATED}'),
  build: () => ok({ 'sampler/generated': { kind: 'sampler', magFilter: 'nearest' } }),
});
`,
});

async function build(magFilter: string): Promise<{ emitted: Emitted[]; failure?: string }> {
  return withFixture(files(magFilter), async (root) => {
    const previous = process.cwd();
    process.chdir(root);
    const plugin = pluginPack({
      roots: [join(root, 'assets')],
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
    });
    const emitted: Emitted[] = [];
    try {
      await (plugin.generateBundle as unknown as (this: unknown) => Promise<void>).call({
        emitFile(asset: Emitted) {
          emitted.push(asset);
          return asset.fileName ?? asset.name ?? 'asset';
        },
        getFileName(referenceId: string) {
          return `assets/${referenceId}-hash`;
        },
      } as never);
      return { emitted };
    } catch (error) {
      return { emitted, failure: String((error as { code?: unknown }).code ?? error) };
    } finally {
      await (plugin.closeBundle as unknown as () => Promise<void>)();
      process.chdir(previous);
    }
  });
}

function index(emitted: readonly Emitted[]): IndexRow[] {
  const file = emitted.find((asset) => asset.fileName === 'pack-index.json');
  return file === undefined ? [] : (JSON.parse(String(file.source)) as IndexRow[]);
}

function derived(packageId: string, sourceKey: string): string {
  const id = PackageId.parse(packageId);
  return id.ok ? AssetGuid.format(AssetGuid.derive(id.value, sourceKey)) : 'invalid';
}

export default defineFeature({
  title: 'Pack index',
  catalog: 'Pack index',
  kind: 'headless',
  summary:
    'Vite build emits pack-index.json as a projection of producer facts with hashed package locators.',
  expect:
    'Direct and ScriptablePack outputs appear once each under derived GUIDs; locators point at emitted hashed bodies.',
  async run(checks) {
    const first = await build('linear');
    checks.equal('build succeeds', first.failure ?? 'ok', 'ok');
    const rows = index(first.emitted);
    checks.equal(
      'index rows are the two derived GUIDs',
      rows.map((row) => row.guid.toLowerCase()).sort(),
      [derived(PACKAGE, 'sampler/direct'), derived(GENERATED, 'sampler/generated')].sort(),
    );
    const names = new Set(first.emitted.map((asset) => asset.fileName ?? asset.name ?? ''));
    checks.ok(
      'every packageUrl names a hashed emitted file',
      rows.length > 0 && rows.every((row) => row.packageUrl.endsWith('-hash')),
      rows.map((row) => row.packageUrl).join(', '),
    );
    checks.ok('Pack v2 bodies are emitted beside the index', names.size > 1, [...names].join(', '));

    const second = await build('nearest');
    const digest = (items: readonly IndexRow[]) =>
      items
        .find((row) => row.sourceKey === 'sampler/direct')
        ?.publication?.outputs.find((output) => output.sourceKey === 'sampler/direct')?.digest;
    checks.equal(
      'GUIDs survive a content edit',
      index(second.emitted)
        .map((row) => row.guid)
        .sort(),
      rows.map((row) => row.guid).sort(),
    );
    checks.ok(
      'content edit changes the producer output digest',
      digest(rows) !== undefined &&
        digest(index(second.emitted)) !== undefined &&
        digest(rows) !== digest(index(second.emitted)),
      `${digest(rows)} -> ${digest(index(second.emitted))}`,
    );
    checks.ok(
      'one producer receipt is emitted per output GUID',
      rows.every((row) => names.has(`assets/${row.guid.toLowerCase()}.receipt.json`)),
    );
  },
});
