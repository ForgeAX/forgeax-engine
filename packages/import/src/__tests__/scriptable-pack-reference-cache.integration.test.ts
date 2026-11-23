import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, onTestFinished } from 'vitest';
import { AssetOutputProducerRegistry } from '../scriptable-pack.js';
import { buildScriptablePackWorklist } from '../scriptable-pack-build.js';
import { materialAssetOutputProducer } from '../scriptable-pack-output-producers.js';
import { createScriptablePackProductCache } from '../scriptable-pack-product-cache.js';

const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const packageId = definePackageId('01900000-0000-7000-8000-0000000000e7');
const target = AssetGuid.format(AssetGuid.derive(packageId, 'texture/external'));
const content = AssetGuid.derive(packageId, 'scene/content');
const material = {
  kind: 'material',
  parameters: [],
  passes: [{ name: 'forward', program: { module: 'reference_cache::surface' } }],
} as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-reference-cache-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'materials.pack.ts');
  let source = 'source-a';
  let compiler = 'compiler-a/profile-a';
  let currentContent: string | undefined = 'content-a';
  const counts = { builds: 0, cooks: 0, reads: 0 };
  await writeFile(sourcePath, source);
  const run = async (
    options: { available?: boolean; readContent?: boolean; ref?: string } = {},
  ) => {
    const cooker = {
      key: 'material',
      cacheIdentity: () => compiler,
      cook(input: unknown) {
        counts.cooks++;
        const draft = input as { guid: string; source: typeof material };
        return {
          guid: draft.guid,
          payload: draft.source,
          refs: [options.ref ?? target],
          artifacts: {},
          inputFingerprint: digest(compiler),
        };
      },
    };
    const outputs = new AssetOutputProducerRegistry();
    outputs.register(materialAssetOutputProducer);
    const cache = await createScriptablePackProductCache({
      root: join(root, 'ddc'),
      outputVersions: outputs.versions(),
      cookers: [cooker],
      identityRoot: root,
    });
    return buildScriptablePackWorklist({
      subjects: [
        {
          sourcePath,
          sourceClosure: [{ path: sourcePath, digest: digest(source) }],
          publicationGeneration: 1,
          definition: definePack({
            schemaVersion: '2.0.0',
            packageId,
            async build({ readByGuid }) {
              counts.builds++;
              if (options.readContent) {
                const read = await readByGuid(content);
                if (!read.ok) return read;
              }
              return ok({ 'material/main': material });
            },
          }),
        },
      ],
      outputs,
      cookers: [cooker],
      cache,
      availableGuids: new Set(options.available === false ? [] : [target]),
      assetSource: {
        async readByGuid() {
          counts.reads++;
          if (currentContent === undefined)
            return err({
              code: 'asset-not-found',
              expected: 'the current content dependency',
              hint: 'publish the dependency before reusing the cached product',
            });
          return ok({
            asset: { kind: 'scene' as const, entities: {} },
            generation: 1,
            digest: digest(currentContent),
          });
        },
      },
    });
  };
  return {
    run,
    counts,
    async changeSource() {
      source = 'source-b';
      await writeFile(sourcePath, source);
    },
    changeCompiler() {
      compiler = 'compiler-b/profile-b';
    },
    changeContent(value: string | undefined) {
      currentContent = value;
    },
  };
}

describe('Pack product cache reference and content boundaries', () => {
  it('reuses a reference-only material after recreating its cache owner without cooking or reading its target', async () => {
    const f = await fixture();
    const first = await f.run();
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;
    expect(first.value.buildProducts[0]?.externalEvidence).toEqual([
      { guid: target, usage: 'reference' },
    ]);
    const warm = await f.run();
    expect(warm).toEqual(first);
    expect(f.counts).toEqual({ builds: 1, cooks: 1, reads: 0 });
  });

  it('misses when source bytes or the compiler/profile identity changes', async () => {
    const f = await fixture();
    expect((await f.run()).ok).toBe(true);
    await f.changeSource();
    expect((await f.run()).ok).toBe(true);
    f.changeCompiler();
    expect((await f.run()).ok).toBe(true);
    expect(f.counts).toEqual({ builds: 3, cooks: 3, reads: 0 });
    expect((await f.run()).ok).toBe(true);
    expect(f.counts).toEqual({ builds: 3, cooks: 3, reads: 0 });
  });

  it('rejects a missing referenced GUID on a warm product without recooking it', async () => {
    const f = await fixture();
    expect((await f.run()).ok).toBe(true);
    expect(await f.run({ available: false })).toMatchObject({
      ok: false,
      error: { code: 'pack-output-reference-missing', detail: { guids: [target] } },
    });
    expect(f.counts).toEqual({ builds: 1, cooks: 1, reads: 0 });
  });

  it('rejects malformed native references before cache publication', async () => {
    const f = await fixture();
    expect(await f.run({ ref: 'not-a-guid' })).toMatchObject({
      ok: false,
      error: { code: 'pack-source-output-invalid' },
    });
  });

  it('still checks actual content digests for a product that also has reference-only rows', async () => {
    const f = await fixture();
    expect((await f.run({ readContent: true })).ok).toBe(true);
    expect((await f.run({ readContent: true })).ok).toBe(true);
    expect(f.counts.builds).toBe(1);
    expect(f.counts.cooks).toBe(1);
    f.changeContent('content-b');
    expect((await f.run({ readContent: true })).ok).toBe(true);
    expect(f.counts.builds).toBe(2);
    expect(f.counts.cooks).toBe(2);
  });

  it('rejects an unavailable content dependency instead of reusing the cached product', async () => {
    const f = await fixture();
    expect((await f.run({ readContent: true })).ok).toBe(true);
    f.changeContent(undefined);
    expect((await f.run({ readContent: true })).ok).toBe(false);
    expect(f.counts.builds).toBe(2);
    expect(f.counts.cooks).toBe(1);
  });
});
