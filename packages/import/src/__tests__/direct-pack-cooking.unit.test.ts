import { resolve } from 'node:path';
import type { NativeCookDraft, NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import { expect, it, vi } from 'vitest';
import { prepareDirectPackTransport } from '../scriptable-pack-host.js';

function fixture(concurrency: 'parallel' | undefined, count: number) {
  const parsed = parsePackSourceJson({
    schemaVersion: '3.0.0',
    packageId: '01900000-0000-7000-8000-000000000079',
    assets: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `material/${index}`,
        { kind: 'material', payload: { values: { roughness: index / count } }, refs: [] },
      ]),
    ),
  }).unwrap();
  if (parsed.format !== 'direct') throw new Error('expected direct Pack');
  const projected = projectDirectPackJson(parsed);
  const started: string[] = [];
  const finish = new Map<string, (fail?: boolean) => void>();
  let active = 0;
  let peak = 0;
  const cooker: NativeCooker = {
    key: 'material',
    ...(concurrency === undefined ? {} : { concurrency }),
    async cook(input: { guid: string; sourceKey: string; source: unknown }) {
      started.push(input.sourceKey);
      peak = Math.max(peak, ++active);
      try {
        return await new Promise<NativeCookDraft>((resolve, reject) => {
          finish.set(input.sourceKey, (fail) => {
            if (fail) reject(new Error(`failed ${input.sourceKey}`));
            else
              resolve({
                guid: input.guid,
                payload: input.source,
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
  return {
    started,
    finish,
    peak: () => peak,
    expected: new Map(
      projected.assets.map((asset) => [
        asset.guid,
        { ...(asset.payload as object), kind: asset.kind },
      ]),
    ),
    run: () =>
      prepareDirectPackTransport({
        projected,
        sourcePath: resolve('fixture.pack.json'),
        sourceRevision: 'sha256:fixture',
        cookers: [cooker],
        policy: {
          base: '/',
          packagePath: 'fixture.pack.json',
          artifactPath: (guid, key) => `${guid}/${key}.bin`,
        },
      }),
  };
}

it('bounds opted-in direct Pack cooking to four drafts and preserves every publication', async () => {
  const f = fixture('parallel', 9);
  const run = f.run();
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(4));
  } finally {
    // Drain the ordinary serial implementation too when this regression is red.
    const drain = setInterval(() => {
      for (const finish of f.finish.values()) finish();
    }, 1);
    try {
      const result = (await run).unwrap();
      expect(result.finalized.pack.assets).toHaveLength(9);
      for (const asset of result.finalized.pack.assets)
        expect(asset.payload).toEqual(f.expected.get(asset.guid));
      expect(f.peak()).toBe(4);
    } finally {
      clearInterval(drain);
    }
  }
});

it('keeps cookers without the parallel declaration serial', async () => {
  const f = fixture(undefined, 3);
  const run = f.run();
  for (let index = 0; index < 3; index++) {
    await vi.waitFor(() => expect(f.started).toHaveLength(index + 1));
    f.finish.get(`material/${index}`)?.();
  }
  expect((await run).ok).toBe(true);
  expect(f.peak()).toBe(1);
});

it('drains admitted sibling drafts and reports the first authored failure without admitting a later batch', async () => {
  const f = fixture('parallel', 5);
  let settled = false;
  const run = f.run().finally(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(4));
    f.finish.get('material/1')?.(true);
    f.finish.get('material/0')?.(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    f.finish.get('material/2')?.();
    f.finish.get('material/3')?.();
    const result = await run;
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'native-cook-failed', detail: { producer: 'failed material/0' } },
    });
    expect(f.started).toHaveLength(4);
  } finally {
    const drain = setInterval(() => {
      for (const finish of f.finish.values()) finish();
    }, 1);
    try {
      await run;
    } finally {
      clearInterval(drain);
    }
  }
});
