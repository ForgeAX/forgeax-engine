import type { NativeCookDraft, NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { AssetOutputProducerRegistry } from '../scriptable-pack.js';
import { buildScriptablePack } from '../scriptable-pack-build.js';

function fixture(concurrency: 'parallel' | undefined, count: number) {
  const started: string[] = [];
  const finish = new Map<string, (fail?: boolean) => void>();
  let active = 0;
  let peak = 0;
  const cooker: NativeCooker = {
    key: 'test-volume',
    ...(concurrency === undefined ? {} : { concurrency }),
    async cook(raw) {
      const input = raw as { guid: string; sourceKey: string; source: { marker: number } };
      started.push(input.sourceKey);
      peak = Math.max(peak, ++active);
      try {
        return await new Promise<NativeCookDraft>((resolve, reject) => {
          finish.set(input.sourceKey, (fail) => {
            if (fail) reject(new Error(`failed ${input.sourceKey}`));
            else
              resolve({
                guid: input.guid,
                payload: { kind: 'test-volume', ...input.source },
                refs: [],
                artifacts: {},
                inputFingerprint: `sha256:${input.sourceKey}`,
              });
          });
        });
      } finally {
        active--;
      }
    },
  };
  const run = () =>
    buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-000000000079'),
        build: () =>
          ok(
            Object.fromEntries(
              Array.from({ length: count }, (_, marker) => [
                `volume/${marker}`,
                { kind: 'test-volume', execution: 'cooked' as const, source: { marker } },
              ]),
            ),
          ),
      }),
      sourcePath: 'fixture.pack.ts',
      outputs: new AssetOutputProducerRegistry(),
      cookers: [cooker],
    });
  return { started, finish, run, peak: () => peak };
}

it('admits at most four opted-in cooks and publishes in authored order despite reverse completion', async () => {
  const f = fixture('parallel', 9);
  const pending = f.run();
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(4));
    for (let index = 3; index >= 0; index--) f.finish.get(`volume/${index}`)?.();
    await vi.waitFor(() => expect(f.started).toHaveLength(8));
  } finally {
    const drain = setInterval(() => {
      for (const finish of f.finish.values()) finish();
    }, 1);
    try {
      const result = (await pending).unwrap();
      expect(f.peak()).toBe(4);
      expect(result.product.assets.map((asset) => asset.payload)).toEqual(
        Array.from({ length: 9 }, (_, marker) => ({ kind: 'test-volume', marker })),
      );
      expect(result.stagedOutputs.map((output) => output.sourceKey)).toEqual(
        Array.from({ length: 9 }, (_, index) => `volume/${index}`),
      );
    } finally {
      clearInterval(drain);
    }
  }
});

it('keeps cookers without an explicit declaration serial', async () => {
  const f = fixture(undefined, 3);
  const pending = f.run();
  for (let index = 0; index < 3; index++) {
    await vi.waitFor(() => expect(f.started).toHaveLength(index + 1));
    f.finish.get(`volume/${index}`)?.();
  }
  expect((await pending).ok).toBe(true);
  expect(f.peak()).toBe(1);
});

it('drains admitted cooks, returns the first authored failure and does not admit a later batch', async () => {
  const f = fixture('parallel', 5);
  let settled = false;
  const pending = f.run().finally(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(4));
    f.finish.get('volume/1')?.(true);
    f.finish.get('volume/0')?.(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    f.finish.get('volume/3')?.();
    f.finish.get('volume/2')?.();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'native-cook-failed', detail: { producer: 'failed volume/0' } },
    });
    expect(f.started).toHaveLength(4);
  } finally {
    const drain = setInterval(() => {
      for (const finish of f.finish.values()) finish();
    }, 1);
    try {
      await pending;
    } finally {
      clearInterval(drain);
    }
  }
});
