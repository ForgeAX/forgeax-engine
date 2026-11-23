import { resolve } from 'node:path';
import type { NativeCookDraft, NativeCooker } from '@forgeax/engine-pack/native-cooker';
import {
  definePack,
  definePackageId,
  parsePackSourceJson,
  projectDirectPackJson,
} from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetOutputProducerRegistry } from '../scriptable-pack.js';
import { buildScriptablePack } from '../scriptable-pack-build.js';
import { prepareDirectPackTransport } from '../scriptable-pack-host.js';

const packageId = '01900000-0000-7000-8000-000000000079';
type Route = 'direct' | 'scriptable';

function fixture(route: Route, count: number, concurrency?: 'parallel') {
  const key = route === 'direct' ? 'material' : 'test-volume';
  const sourceKeys = Array.from({ length: count }, (_, index) => `${key}/${index}`);
  const started: string[] = [];
  const finish = new Map<string, (fail?: boolean) => void>();
  let active = 0;
  let peak = 0;
  const cooker: NativeCooker = {
    key,
    ...(concurrency === undefined ? {} : { concurrency }),
    async cook(raw) {
      const input = raw as { guid: string; sourceKey: string; source: object };
      started.push(input.sourceKey);
      peak = Math.max(peak, ++active);
      try {
        return await new Promise<NativeCookDraft>((resolve, reject) => {
          finish.set(input.sourceKey, (fail) => {
            if (fail) reject(new Error(`failed ${input.sourceKey}`));
            else
              resolve({
                guid: input.guid,
                payload: { kind: key, ...input.source },
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

  async function run() {
    if (route === 'scriptable') {
      const result = await buildScriptablePack({
        definition: definePack({
          schemaVersion: '2.0.0',
          packageId: definePackageId(packageId),
          build: () =>
            ok(
              Object.fromEntries(
                sourceKeys.map((key, marker) => [
                  key,
                  { kind: 'test-volume', execution: 'cooked' as const, source: { marker } },
                ]),
              ),
            ),
        }),
        sourcePath: 'fixture.pack.ts',
        outputs: new AssetOutputProducerRegistry(),
        cookers: [cooker],
      });
      if (result.ok) {
        expect(result.value.product.assets.map((asset) => asset.payload)).toEqual(
          sourceKeys.map((_, marker) => ({ kind: 'test-volume', marker })),
        );
        expect(result.value.stagedOutputs.map((output) => output.sourceKey)).toEqual(sourceKeys);
      }
      return result;
    }

    const parsed = parsePackSourceJson({
      schemaVersion: '3.0.0',
      packageId,
      assets: Object.fromEntries(
        sourceKeys.map((key, index) => [
          key,
          { kind: 'material', payload: { values: { roughness: index / count } }, refs: [] },
        ]),
      ),
    }).unwrap();
    if (parsed.format !== 'direct') throw new Error('expected direct Pack');
    const projected = projectDirectPackJson(parsed);
    const result = await prepareDirectPackTransport({
      projected,
      sourcePath: resolve('fixture.pack.json'),
      sourceRevision: 'sha256:fixture',
      cookers: [cooker],
      policy: {
        base: '/',
        packagePath: 'fixture.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
      },
    });
    if (result.ok) {
      const expected = new Map(
        projected.assets.map((asset) => [
          asset.guid,
          { ...(asset.payload as object), kind: asset.kind },
        ]),
      );
      expect(result.value.finalized.pack.assets).toHaveLength(count);
      for (const asset of result.value.finalized.pack.assets)
        expect(asset.payload).toEqual(expected.get(asset.guid));
    }
    return result;
  }

  return {
    started,
    peak: () => peak,
    run,
    finish(index: number, fail?: boolean) {
      finish.get(`${key}/${index}`)?.(fail);
    },
    async drain<T>(pending: Promise<T>) {
      // Also drain slower implementations so failures report the assertion that exposed them.
      const timer = setInterval(() => {
        for (const release of finish.values()) release();
      }, 1);
      try {
        return await pending;
      } finally {
        clearInterval(timer);
      }
    },
    firstFailure: `failed ${key}/0`,
  };
}

describe.each(['direct', 'scriptable'] as const)('%s Pack cook scheduling', (route) => {
  it('bounds four opted-in cooks and publishes authored content after reverse completion', async () => {
    const f = fixture(route, 9, 'parallel');
    const pending = f.run();
    try {
      await vi.waitFor(() => expect(f.started).toHaveLength(4));
      for (let index = 3; index >= 0; index--) f.finish(index);
      await vi.waitFor(() => expect(f.started).toHaveLength(8));
    } finally {
      await f.drain(pending);
    }
    expect((await pending).ok).toBe(true);
    expect(f.peak()).toBe(4);
  });

  it('keeps cookers without a concurrency declaration serial', async () => {
    const f = fixture(route, 3);
    const pending = f.run();
    try {
      for (let index = 0; index < 3; index++) {
        await vi.waitFor(() => expect(f.started).toHaveLength(index + 1));
        f.finish(index);
      }
    } finally {
      await f.drain(pending);
    }
    expect((await pending).ok).toBe(true);
    expect(f.peak()).toBe(1);
  });

  it('drains siblings and reports the first authored failure without starting a later batch', async () => {
    const f = fixture(route, 5, 'parallel');
    let settled = false;
    const pending = f.run().finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(f.started).toHaveLength(4));
      f.finish(1, true);
      f.finish(0, true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      f.finish(3);
      f.finish(2);
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: 'native-cook-failed', detail: { producer: f.firstFailure } },
      });
      expect(f.started).toHaveLength(4);
    } finally {
      await f.drain(pending);
    }
  });
});
