import { describe, expect, it } from 'vitest';

import { buildIntrospectDoc } from '../introspect';
import { startServer } from '../server';

describe('remote simulation inspection projection', () => {
  it('projects the existing simulation read root without adding remote actions', () => {
    const doc = buildIntrospectDoc('127.0.0.1', 5732, {
      world: {},
      renderer: {},
      assets: {},
      simulation: {
        inspect: () => ({
          formatVersion: 1,
          recordOwner: '@forgeax/engine-ecs',
          schemaOwner: '@forgeax/engine-ecs',
          participants: [],
          trace: { recordTick: 0, sampleCount: 0 },
          report: { verdict: 'match', entries: [] },
        }),
      },
    }) as {
      roots: Record<string, { type: string; description: string }>;
      methods: readonly { name: string }[];
    };

    expect(doc.roots.simulation).toMatchObject({
      available: true,
      type: 'SimulationInspection',
    });
    expect(doc.methods.map((method) => method.name)).toEqual(['eval', 'introspect']);
  });

  it('keeps simulation inspection on the existing eval transport', async () => {
    const started = await startServer({
      port: 0,
      host: '127.0.0.1',
      world: {},
      simulation: {
        inspect: () => ({
          formatVersion: 1,
          recordOwner: '@forgeax/engine-ecs',
          schemaOwner: '@forgeax/engine-ecs',
          participants: [],
          trace: { recordTick: 0, sampleCount: 0 },
          report: { verdict: 'match', entries: [] },
        }),
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    try {
      const { defaultConnect } = await import('@forgeax/engine-types/inspector-client');
      const connected = await defaultConnect(`ws://127.0.0.1:${started.value.port}/inspector`);
      expect(connected.ok).toBe(true);
      if (!connected.ok) return;
      const value = await connected.value.eval('simulation.inspect()');
      expect(value).toMatchObject({
        formatVersion: 1,
        recordOwner: '@forgeax/engine-ecs',
      });
      await connected.value.dispose();
    } finally {
      await started.value.close();
    }
  });
});
