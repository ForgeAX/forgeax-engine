import { describe, expect, it } from 'vitest';
import { createProductionSession } from '../production/session.js';

describe('ProductionSession', () => {
  it('coalesces concurrent requests into one inventory and one producer task', async () => {
    let inventoryCalls = 0;
    let producerCalls = 0;
    const session = createProductionSession({
      inventory: async () => {
        inventoryCalls += 1;
        return [{ sourceKey: 'source-a', guids: ['guid-a', 'guid-b'] }];
      },
      produce: async ({ declaration }) => {
        producerCalls += 1;
        void declaration;
      },
      publish: async () => undefined,
    });

    const first = session.start();
    const second = session.start();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(firstResult.status).toBe('accepted');
    expect(inventoryCalls).toBe(1);
    expect(producerCalls).toBe(1);
    await session.close();
  });

  it('keeps one producer task for a declaration with multiple GUIDs', async () => {
    const declarations: string[][] = [];
    const session = createProductionSession({
      inventory: async () => [{ sourceKey: 'source-a', guids: ['guid-a', 'guid-b'] }],
      produce: async ({ declaration }) => {
        declarations.push([...declaration.guids]);
      },
      publish: async () => undefined,
    });

    const result = await session.start();

    expect(result.status).toBe('accepted');
    expect(declarations).toEqual([['guid-a', 'guid-b']]);
    await session.close();
  });
  it.each([
    'failed',
    'stale',
  ] as const)('materializes the accepted rebuild after a %s startup', async (startup) => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const materialized: string[] = [];
    const session = createProductionSession({
      inventory: async () => [{ sourceKey: 'source-a', guids: ['guid-a'] }],
      produce: async ({ generation, intent, declaration }) => {
        if (intent === 'materialize') materialized.push(declaration.sourceKey);
        else if (generation === 1) {
          if (startup === 'stale') await barrier;
          else throw new Error('broken source');
        }
      },
      publish: async () => {},
    });
    try {
      const starting = session.start();
      if (startup === 'failed') expect((await starting).status).toBe('failed');
      expect((await session.rebuild([{ sourceKey: 'source-a' }])).status).toBe('accepted');
      release();
      expect((await starting).status).toBe(startup);
      expect(await session.materialize('guid-a')).toEqual({ status: 'accepted', generation: 2 });
      expect(materialized).toEqual(['source-a']);
    } finally {
      release();
      await session.close();
    }
  });
});
