import { createHash } from 'node:crypto';
import { cp, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  produceScriptablePackProducts,
  type ScriptablePackInput,
} from '../scriptable-pack-host.js';
import { createScriptablePackTransportCache } from '../scriptable-pack-transport-cache.js';

const digest = (bytes: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-transport-ddc-')));
  const sourcePath = join(root, 'source.pack.ts');
  let text = 'first',
    base = '/';
  await writeFile(sourcePath, text);
  const cook = vi.fn<NativeCooker['cook']>((raw) => {
    const input = raw as { guid: string; source: { text: string } };
    const bytes = new TextEncoder().encode(input.source.text);
    return {
      guid: input.guid,
      payload: { kind: 'fixture-binary', text: input.source.text },
      refs: [],
      artifacts: { body: { mediaType: 'application/octet-stream', bytes } },
      inputFingerprint: digest(bytes),
    };
  });
  const cooker: NativeCooker = {
    key: 'fixture-binary',
    concurrency: 'parallel',
    cacheIdentity: () => 'fixture/1',
    cook,
  };
  const policy = vi.fn(() => ({
    base,
    packagePath: 'assets/fixture.pack.json',
    artifactPath: (guid: string, key: string) => `shared/${guid}/${key}.bin`,
  }));
  const definition = definePack({
    schemaVersion: '2.0.0',
    packageId: definePackageId('01900000-0000-7000-8000-000000008111'),
    build: () =>
      ok({ binary: { kind: 'fixture-binary', execution: 'cooked' as const, source: { text } } }),
  });
  const input = (overrides: Partial<ScriptablePackInput> = {}): ScriptablePackInput => ({
    sourcePath,
    displaySourcePath: 'source.pack.ts',
    definition,
    sourceClosure: [{ path: sourcePath, digest: digest(text) }],
    publicationGeneration: 1,
    policy,
    transportIdentity: `fixture/1:${base}`,
    ...overrides,
  });
  const run = async (source = input()) => {
    const prepared = (
      await produceScriptablePackProducts({
        sources: [source],
        buildCacheRoot: root,
        cacheIdentityRoot: root,
        cookers: [cooker],
      })
    )
      .unwrap()
      .get('source.pack.ts');
    if (prepared === undefined) throw new Error('Missing prepared source');
    return prepared;
  };
  return {
    root,
    input,
    run,
    cook,
    policy,
    setBase(value: string) {
      base = value;
    },
    async setText(value: string) {
      text = value;
      await writeFile(sourcePath, text);
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

it('reuses verified transport metadata with current producer bytes and independent returned snapshots', async () => {
  const f = await fixture();
  try {
    const first = await f.run(),
      second = await f.run();
    expect(f.cook).toHaveBeenCalledTimes(1);
    expect(f.policy).toHaveBeenCalledTimes(1);
    expect(second.finalized).toEqual(first.finalized);
    expect(second.finalized.pack).not.toBe(first.finalized.pack);
    const cache = await createScriptablePackTransportCache({
      root: f.root,
      identityRoot: f.root,
      canReuse: () => true,
    });
    expect(await cache.read(f.input(), second.product)).toBeDefined();
    const body = second.product.product.assets[0]?.artifacts.body;
    if (body === undefined) throw new Error('Missing current product body');
    body.bytes[0] = 255;
    expect(await cache.read(f.input(), second.product)).toBeUndefined();
    expect((await f.run()).finalized).toEqual(first.finalized);
  } finally {
    await f.dispose();
  }
});

it('invalidates source content, transport policy and publication generation independently', async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    f.setBase('/relocated/');
    const moved = await f.run();
    expect(moved.finalized.packageUrl).not.toBe(first.finalized.packageUrl);
    expect(f.cook).toHaveBeenCalledTimes(1);
    expect(f.policy).toHaveBeenCalledTimes(2);
    const generation = await f.run(f.input({ publicationGeneration: 2 }));
    expect(generation.publication.generation).toBe(2);
    expect(f.policy).toHaveBeenCalledTimes(3);
    await f.setText('changed source bytes');
    const changed = await f.run();
    expect(changed.finalized.digest).not.toBe(moved.finalized.digest);
    expect(f.cook).toHaveBeenCalledTimes(2);
    expect(f.policy).toHaveBeenCalledTimes(4);
  } finally {
    await f.dispose();
  }
});

it('rebuilds corrupted transport without recooking a valid product', async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    const entries = join(f.root, 'scriptable-pack-transports/entries');
    const [key] = await readdir(entries);
    if (key === undefined) throw new Error('Missing transport DDC entry');
    await writeFile(join(entries, key, 'artifacts/transport.v8.br.bin'), 'corrupt');
    expect((await f.run()).finalized).toEqual(first.finalized);
    expect(f.cook).toHaveBeenCalledTimes(1);
    expect(f.policy).toHaveBeenCalledTimes(2);
  } finally {
    await f.dispose();
  }
});

it('keeps ordinary borrowed policies live unless they explicitly declare a transport identity', async () => {
  const f = await fixture();
  try {
    const { transportIdentity: _, ...source } = f.input();
    await f.run(source);
    f.setBase('/live/');
    expect((await f.run(source)).finalized.packageUrl).toContain('/live/');
    expect(f.cook).toHaveBeenCalledTimes(1);
    expect(f.policy).toHaveBeenCalledTimes(2);
  } finally {
    await f.dispose();
  }
});

it('reuses verified transport metadata after relocating the project cache', async () => {
  const f = await fixture();
  const movedRoot = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-transport-moved-')));
  try {
    const first = await f.run();
    await cp(f.root, movedRoot, { recursive: true });
    const sourcePath = join(movedRoot, 'source.pack.ts');
    const moved = (
      await produceScriptablePackProducts({
        sources: [
          f.input({ sourcePath, sourceClosure: [{ path: sourcePath, digest: digest('first') }] }),
        ],
        buildCacheRoot: movedRoot,
        cacheIdentityRoot: movedRoot,
        cookers: [
          {
            key: 'fixture-binary',
            concurrency: 'parallel',
            cacheIdentity: () => 'fixture/1',
            cook: f.cook,
          },
        ],
      })
    )
      .unwrap()
      .get('source.pack.ts');
    expect(moved).toBeDefined();
    expect(moved?.finalized).toEqual(first.finalized);
    expect(f.cook).toHaveBeenCalledTimes(1);
    expect(f.policy).toHaveBeenCalledTimes(1);
  } finally {
    await f.dispose();
    await rm(movedRoot, { recursive: true, force: true });
  }
});
