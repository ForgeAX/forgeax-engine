import type { CatalogEntry, RuntimeAssetBinding } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createDevSession, type DevSessionSnapshot } from '../dev/dev-session.js';
import { createProductionSession } from '../production/session.js';

const entry: CatalogEntry = {
  guid: '11111111-1111-4111-8111-111111111111',
  packageUrl: '/preview/fixture.pack.json',
  kind: 'mesh',
  sourcePath: 'fixture.mesh',
};

function snapshot(
  generation: number,
  authority: DevSessionSnapshot['authority'] = 'authoritative',
) {
  return {
    generation,
    catalog: [entry],
    authority,
    diagnostics:
      authority === 'degraded' ? [{ code: 'fixture-failure', severity: 'blocking' as const }] : [],
  } satisfies DevSessionSnapshot;
}

function productionSession() {
  return createProductionSession({
    inventory: async () => [],
    produce: async () => {},
    publish: async () => {},
  });
}

function runtimeBinding(scopeId: string, generation: number): RuntimeAssetBinding {
  return {
    schemaVersion: 'runtime-asset-binding-v1',
    gameId: scopeId,
    scopeId,
    generation,
    status: 'unbound',
    catalogUrl: `/__pack/scopes/${scopeId}/${generation}/catalog.json`,
    importUrlBase: `/__pack/scopes/${scopeId}/${generation}/import`,
    packageUrlBase: `/__pack/scopes/${scopeId}/${generation}/asset`,
  };
}

describe('DevSession state machine', () => {
  it('publishes failure and repair to the HTTP runtime binding without replacing the accepted generation', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => snapshot(1),
    });
    session.bindRuntime(runtimeBinding('material', 1));
    try {
      await session.start();
      expect(session.runtimeScope()).toMatchObject({
        status: 'ready',
        authority: 'authoritative',
        generation: 1,
      });
      await session.rebuild(async () => {
        throw new Error('WGSL compilation failed');
      });
      expect(session.runtimeScope()).toMatchObject({
        status: 'degraded',
        authority: 'degraded',
        generation: 1,
      });
      expect(session.runtimeScope()?.diagnostics?.length).toBeGreaterThan(0);
      await session.rebuild(async () => snapshot(2));
      expect(session.runtimeScope()).toMatchObject({
        status: 'ready',
        authority: 'authoritative',
        generation: 1,
        diagnostics: [],
      });
    } finally {
      await session.close();
    }
  });
  it('owns and clears the runtime scope with its generation session', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => snapshot(1),
    });
    session.bindRuntime(runtimeBinding('game-a', 1));
    expect(session.runtimeScope()).toMatchObject({
      scopeId: 'game-a',
      generation: 1,
      status: 'transitioning',
    });
    expect(session.publishRuntime('ready')?.generation).toBe(1);
    expect(() => session.bindRuntime(runtimeBinding('game-a', 2))).toThrow('already belongs');

    await session.close();
    expect(session.runtimeScope()).toBeUndefined();
  });

  it('validates runtime identity before binding it to a session', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => snapshot(1),
    });
    expect(() => session.bindRuntime(runtimeBinding('game-a', 0))).toThrow('positive safe integer');
    expect(() => session.bindRuntime({ ...runtimeBinding('game-a', 1), gameId: '' })).toThrow(
      'gameId and scopeId are required',
    );
    await session.close();
  });

  it('fails closed without a startup snapshot and returns a structured 503 projection', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => {
        throw new Error('missing root');
      },
    });

    await session.start();
    expect(session.state().status).toBe('failed');
    expect(session.state()).toMatchObject({
      status: 'failed',
      error: { detail: { stage: 'scan' } },
    });
    await session.close();
  });

  it('keeps the accepted snapshot visible during rebuild failure and closes with 410', async () => {
    const session = createDevSession({
      generation: 3,
      productionSession: productionSession(),
      startup: async () => snapshot(3),
    });
    await session.start();
    expect(session.state().status).toBe('serving');

    await session.rebuild(async () => {
      throw new Error('watch batch rejected');
    });
    expect(session.state().status).toBe('degraded');
    expect(session.state()).toMatchObject({
      status: 'degraded',
      snapshot: { catalog: [entry] },
    });

    await session.close();
    expect(session.state()).toEqual({ status: 'closed' });
    expect(session.state()).toEqual({ status: 'closed' });
  });

  it('does not let a late candidate replace a newer generation', async () => {
    let release!: (value: DevSessionSnapshot) => void;
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => snapshot(1),
    });
    await session.start();
    const pending = session.rebuild(
      () => new Promise<DevSessionSnapshot>((resolve) => (release = resolve)),
    );
    const closing = session.close();
    await Promise.resolve();
    release(snapshot(2));
    await closing;
    await pending;
    expect(session.state()).toEqual({ status: 'closed' });
  });

  it('drains a delayed startup before close resolves', async () => {
    let release!: (value: DevSessionSnapshot) => void;
    const session = createDevSession({
      generation: 7,
      productionSession: productionSession(),
      startup: async () =>
        new Promise<DevSessionSnapshot>((resolve) => {
          release = resolve;
        }),
    });

    const starting = session.start();
    await Promise.resolve();
    const closing = session.close();
    await Promise.resolve();
    expect(session.state()).toEqual({ status: 'closing' });

    release(snapshot(7));
    await closing;
    await starting;
    expect(session.state()).toEqual({ status: 'closed' });
    expect(session.state()).toEqual({ status: 'closed' });
  });
  it('recovers a failed startup without creating a previous snapshot', async () => {
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => {
        throw new Error('broken source');
      },
    });
    session.bindRuntime(runtimeBinding('startup-repair', 1));
    try {
      await session.start();
      expect(session.runtimeScope()?.status).toBe('degraded');
      await session.rebuild(async ({ previous }) => {
        expect(previous).toBeUndefined();
        throw new Error('still broken');
      });
      expect(session.state().status).toBe('failed');
      await session.rebuild(async ({ previous, generation }) => {
        expect(previous).toBeUndefined();
        return snapshot(generation);
      });
      expect(session.state().status).toBe('serving');
      expect(session.runtimeScope()).toMatchObject({ status: 'ready', diagnostics: [] });
    } finally {
      await session.close();
    }
  });

  it('preserves the accepted snapshot and ignores an obsolete rebuild rejection', async () => {
    const accepted = snapshot(1);
    const session = createDevSession({
      generation: 1,
      productionSession: productionSession(),
      startup: async () => accepted,
    });
    try {
      await session.start();
      await session.rebuild(async () => {
        throw new Error('broken candidate');
      });
      expect(session.state()).toMatchObject({ status: 'degraded', snapshot: accepted });
      let reject!: (error: Error) => void;
      const pending = session.rebuild(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      );
      await session.rebuild(async () => snapshot(3));
      reject(new Error('late rejection'));
      await pending;
      expect(session.state()).toMatchObject({ status: 'serving', snapshot: snapshot(3) });
    } finally {
      await session.close();
    }
  });
});
