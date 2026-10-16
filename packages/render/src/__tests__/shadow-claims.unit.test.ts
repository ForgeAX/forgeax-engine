import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it, vi } from 'vitest';
import * as gpuDrawIdentity from '../extract/gpu-driven';
import { gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import { ShadowClaimTable, sourceDrawForCandidate } from '../gpu-driven/shadow-claims';
import { worldEntityKey } from '../record/frame-snapshot';
import { publishShadowMembership } from '../record/shadow-ownership-index';
import type { RenderableSnapshot, ShadowCasterMembership } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { RenderScene } from '../scene/render-scene';
import { preparedPbrSnapshot } from './gpu-driven-production-fixture';

type Slot = PersistentGpuDrivenState['slots'][number];

function slot(entityKey: number, materialHandle: number): Slot {
  const snapshot = {
    worldId: 0,
    entityKey,
    material: { materialHandle },
    materials: [{ materialHandle }],
    gpuDrivenDraws: [{ drawItemIndex: 0, materialSlot: 0 }],
  } as unknown as RenderableSnapshot;
  return { slot: entityKey, generation: 0, snapshot } as unknown as Slot;
}

function membership(
  entityKey: number,
  materialHandle: number,
  extra: Partial<ShadowCasterMembership> = {},
): ShadowCasterMembership {
  return {
    worldEntity: worldEntityKey(0, entityKey),
    renderableIndex: entityKey,
    drawItemIndex: 0,
    materialHandle,
    passIndex: 1,
    renderState: { cullMode: 'back' },
    gpuDrivenEligible: true,
    ...extra,
  } as ShadowCasterMembership;
}

function table(rows: readonly ShadowCasterMembership[]): ShadowClaimTable {
  return new ShadowClaimTable(undefined, rows);
}

const candidate = (primitiveIndex: number) => ({ primitiveIndex, drawItemIndex: 0 }) as never;

describe('ShadowClaimTable', () => {
  it('shares the published numeric index while preserving raw claim values and captured state', () => {
    const state = { cullMode: 'back' as const };
    const rows = [
      membership(1, 20, { renderState: state }),
      membership(2, 21, { cpuReason: 'unprepared' }),
      membership(3, 22),
      membership(3, 22, { passIndex: 2 }),
      membership(4, 23, { gpuDrivenEligible: false }),
      membership(5, 24, { renderState: { depthWriteEnabled: false } }),
      membership(2, 21, { passIndex: 2 }),
      membership(3, 22),
    ];
    const published = publishShadowMembership(rows.map((row) => Object.freeze({ ...row })));
    const borrowed = table(rows);
    const owned = table(published);
    expect(owned.casterKeys).toEqual(borrowed.casterKeys);
    expect([...(owned.casterKeys ?? [])]).toEqual([...(borrowed.casterKeys ?? [])]);
    for (let entity = 1; entity <= 6; entity++) {
      const first = owned.claim(slot(entity, entity + 19), candidate(entity));
      expect(first).toEqual(borrowed.claim(slot(entity, entity + 19), candidate(entity)));
      for (let frame = 0; frame < 32; frame++)
        expect(owned.claim(slot(entity, entity + 19), candidate(entity))).toBe(first);
      expect(owned.claim(slot(entity, 900), candidate(entity)).compatible).toBe(false);
    }
    expect(owned.claim(slot(1, 20), candidate(1)).entry?.renderState?.cullMode).toBe('back');
    Reflect.set(state, 'cullMode', 'front');
    expect(owned.matches(undefined, published)).toBe(false);
    expect(owned.claim(slot(1, 20), candidate(1)).entry?.renderState?.cullMode).toBe('back');
    const changed = table(published);
    expect(changed.claim(slot(1, 20), candidate(1)).entry?.renderState?.cullMode).toBe('front');
  });

  it('queries rematerialized membership claims without formatting composite string keys', () => {
    const format = vi.spyOn(gpuDrawIdentity, 'gpuDrivenDrawKey');
    try {
      const claims = table([membership(1, 20)]);
      format.mockClear();
      for (let frame = 0; frame < 8; frame++) {
        expect(claims.claim(slot(1, 20), candidate(1)).compatible).toBe(true);
        expect(claims.claim(slot(1, 21), candidate(1)).compatible).toBe(false);
      }
      expect(format).not.toHaveBeenCalled();
    } finally {
      format.mockRestore();
    }
  });

  it('separates numeric draw fields and keeps interleaved claim-group order', () => {
    const rows = [
      membership(7, 23, { drawItemIndex: 1, passIndex: 2 }),
      membership(8, 23, { drawItemIndex: 1, passIndex: 3 }),
      membership(7, 24, { drawItemIndex: 1, passIndex: 4 }),
      membership(7, 23, { drawItemIndex: 9001, passIndex: 5 }),
      membership(7, 23, { worldEntity: worldEntityKey(1, 7), drawItemIndex: 1, passIndex: 6 }),
    ];
    const claims = table(rows);
    const keys = rows.map((row) =>
      gpuDrivenShadowDrawKey(row.worldEntity, row.materialHandle, row.drawItemIndex, row.passIndex),
    );
    expect([...(claims.casterKeys ?? [])]).toEqual(keys);
    for (const [index, row] of rows.entries()) {
      const owner = slot(index === 1 ? 8 : 7, row.materialHandle);
      Reflect.set(owner.snapshot, 'worldId', index === 4 ? 1 : 0);
      Reflect.set(owner.snapshot, 'gpuDrivenDraws', [
        { drawItemIndex: row.drawItemIndex, materialSlot: 0 },
      ]);
      expect(claims.claim(owner, { drawItemIndex: row.drawItemIndex })).toMatchObject({
        compatible: true,
        keys: [keys[index]],
      });
    }
  });

  it('disambiguates colliding low handle bits before admitting or rejecting a draw', () => {
    const highHandle = 20 + 2 ** 32;
    const claims = table([
      membership(1, 20),
      membership(1, highHandle),
      membership(1, highHandle, { gpuDrivenEligible: false }),
    ]);
    expect(claims.claim(slot(1, 20), candidate(1))).toMatchObject({
      compatible: true,
      keys: ['1:20:0:1'],
    });
    expect(claims.claim(slot(1, highHandle), candidate(1))).toMatchObject({
      compatible: false,
      keys: [`1:${highHandle}:0:1`],
    });
    expect(claims.claim(slot(1, 20 + 2 ** 33), candidate(1))).toMatchObject({
      compatible: false,
      keys: [],
    });
  });

  it('shares the immutable membership claim across rematerialized snapshots', () => {
    const claims = table([membership(1, 20)]);
    const first = claims.claim(slot(1, 20), candidate(1));
    expect(first.compatible).toBe(true);
    for (let frame = 0; frame < 64; frame++) {
      expect(claims.claim(slot(1, 20), candidate(1))).toBe(first);
    }
    expect(claims.claim(slot(1, 21), candidate(1)).compatible).toBe(false);
  });

  it('finishes membership spread observations before discarding frame positions', () => {
    const worldFailure = new Error('world identity unavailable');
    const positionFailure = new Error('frame position unavailable');
    const trace: string[] = [];
    const row = new Proxy(membership(1, 10), {
      ownKeys(target) {
        trace.push('keys');
        return Reflect.ownKeys(target);
      },
      get(target, key, receiver) {
        trace.push(String(key));
        if (key === 'worldEntity') throw worldFailure;
        if (key === 'renderableIndex') throw positionFailure;
        return Reflect.get(target, key, receiver);
      },
    });
    let caught: unknown;
    try {
      table([row]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(worldFailure);
    expect(trace).toEqual(['keys', 'worldEntity']);
  });

  it('preserves a later frame-position getter error without restoring position invalidation', () => {
    const failure = new Error('frame position later unavailable');
    let fail = false;
    let position = 1;
    const row = new Proxy(membership(1, 10), {
      get(target, key, receiver) {
        if (key === 'renderableIndex') {
          if (fail) throw failure;
          return position;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const owner = table([row]);
    position = 900;
    expect(owner.matches(undefined, [row])).toBe(true);
    const claim = owner.claim(slot(1, 10), candidate(1));
    expect(claim.compatible).toBe(true);
    expect(claim.entry).toBeDefined();
    expect('renderableIndex' in (claim.entry ?? {})).toBe(false);
    fail = true;
    let caught: unknown;
    try {
      owner.matches(undefined, [row]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    fail = false;
    expect(owner.matches(undefined, [row])).toBe(true);
  });

  it('keeps the world-identity mismatch short circuit ahead of the position getter', () => {
    const owner = table([membership(1, 10)]);
    const row = new Proxy(membership(2, 10), {
      get(target, key, receiver) {
        if (key === 'renderableIndex') throw new Error('must not observe mismatched position');
        return Reflect.get(target, key, receiver);
      },
    });
    expect(owner.matches(undefined, [row])).toBe(false);
  });

  it('keeps an authored source draw lookup failure before direct index admission', () => {
    const owner = slot(1, 20);
    const failure = new Error('authored source draw lookup');
    const draws = [{ drawItemIndex: 0, materialSlot: 0 }];
    Object.defineProperty(draws, 'find', {
      get: () => {
        throw failure;
      },
    });
    Reflect.set(owner.snapshot, 'gpuDrivenDraws', draws);
    let observed: unknown;
    try {
      sourceDrawForCandidate(owner, { drawItemIndex: 0 });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(failure);
  });

  it('keeps earlier source draw errors before a later directly indexed draw', () => {
    const owner = slot(1, 20);
    const failure = new Error('earlier source draw');
    const draws = [
      {
        get drawItemIndex(): number {
          throw failure;
        },
        materialSlot: 0,
      },
      { drawItemIndex: 1, materialSlot: 0 },
    ];
    Reflect.set(owner.snapshot, 'gpuDrivenDraws', draws);
    let observed: unknown;
    try {
      sourceDrawForCandidate(owner, { drawItemIndex: 1 });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(failure);
  });

  it('retries an uncached claim after an authored lookup failure with the original receiver', () => {
    const owner = slot(1, 20);
    const failure = new Error('source draw lookup unavailable');
    let fail = true;
    let reads = 0;
    const draws = [{ drawItemIndex: 0, materialSlot: 0 }];
    Object.defineProperty(draws, 'find', {
      get: () => {
        reads += 1;
        return function (this: typeof draws, predicate: Parameters<typeof draws.find>[0]) {
          expect(this).toBe(draws);
          if (fail) throw failure;
          return Array.prototype.find.call(this, predicate);
        };
      },
    });
    Reflect.set(owner.snapshot, 'gpuDrivenDraws', draws);
    const claims = table([membership(1, 20)]);
    let observed: unknown;
    try {
      claims.claim(owner, candidate(1));
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(failure);
    fail = false;
    expect(claims.claim(owner, candidate(1))).toMatchObject({ compatible: true });
    expect(reads).toBe(2);
    claims.claim(owner, candidate(1));
    expect(reads).toBe(2);
  });

  it('resolves original draw indices after sparse compaction and reordering', () => {
    const owner = slot(1, 20);
    const draws = [
      { drawItemIndex: 2, materialSlot: 0 },
      { drawItemIndex: 0, materialSlot: 1 },
    ];
    Reflect.set(owner.snapshot, 'gpuDrivenDraws', draws);
    expect(sourceDrawForCandidate(owner, { drawItemIndex: 0 })).toBe(draws[1]);
    expect(sourceDrawForCandidate(owner, { drawItemIndex: 2 })).toBe(draws[0]);
    expect(sourceDrawForCandidate(owner, { drawItemIndex: 1 })).toBeUndefined();
    Reflect.set(owner.snapshot, 'gpuDrivenDraws', [{ materialSlot: 0 }, { materialSlot: 1 }]);
    expect(sourceDrawForCandidate(owner, { drawItemIndex: 1 })?.materialSlot).toBe(1);
  });
  it('shares one frozen claim across every instance candidate of a snapshot', () => {
    const owner = slot(1, 20);
    const claims = table([membership(1, 20)]);
    const first = claims.claim(owner, candidate(1));
    expect(first).toEqual({
      keys: [gpuDrivenShadowDrawKey(worldEntityKey(0, 1), 20, 0, 1)],
      compatible: true,
      entry: expect.objectContaining({ materialHandle: 20 }),
    });
    expect(Object.isFrozen(first)).toBe(true);
    for (let instance = 0; instance < 4096; instance++) {
      expect(claims.claim(owner, candidate(1))).toBe(first);
    }
  });

  it('shares the admitted claim across replacement snapshots without skipping source lookup', () => {
    const claims = table([membership(1, 20)]);
    const first = claims.claim(slot(1, 20), candidate(1));
    const moved = slot(1, 20);
    let reads = 0;
    Object.defineProperty(moved.snapshot.materials[0], 'materialHandle', {
      get: () => {
        reads += 1;
        return 20;
      },
    });
    expect(claims.claim(moved, candidate(1))).toBe(first);
    expect(reads).toBe(1);
    expect(claims.claim(moved, candidate(1))).toBe(first);
    expect(reads).toBe(1);
    expect(Object.isFrozen(first.keys)).toBe(true);
    expect(claims.claim(slot(1, 21), candidate(1)).compatible).toBe(false);
  });

  it('rejects duplicate membership facts even when they name the same shadow key', () => {
    const row = membership(1, 20);
    const claims = table([row, { ...row }]);
    const first = claims.claim(slot(1, 20), candidate(1));
    expect(first).toMatchObject({
      compatible: false,
      keys: [gpuDrivenShadowDrawKey(worldEntityKey(0, 1), 20, 0, 1)],
    });
    expect(claims.claim(slot(1, 20), candidate(1))).toBe(first);
    expect(claims.casterKeys?.size).toBe(1);
  });

  it('keeps membership authoritative and preserves draw-group key order', () => {
    const empty = new ShadowClaimTable(new Set(['1:20:0:1']), []);
    expect(empty.casterKeys?.size).toBe(0);
    expect(empty.claim(slot(1, 20), candidate(1)).compatible).toBe(false);
    const claims = table([
      membership(1, 20),
      membership(2, 20),
      membership(1, 20, { passIndex: 2 }),
    ]);
    expect([...(claims.casterKeys ?? [])]).toEqual(['1:20:0:1', '1:20:0:2', '2:20:0:1']);
    expect(claims.claim(slot(1, 20), candidate(1))).toMatchObject({
      compatible: false,
      keys: ['1:20:0:1', '1:20:0:2'],
    });
    expect(claims.claim(slot(2, 20), candidate(2)).compatible).toBe(true);
  });

  it('shares immutable claims through real scene snapshot replacement while separating world and entity', () => {
    const scene = new RenderScene();
    const add = (worldId: number, entityKey: number) => {
      const material = { materialHandle: 20 } as RenderableSnapshot['material'];
      scene.apply([
        {
          kind: 'update',
          worldId,
          entityKey,
          snapshot: preparedPbrSnapshot({
            worldId,
            entityKey,
            assetHandle: 1,
            transform: { world: mat4.identity(mat4.create()) },
            material,
            materials: [material],
            materialBindingSources: ['engine-default'],
            gpuDrivenDraws: [
              {
                kind: 'indexed',
                first: 0,
                count: 3,
                baseVertex: 0,
                materialSlot: 0,
                topology: 'triangle-list',
                pipelineClass: 'standard-pbr',
                materialResourceClass: 'standard-pbr-resources',
              },
            ],
          }),
        },
      ]);
    };
    add(0, 1);
    add(1, 1);
    const claims = table([
      membership(1, 20),
      membership(1, 20, { worldEntity: worldEntityKey(1, 1), passIndex: 2 }),
    ]);
    const firstSlots = scene.slotsSnapshot();
    const firstSnapshots = firstSlots.map((owner) => owner.snapshot);
    const firstClaims = firstSlots.map((owner) => claims.claim(owner, candidate(owner.slot)));
    expect(firstClaims[0]).not.toBe(firstClaims[1]);
    expect(firstClaims.map((claim) => claim.keys)).toEqual([['1:20:0:1'], ['4294967297:20:0:2']]);
    for (let frame = 1; frame <= 3; frame += 1) {
      const world = mat4.identity(mat4.create());
      world[12] = frame;
      scene.apply(
        firstSnapshots.map((snapshot) => ({
          kind: 'update' as const,
          worldId: snapshot.worldId,
          entityKey: snapshot.entityKey,
          snapshot: { ...snapshot, assetHandle: frame + 1, transform: { world } },
        })),
      );
      const slots = scene.slotsSnapshot();
      for (let index = 0; index < slots.length; index += 1) {
        const owner = slots[index] as Slot;
        expect(owner.snapshot).not.toBe(firstSnapshots[index]);
        expect(claims.claim(owner, candidate(owner.slot))).toBe(firstClaims[index]);
      }
    }
    scene.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
    add(0, 2);
    const replacement = scene.slotsSnapshot().find((owner) => owner.snapshot.entityKey === 2);
    if (replacement === undefined) throw Error('missing replacement entity');
    expect(claims.claim(replacement, candidate(replacement.slot)).compatible).toBe(false);
    const next = table([membership(2, 20)]);
    expect(next.claim(replacement, candidate(replacement.slot)).compatible).toBe(true);
  });

  it('reads a candidate material identity once when admitting its shadow claim', () => {
    const owner = slot(1, 20);
    let reads = 0;
    Object.defineProperty(owner.snapshot.materials[0], 'materialHandle', {
      get: () => {
        reads += 1;
        return 20;
      },
    });
    const claims = table([membership(1, 20)]);
    expect(claims.claim(owner, candidate(1)).compatible).toBe(true);
    expect(reads).toBe(1);
    claims.claim(owner, candidate(1));
    expect(reads).toBe(1);
  });

  it('keeps unclaimed, ambiguous and CPU-lane draws off the GPU lane', () => {
    expect(table([]).claim(slot(1, 20), candidate(1))).toMatchObject({
      keys: [],
      compatible: false,
    });
    expect(
      table([membership(1, 20), membership(1, 20, { passIndex: 2 })]).claim(
        slot(1, 20),
        candidate(1),
      ).compatible,
    ).toBe(false);
    expect(
      table([membership(1, 20, { cpuReason: 'unsupported-render-state' } as never)]).claim(
        slot(1, 20),
        candidate(1),
      ),
    ).toMatchObject({ keys: [expect.any(String)], compatible: false });
    expect(
      table([membership(1, 20, { gpuDrivenEligible: false })]).claim(slot(1, 20), candidate(1))
        .compatible,
    ).toBe(false);
  });

  it('recomputes for a new snapshot identity of the same slot', () => {
    const claims = table([membership(1, 20)]);
    const before = claims.claim(slot(1, 20), candidate(1));
    const rematerialized = claims.claim(slot(1, 21), candidate(1));
    expect(before.compatible).toBe(true);
    expect(rematerialized).not.toBe(before);
    expect(rematerialized.compatible).toBe(false);
  });
});

it('captures membership before the first claim even when the producer reuses mutable rows', () => {
  const row = membership(1, 20, { vertexEntry: 'original_vs', fragmentEntry: 'original_fs' });
  const rows = [row];
  const original = table(rows);
  Reflect.set(row, 'vertexEntry', 'next_vs');
  Reflect.set(row, 'fragmentEntry', 'next_fs');
  Reflect.set(row.renderState as object, 'cullMode', 'front');
  Reflect.set(row, 'gpuDrivenEligible', false);
  const next = table(rows);
  expect(original.claim(slot(1, 20), candidate(1))).toMatchObject({
    compatible: true,
    entry: {
      vertexEntry: 'original_vs',
      fragmentEntry: 'original_fs',
      renderState: { cullMode: 'back' },
    },
  });
  expect(next.claim(slot(1, 20), candidate(1))).toMatchObject({
    compatible: false,
    entry: { vertexEntry: 'next_vs', fragmentEntry: 'next_fs', renderState: { cullMode: 'front' } },
  });
});

it('compares GPU ownership facts independently of frame array positions', () => {
  const row = membership(1, 20, {
    vertexEntry: 'vs',
    fragmentEntry: 'fs',
    materialShaderId: 'shadow',
  });
  const owner = table([row]);
  expect(owner.matches(undefined, [{ ...row, renderState: { ...row.renderState } }])).toBe(true);
  expect(owner.matches(undefined, [{ ...row, renderableIndex: 2 }])).toBe(true);
  expect(owner.claim(slot(1, 20), candidate(1)).entry).not.toHaveProperty('renderableIndex');
  for (const change of [
    { worldEntity: 2 },
    { drawItemIndex: 2 },
    { materialHandle: 21 },
    { passIndex: 2 },
    { vertexEntry: 'other_vs' },
    { fragmentEntry: 'other_fs' },
    { materialShaderId: 'other_shadow' },
    { gpuDrivenEligible: false },
    { cpuReason: 'unprepared' as const },
    { renderState: { cullMode: 'front' as const } },
  ])
    expect(owner.matches(undefined, [{ ...row, ...change }])).toBe(false);
  expect(owner.matches(undefined, [])).toBe(false);
  expect(owner.matches(undefined, [row, row])).toBe(false);

  const state = {
    blend: { color: { srcFactor: 'one' as const }, alpha: {} },
    outputs: [
      {
        name: 'color',
        format: 'rgba8unorm' as const,
        blend: { color: {}, alpha: { operation: 'add' as const } },
      },
    ],
    stencil: { compare: 'always' as const },
  };
  const rejected = membership(1, 20, { renderState: state });
  const previous = table([rejected]);
  Reflect.set(state.blend.color, 'srcFactor', 'zero');
  Reflect.set(state.outputs[0]?.blend.alpha as object, 'operation', 'subtract');
  Reflect.set(state.stencil, 'compare', 'never');
  expect(previous.matches(undefined, [rejected])).toBe(false);
  expect(previous.claim(slot(1, 20), candidate(1))).toMatchObject({
    compatible: false,
    entry: {
      renderState: {
        blend: { color: { srcFactor: 'one' } },
        outputs: [{ blend: { alpha: { operation: 'add' } } }],
        stencil: { compare: 'always' },
      },
    },
  });
});

it('compares and snapshots legacy key-only publications without retaining their mutable Set', () => {
  const keys = new Set(['1:20:0:1']);
  const previous = new ShadowClaimTable(keys, undefined);
  expect(previous.matches(new Set(keys), undefined)).toBe(true);
  keys.clear();
  expect(previous.matches(keys, undefined)).toBe(false);
  expect(previous.claim(slot(1, 20), candidate(1))).toMatchObject({
    compatible: true,
    keys: ['1:20:0:1'],
  });
});

it('preserves the legacy key producer second-iteration failure and retries after recovery', () => {
  const keys = new Set(['1:20:0:1']);
  const failure = Error('second key iteration unavailable');
  let iterations = 0;
  let fail = true;
  Object.defineProperty(keys, Symbol.iterator, {
    value() {
      iterations += 1;
      if (fail && iterations === 2) throw failure;
      return Set.prototype[Symbol.iterator].call(this);
    },
  });
  expect(() => new ShadowClaimTable(keys, undefined)).toThrow(failure);
  expect(iterations).toBe(2);
  fail = false;
  const recovered = new ShadowClaimTable(keys, undefined);
  expect(iterations).toBe(4);
  expect(recovered.claim(slot(1, 20), candidate(1))).toMatchObject({
    compatible: true,
    keys: ['1:20:0:1'],
  });
});
