import { ok, type SamplerAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { prepareRuntimePackContent, RuntimePackProducer } from '../runtime-pack';

const packageId = '01900000-0000-7000-8000-000000000198';

describe('Runtime Pack publication reentrancy', () => {
  it.each([
    'withdraw',
    'dispose',
  ] as const)('does not resurrect a replacement after onCommit calls %s', async (action) => {
    let interrupt = false;
    let sampler: SamplerAsset = { kind: 'sampler', minFilter: 'nearest' };
    const producer = new RuntimePackProducer({
      scopeId: 'reentrant-publication',
      validate: async (state) => ok(new Map(state.rows.map((row) => [row.guid, sampler]))),
      onCommit: (state) => {
        if (!interrupt || state.status === 'withdrawn') return;
        interrupt = false;
        if (action === 'withdraw') producer.withdraw(packageId);
        else producer.dispose();
      },
    });
    try {
      const first = (
        await producer.admit((await prepareRuntimePackContent(packageId, { sampler })).unwrap())
      ).unwrap();
      expect(first.rows).toHaveLength(1);
      if (!first.publication) throw new Error('missing accepted publication');
      sampler = { kind: 'sampler', minFilter: 'linear' };
      const candidate = (await prepareRuntimePackContent(packageId, { sampler })).unwrap();
      interrupt = true;
      const result = await producer.replace(candidate, first.publication);
      expect(result).toMatchObject({ ok: false, error: { code: 'runtime-pack-cancelled' } });
      expect(producer.rows()).toEqual([]);
      expect(producer.snapshot().packs).toEqual([]);
      if (action === 'withdraw') expect((await producer.admit(candidate)).ok).toBe(true);
    } finally {
      producer.dispose();
    }
  });

  it('cancels a first admission withdrawn synchronously before visibility', async () => {
    const sampler: SamplerAsset = { kind: 'sampler' };
    let interrupt = true;
    const producer = new RuntimePackProducer({
      scopeId: 'reentrant-first-publication',
      validate: async (state) => ok(new Map(state.rows.map((row) => [row.guid, sampler]))),
      onCommit: () => {
        if (!interrupt) return;
        interrupt = false;
        producer.withdraw(packageId);
      },
    });
    try {
      const result = await producer.admit(
        (await prepareRuntimePackContent(packageId, { sampler })).unwrap(),
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'runtime-pack-cancelled' } });
      expect(producer.rows()).toEqual([]);
      expect(producer.snapshot().packs).toEqual([]);
    } finally {
      producer.dispose();
    }
  });
});
