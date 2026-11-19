import { describe, expect, it, vi } from 'vitest';
import type { WaterZoneTerrainProviderInput } from '../contracts.js';
import { WaterSystem } from '../system.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const provider = (
  entity: number,
  terrainGuid: string,
  terrainVersion: number,
  min = 0,
): WaterZoneTerrainProviderInput => ({
  entity,
  terrainGuid,
  terrainVersion,
  worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  boundsXZ: { minM: [min, min], maxM: [min + 4, min + 4] },
});

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected value to be defined');
  return value;
}

describe('Zone Terrain ground input', () => {
  it('keeps changed provider inputs dirty until the exact generation is accepted', () => {
    let zoneGeneration = 3;
    const water = new WaterSystem((guid) =>
      guid === 'zone/main' ? { generation: zoneGeneration } : undefined,
    );
    const first = requiredValue(
      water.observeZoneGroundInputs('zone/main', zoneGeneration, [
        provider(8, 'terrain/rock', 2),
        provider(2, 'terrain/base', 7),
      ]),
    );
    expect(first).toMatchObject({
      zoneGuid: 'zone/main',
      zoneGeneration: 3,
      providers: [
        { entity: 2, terrainGuid: 'terrain/base', terrainVersion: 7 },
        { entity: 8, terrainGuid: 'terrain/rock', terrainVersion: 2 },
      ],
      dirty: true,
    });
    expect(water.acceptZoneGround('zone/main', first.generation)).toMatchObject({
      ok: true,
      value: true,
    });
    expect(water.zoneGroundSnapshot('zone/main')?.dirty).toBe(false);

    const second = requiredFixtureValue(
      water.observeZoneGroundInputs('zone/main', zoneGeneration, [
        provider(2, 'terrain/derived', 1),
        provider(8, 'terrain/rock', 2),
      ]),
    );
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.dirty).toBe(true);
    expect(water.acceptZoneGround('zone/main', first.generation)).toMatchObject({
      ok: false,
      error: { code: 'stale-generation' },
    });
    expect(water.acceptZoneGround('zone/main', second.generation)).toMatchObject({
      ok: true,
      value: true,
    });

    const third = requiredFixtureValue(
      water.observeZoneGroundInputs('zone/main', zoneGeneration, [
        provider(2, 'terrain/derived', 2),
        provider(8, 'terrain/rock', 2),
      ]),
    );
    expect(third.generation).toBeGreaterThan(second.generation);
    expect(third.providers[0]?.terrainVersion).toBe(2);
    zoneGeneration++;
    expect(water.invalidateZoneGround('zone/main', 3)).toMatchObject({
      ok: false,
      error: { code: 'stale-generation' },
    });
    const fourth = requiredValue(
      water.observeZoneGroundInputs('zone/main', zoneGeneration, [
        provider(2, 'terrain/derived', 2),
        provider(8, 'terrain/rock', 2),
      ]),
    );
    expect(fourth.zoneGeneration).toBe(zoneGeneration);
    expect(fourth.generation).toBeGreaterThan(third.generation);
    expect(water.invalidateZoneGround('zone/main', zoneGeneration)).toMatchObject({
      ok: true,
      value: { dirty: true },
    });
  });

  it('marks provider removal as a new dirty input', () => {
    const water = new WaterSystem(() => ({ generation: 1 }));
    const first = requiredValue(
      water.observeZoneGroundInputs('zone/main', 1, [provider(4, 'terrain/base', 4)]),
    );
    const removed = water.observeZoneGroundInputs('zone/main', 1, []);
    expect(removed).toMatchObject({ generation: expect.any(Number), dirty: true });
    expect(removed?.generation).toBeGreaterThan(first.generation);
    expect(removed?.providers).toEqual([]);
    expect(water.unobserveZoneGround('zone/main')).toBeUndefined();
    expect(water.zoneGroundSnapshot('zone/main')).toBeUndefined();
  });

  it('reuses sorted provider rosters by numeric value, regardless of input order or array view', () => {
    const water = new WaterSystem(() => ({ generation: 1 }));
    const provider8 = provider(8, 'terrain/eight', 2, 8);
    const provider2 = provider(2, 'terrain/two', 1, 2);
    const first = requiredValue(
      water.reconcileZoneGroundInputs('zone/main', 1, [provider8, provider2]),
    );
    expect(first.providers.map(({ entity }) => entity)).toEqual([2, 8]);

    const sameSorted = requiredValue(
      water.reconcileZoneGroundInputs('zone/main', 1, [
        provider(2, 'terrain/two', 1, 2),
        provider(8, 'terrain/eight', 2, 8),
      ]),
    );
    expect(sameSorted).toBe(first);
    const typedProvider2 = {
      ...provider(2, 'terrain/two', 1, 2),
      worldMatrixM: new Float32Array(provider2.worldMatrixM) as unknown as readonly number[],
      boundsXZ: {
        minM: new Float32Array(provider2.boundsXZ.minM) as unknown as readonly [number, number],
        maxM: new Float32Array(provider2.boundsXZ.maxM) as unknown as readonly [number, number],
      },
    };
    const sameTyped = requiredValue(
      water.reconcileZoneGroundInputs('zone/main', 1, [
        typedProvider2,
        provider(8, 'terrain/eight', 2, 8),
      ]),
    );
    expect(sameTyped).toBe(first);

    const withTerrainAsset = requiredValue(
      water.reconcileZoneGroundInputs('zone/main', 1, [
        {
          ...provider(8, 'terrain/eight', 2, 8),
          terrainAsset: {
            kind: 'terrain',
            columns: 2,
            rows: 2,
            heights: new Float32Array([1, 2, 3, 4]),
          } as NonNullable<WaterZoneTerrainProviderInput['terrainAsset']>,
        },
        typedProvider2,
      ]),
    );
    expect(withTerrainAsset).toBe(first);
    expect(first.providers.map(({ entity }) => entity)).toEqual([2, 8]);
  });

  it('updates on every provider closure change while held snapshots retain old values', () => {
    const water = new WaterSystem(() => ({ generation: 1 }));
    const base = provider(4, 'terrain/base', 4);
    const initial = requiredValue(water.observeZoneGroundInputs('zone/main', 1, [base]));
    let previous = requiredFixtureValue(water.reconcileZoneGroundInputs('zone/main', 1, [base]));
    const matrix = [...base.worldMatrixM];
    matrix[12] = 3;
    const variants: readonly WaterZoneTerrainProviderInput[] = [
      { ...base, terrainGuid: 'terrain/other' },
      { ...base, terrainVersion: 5 },
      { ...base, worldMatrixM: matrix },
      {
        ...base,
        boundsXZ: {
          minM: [1, 0],
          maxM: base.boundsXZ.maxM,
        },
      },
      {
        ...base,
        boundsXZ: {
          minM: base.boundsXZ.minM,
          maxM: [5, 4],
        },
      },
    ];
    for (const changedInput of variants) {
      const changed = requiredValue(
        water.reconcileZoneGroundInputs('zone/main', 1, [changedInput]),
      );
      expect(changed.generation).toBeGreaterThan(previous.generation);
      previous = changed;
    }
    expect(initial.providers[0]?.worldMatrixM[12]).toBe(0);
    expect(initial.providers[0]?.boundsXZ.minM).toEqual([0, 0]);
    const changedZone = requiredValue(water.reconcileZoneGroundInputs('zone/main', 2, [base]));
    expect(changedZone.generation).toBeGreaterThan(previous.generation);
    expect(changedZone.zoneGeneration).toBe(2);
  });

  it('rejects sparse and nonfinite provider values without replacing the accepted roster', () => {
    const water = new WaterSystem(() => ({ generation: 1 }));
    const base = provider(4, 'terrain/base', 4);
    const accepted = requiredValue(water.reconcileZoneGroundInputs('zone/main', 1, [base]));
    const sparseMatrix = [...base.worldMatrixM];
    delete sparseMatrix[5];
    const invalidInputs: readonly WaterZoneTerrainProviderInput[] = [
      { ...base, terrainVersion: Number.NaN },
      { ...base, worldMatrixM: sparseMatrix },
      {
        ...base,
        boundsXZ: {
          minM: [Number.POSITIVE_INFINITY, 0],
          maxM: base.boundsXZ.maxM,
        },
      },
    ];
    for (const invalid of invalidInputs)
      expect(water.reconcileZoneGroundInputs('zone/main', 1, [invalid])).toBeUndefined();
    const sparseProviders = new Array<WaterZoneTerrainProviderInput>(1);
    expect(water.reconcileZoneGroundInputs('zone/main', 1, sparseProviders)).toBeUndefined();
    expect(water.zoneGroundQuerySnapshot('zone/main')).toBe(accepted);
    expect(water.zoneGroundSnapshot('zone/main')?.generation).toBe(accepted.generation);
  });

  it('observes the actual detached ground snapshot copy on new, cached, and getter paths', () => {
    const water = new WaterSystem(() => ({ generation: 1 }));
    const operations: string[] = [];
    const copyWorkCounts: number[] = [];
    const observe = {
      begin(operation: string) {
        operations.push(`+${operation}`);
        const copyProbe =
          operation === 'water/zone/ground-snapshot-copy'
            ? vi.spyOn(Array.prototype, 'map')
            : undefined;
        return {
          end: () => {
            if (copyProbe !== undefined) {
              copyWorkCounts.push(copyProbe.mock.calls.length);
              copyProbe.mockRestore();
            }
            operations.push(`-${operation}`);
          },
        };
      },
    };
    const first = requiredValue(
      water.observeZoneGroundInputs('zone/main', 1, [provider(4, 'terrain/base', 4)], observe),
    );
    expect(operations).toEqual([
      '+water/zone/ground-snapshot-copy',
      '-water/zone/ground-snapshot-copy',
    ]);
    expect(copyWorkCounts[0]).toBeGreaterThan(0);
    operations.length = 0;

    const cached = requiredValue(
      water.observeZoneGroundInputs('zone/main', 1, [provider(4, 'terrain/base', 4)], observe),
    );
    expect(cached).not.toBe(first);
    expect(cached.providers).not.toBe(first.providers);
    expect(operations).toEqual([
      '+water/zone/ground-snapshot-copy',
      '-water/zone/ground-snapshot-copy',
    ]);
    expect(copyWorkCounts[1]).toBeGreaterThan(0);
    operations.length = 0;

    const read = requiredValue(water.zoneGroundSnapshot('zone/main', observe));
    expect(read).not.toBe(cached);
    expect(read.providers).not.toBe(cached.providers);
    expect(read.providers[0]?.worldMatrixM).not.toBe(cached.providers[0]?.worldMatrixM);
    expect(operations).toEqual([
      '+water/zone/ground-snapshot-copy',
      '-water/zone/ground-snapshot-copy',
    ]);
    expect(copyWorkCounts[2]).toBeGreaterThan(0);
  });

  it('borrows frozen ground metadata without copying Terrain payloads', () => {
    const water = new WaterSystem(() => ({ generation: 1 }));
    water.observeZoneGroundInputs('zone/main', 1, [provider(4, 'terrain/base', 4)]);

    const mapProbe = vi.spyOn(Array.prototype, 'map');
    const first = requiredValue(water.zoneGroundQuerySnapshot('zone/main'));
    const second = water.zoneGroundQuerySnapshot('zone/main');
    const copyCalls = mapProbe.mock.calls.length;
    mapProbe.mockRestore();

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(copyCalls).toBe(0);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.providers)).toBe(true);
    expect(Object.isFrozen(first?.providers[0])).toBe(true);
    expect(Object.isFrozen(first?.providers[0]?.worldMatrixM)).toBe(true);
    expect(Object.isFrozen(first?.providers[0]?.boundsXZ)).toBe(true);
  });

  it('holds the last accepted ground generation while a live provider revision is pending', () => {
    const water = new WaterSystem(() => ({ generation: 1 }));
    const initial = water.reconcileZoneGroundInputs('zone/main', 1, [
      provider(4, 'terrain/base', 4),
    ]);
    const accepted = requiredValue(water.zoneGroundSnapshot('zone/main'));
    water.markZoneGroundInputsPending('zone/main', 1);

    const pending = requiredFixtureValue(water.zoneGroundQuerySnapshot('zone/main'));
    expect(pending).toMatchObject({
      generation: initial.generation,
      zoneGeneration: 1,
      pending: true,
      providers: [{ entity: 4, terrainGuid: 'terrain/base', terrainVersion: 4 }],
    });
    expect(water.acceptZoneGround('zone/main', initial.generation)).toMatchObject({
      ok: true,
      value: true,
    });
    expect(water.zoneGroundQuerySnapshot('zone/main')).toMatchObject({
      generation: initial.generation,
      pending: true,
      dirty: false,
    });
    expect(water.zoneGroundSnapshot('zone/main')?.generation).toBe(accepted.generation);

    const ready = requiredFixtureValue(
      water.reconcileZoneGroundInputs('zone/main', 1, [provider(4, 'terrain/base', 4)]),
    );
    expect(ready.pending).toBe(false);
    expect(ready.generation).toBe(accepted.generation);
    expect(water.zoneGroundSnapshot('zone/main')?.providers[0]?.terrainVersion).toBe(4);
  });
});
