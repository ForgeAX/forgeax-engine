import { createMeshBuilder } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createDynamicGeometryLifecycle, type DynamicGeometryCandidate } from '../index.js';

const mesh = (): MeshAsset => ({
  kind: 'mesh',
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint16Array([0, 1, 2]),
  attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
  aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
  submeshes: [
    { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
  ],
  materialSlots: [{ slotName: 'default', sourceKey: 'default' }],
});

describe('standard dynamic geometry lifecycle', () => {
  it('retains the published candidate while validating each frame and issuing fresh receipts', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const candidate = lifecycle
      .prepare({ world, entity: 7, mesh: mesh(), revision: 1, fixedStep: 4 }, 1)
      .unwrap();
    const accepted = lifecycle.accept(candidate, { world, fixedStep: 4 }).unwrap();
    const observed: DynamicGeometryCandidate[] = [];
    const frames = [];
    for (let frameId = 1; frameId <= 60; frameId++) {
      const frame = { frameId, deviceGeneration: 1, completed: Promise.resolve(frameId) };
      const receipts = lifecycle.publishFrame(
        frame,
        [world],
        frameId + 4,
        (current) => {
          observed.push(current);
          return frameId !== 31;
        },
        () => 'cpu',
      );
      if (frameId === 31) {
        expect(receipts).toEqual([]);
        expect(lifecycle.receipt(accepted)?.frameId).toBe(30);
        continue;
      }
      expect(receipts).toHaveLength(1);
      const receipt = receipts[0];
      expect(receipt).toMatchObject({
        candidateId: accepted.candidateId,
        frameId,
        publicationFixedStep: frameId + 4,
        recordStageConsumed: true,
        recordStageLane: 'cpu',
        frame: { frameId, completed: frame.completed },
      });
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt?.frame)).toBe(true);
      frames.push(receipt?.frame);
      frame.frameId = -1;
      expect(receipt?.frame.frameId).toBe(frameId);
    }
    expect(observed).toHaveLength(60);
    expect(observed[0]?.state).toBe('accepted');
    expect(observed[1]?.state).toBe('published');
    expect(new Set(observed.slice(1)).size).toBe(1);
    expect(observed.every(Object.isFrozen)).toBe(true);
    expect(new Set(frames).size).toBe(59);
    expect(accepted.state).toBe('accepted');
    expect(lifecycle.receipt(accepted)?.frameId).toBe(60);
  });

  it.each([false, true])('shares only immutable data frame snapshots (frozen: %s)', (frozen) => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    for (let entity = 0; entity < 8; entity++) {
      lifecycle
        .accept(lifecycle.prepare({ world, entity, mesh: mesh(), revision: 1 }, 1).unwrap())
        .unwrap();
    }
    const frame = { frameId: 1, deviceGeneration: 1, completed: Promise.resolve() };
    if (frozen) Object.freeze(frame);
    const receipts = lifecycle.publishFrame(frame, [world], undefined, () => {
      if (!frozen) frame.frameId++;
      return true;
    });
    expect(receipts).toHaveLength(8);
    expect(new Set(receipts.map((receipt) => receipt.frame)).size).toBe(frozen ? 1 : 8);
    expect(receipts.every((receipt) => Object.isFrozen(receipt.frame))).toBe(true);
    expect(receipts.map((receipt) => receipt.frame.frameId)).toEqual(
      frozen ? Array(8).fill(1) : [2, 3, 4, 5, 6, 7, 8, 9],
    );
    const next = lifecycle.publishFrame(Object.freeze({ frameId: 2, deviceGeneration: 1 }), [
      world,
    ]);
    expect(next[0]?.frame).not.toBe(receipts[0]?.frame);
  });

  it('does not share frozen accessor frames or omit their per-candidate observations', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    for (let entity = 0; entity < 3; entity++) {
      lifecycle
        .accept(lifecycle.prepare({ world, entity, mesh: mesh(), revision: 1 }, 1).unwrap())
        .unwrap();
    }
    let reads = 0;
    const frame = Object.freeze({
      get frameId() {
        return ++reads;
      },
      deviceGeneration: 1,
    });
    const receipts = lifecycle.publishFrame(frame, [world]);
    expect(receipts.map((receipt) => receipt.frameId)).toEqual([1, 4, 7]);
    expect(receipts.map((receipt) => receipt.frame.frameId)).toEqual([2, 5, 8]);
    expect(new Set(receipts.map((receipt) => receipt.frame)).size).toBe(3);
    expect(reads).toBe(9);
  });

  it('keeps the 32 slots for transient candidates after 33 distinct meshes publish', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    for (let entity = 1; entity <= 33; entity += 1) {
      const prepared = lifecycle.prepare({ world, entity, mesh: mesh(), revision: 1 }, 1);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(lifecycle.accept(prepared.value).ok).toBe(true);
      expect(
        lifecycle.publishFrame({ frameId: entity, deviceGeneration: 1 }, [world]),
      ).toContainEqual(expect.objectContaining({ candidateId: prepared.value.candidateId }));
    }
    expect(lifecycle.inspect().published).toBe(33);
    const pending = Array.from({ length: 32 }, (_, index) =>
      lifecycle.prepare({ world, entity: 100 + index, mesh: mesh(), revision: 1 }, 1).unwrap(),
    );
    expect(lifecycle.prepare({ world, entity: 132, mesh: mesh(), revision: 1 }, 1)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-budget-exceeded', detail: { actual: 32 } },
    });
    const first = pending[0];
    if (!first) throw new Error('expected a pending candidate');
    lifecycle.cancel(first).unwrap();
    expect(lifecycle.prepare({ world, entity: 132, mesh: mesh(), revision: 1 }, 1).ok).toBe(true);
  });
  it('accepts a MeshBuilder interleaved color buffer with four vertices', () => {
    const source = createMeshBuilder({
      attributes: {
        position: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
        color: new Float32Array(16).fill(1),
      },
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    })
      .build()
      .unwrap();
    expect(source.vertices.length % 3).not.toBe(0);
    const lifecycle = createDynamicGeometryLifecycle();
    expect(lifecycle.prepare({ world: {}, mesh: source, revision: 1 }, 1).ok).toBe(true);
  });

  it('validates referenced material slots rather than requiring one slot per submesh', () => {
    const source = mesh();
    const shared = { ...source, submeshes: [...source.submeshes, ...source.submeshes] };
    const lifecycle = createDynamicGeometryLifecycle();
    expect(lifecycle.prepare({ world: {}, mesh: shared, revision: 1 }, 1).ok).toBe(true);
    expect(
      lifecycle.prepare(
        {
          world: {},
          mesh: {
            ...source,
            submeshes: source.submeshes.map((submesh) => ({ ...submesh, materialSlot: 2 })),
          },
          revision: 1,
        },
        1,
      ).ok,
    ).toBe(false);
  });

  it('issues payload-free credentials and publishes only after a matching frame generation', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const source = mesh();
    const prepared = lifecycle.prepare(
      { world, mesh: source, revision: 1, topologyRevision: 7 },
      3,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.value).not.toHaveProperty('mesh');

    const accepted = lifecycle.accept(prepared.value);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.state).toBe('accepted');
    expect(accepted.value).not.toHaveProperty('mesh');
    const receiptsBefore = lifecycle.publishFrame({ frameId: 4, deviceGeneration: 2 });
    expect(receiptsBefore).toEqual([]);
    const receipts = lifecycle.publishFrame({ frameId: 5, deviceGeneration: 3 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      candidateId: accepted.value.candidateId,
      frameId: 5,
      topologyRevision: 7,
      recordStageConsumed: false,
    });
    expect(lifecycle.receipt(accepted.value)).toMatchObject({
      candidateId: accepted.value.candidateId,
      frameId: 5,
      deviceGeneration: 3,
    });
    expect(lifecycle.inspect()).toMatchObject({
      generation: 3,
      published: 1,
      latestRevision: 1,
      latestFrameId: 5,
    });
    expect(lifecycle.retire(accepted.value).ok).toBe(true);
    expect(lifecycle.finalizeRetirement(accepted.value).ok).toBe(true);
    const stale = lifecycle.prepare({ world, mesh: mesh(), revision: 1 }, 3);
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(lifecycle.accept(stale.value)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-stale' },
    });
  });

  it('keeps old state when preparation is invalid and bounds in-flight work', () => {
    const lifecycle = createDynamicGeometryLifecycle(1);
    const world = {};
    const first = lifecycle.prepare({ world, mesh: mesh(), revision: 1 }, 1);
    expect(first.ok).toBe(true);
    const invalid = lifecycle.prepare(
      { world, mesh: { ...mesh(), vertices: new Float32Array() }, revision: 2 },
      1,
    );
    expect(invalid.ok).toBe(false);
    if (!first.ok) return;
    expect(lifecycle.cancel(first.value).ok).toBe(true);
    const replacement = lifecycle.prepare({ world, mesh: mesh(), revision: 2 }, 1);
    expect(replacement.ok).toBe(true);
  });

  it('invalidates candidates on world teardown and device-generation change', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const prepared = lifecycle.prepare({ world, mesh: mesh(), revision: 1 }, 1);
    expect(prepared.ok).toBe(true);
    lifecycle.invalidateWorld(world);
    expect(lifecycle.inspect()).toMatchObject({ prepared: 0, invalidated: 1 });
    const next = lifecycle.prepare({ world, mesh: mesh(), revision: 2 }, 1);
    expect(next.ok).toBe(true);
    lifecycle.invalidateGeneration(2);
    expect(lifecycle.inspect()).toMatchObject({ generation: 2, prepared: 0, invalidated: 2 });
  });

  it('rejects cross-lifecycle credentials and publishes only the ordered World step', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const otherLifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const otherWorld = {};
    const prepared = lifecycle.prepare({ world, mesh: mesh(), revision: 1 }, 1);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(otherLifecycle.accept(prepared.value)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-candidate-not-found' },
    });
    const colliding = otherLifecycle.prepare({ world, mesh: mesh(), revision: 1 }, 1);
    expect(colliding.ok).toBe(true);
    if (!colliding.ok) return;
    expect(colliding.value.candidateId).toBe(prepared.value.candidateId);
    expect(lifecycle.receipt(colliding.value)).toBeUndefined();
    const accepted = lifecycle.accept(prepared.value, { world, fixedStep: 4 });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(lifecycle.publishFrame({ frameId: 1, deviceGeneration: 1 }, [otherWorld], 4)).toEqual(
      [],
    );
    expect(lifecycle.publishFrame({ frameId: 2, deviceGeneration: 1 }, [world], 3)).toEqual([]);
    expect(lifecycle.publishFrame({ frameId: 3, deviceGeneration: 1 }, [world], 4)).toHaveLength(1);
  });

  it('does not let a late lower revision replace a published candidate', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const entity = 7;
    const olderLod = AssetGuid.random();
    const olderMesh = {
      ...mesh(),
      lods: [{ mesh: olderLod, screenCoverage: 0.5 }],
    };
    olderMesh.vertices[0] = 3;
    const newerLod = AssetGuid.random();
    const newerMesh = {
      ...mesh(),
      lods: [{ mesh: newerLod, screenCoverage: 0.5 }],
    };
    newerMesh.vertices[0] = 4;
    const older = lifecycle.prepare(
      { world, entity, mesh: olderMesh, revision: 3, topologyRevision: 1 },
      1,
    );
    const newer = lifecycle.prepare(
      { world, entity, mesh: newerMesh, revision: 4, topologyRevision: 1 },
      1,
    );
    expect(newer.ok).toBe(true);
    expect(older.ok).toBe(true);
    if (!newer.ok || !older.ok) return;

    const accepted = lifecycle.accept(newer.value);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value).not.toHaveProperty('mesh');
    const firstFrame = lifecycle.publishFrame({ frameId: 1, deviceGeneration: 1 }, [world]);
    expect(firstFrame).toHaveLength(1);
    expect(firstFrame[0]).toMatchObject({
      candidateId: newer.value.candidateId,
      revision: 4,
      frameId: 1,
    });

    expect(lifecycle.accept(older.value)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-stale' },
    });
    expect(lifecycle.cancel(older.value).ok).toBe(true);
    const secondFrame = lifecycle.publishFrame({ frameId: 2, deviceGeneration: 1 }, [world]);
    expect(secondFrame).toHaveLength(1);
    expect(secondFrame[0]).toMatchObject({
      candidateId: newer.value.candidateId,
      revision: 4,
      frameId: 2,
    });
    expect(lifecycle.receipt(accepted.value)).toMatchObject({
      candidateId: newer.value.candidateId,
      revision: 4,
      frameId: 2,
    });
    expect(lifecycle.inspect()).toMatchObject({
      latestRevision: 4,
      latestFrameId: 2,
      published: 1,
    });
  });

  it('invalidates topology history while retaining the published receipt fence', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const previous = lifecycle.prepare(
      { world, mesh: mesh(), revision: 1, topologyRevision: 1 },
      1,
    );
    expect(previous.ok).toBe(true);
    if (!previous.ok) return;
    const acceptedPrevious = lifecycle.accept(previous.value);
    expect(acceptedPrevious.ok).toBe(true);
    if (!acceptedPrevious.ok) return;
    expect(lifecycle.publishFrame({ frameId: 1, deviceGeneration: 1 })).toHaveLength(1);
    expect(lifecycle.receipt(acceptedPrevious.value)).toMatchObject({ frameId: 1 });

    const replacement = lifecycle.prepare(
      { world, mesh: mesh(), revision: 2, topologyRevision: 2 },
      1,
    );
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(lifecycle.accept(replacement.value).ok).toBe(true);
    // Topology invalidates temporal history but must preserve the published
    // receipt fence until explicit retirement can hand GPU destruction to the
    // completion promise.
    expect(lifecycle.receipt(acceptedPrevious.value)).toMatchObject({ frameId: 1 });
    expect(lifecycle.inspect()).toMatchObject({ historyInvalidations: 1, invalidated: 1 });
    expect(lifecycle.retire(acceptedPrevious.value).ok).toBe(true);
    expect(lifecycle.finalizeRetirement(acceptedPrevious.value).ok).toBe(true);
  });

  it('rejects a topology revision that regresses after a newer history was accepted', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const current = lifecycle.prepare({ world, mesh: mesh(), revision: 2, topologyRevision: 4 }, 1);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(lifecycle.accept(current.value).ok).toBe(true);
    expect(lifecycle.publishFrame({ frameId: 1, deviceGeneration: 1 })).toHaveLength(1);

    const regressed = lifecycle.prepare(
      { world, mesh: mesh(), revision: 3, topologyRevision: 3 },
      1,
    );
    expect(regressed.ok).toBe(true);
    if (!regressed.ok) return;
    expect(lifecycle.accept(regressed.value)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-stale' },
    });
  });

  it('accounts for mesh bytes, rejects unknown retirement, and preserves a multi-step receipt', () => {
    const world = {};
    const lifecycle = createDynamicGeometryLifecycle(4, 1_000);
    const prepared = lifecycle.prepare({ world, mesh: mesh(), revision: 1, fixedStep: 2 }, 1);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(lifecycle.inspect().meshBytes).toBeGreaterThan(0);
    const tooLarge = lifecycle.prepare(
      { world, mesh: { ...mesh(), vertices: new Float32Array(3_000) }, revision: 2 },
      1,
    );
    expect(tooLarge).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-budget-exceeded' },
    });
    expect(lifecycle.accept(prepared.value).ok).toBe(true);
    const completed = Promise.resolve();
    const receipts = lifecycle.publishFrame(
      { frameId: 4, deviceGeneration: 1, completed },
      [world],
      5,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      fixedStep: 2,
      publicationFixedStep: 5,
      recordStageConsumed: false,
      frame: { completed },
    });
    expect(lifecycle.retire({ ...prepared.value, candidateId: 'unknown' })).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-candidate-not-found' },
    });
    expect(lifecycle.retire(prepared.value).ok).toBe(true);
    expect(lifecycle.finalizeRetirement(prepared.value).ok).toBe(true);
    expect(lifecycle.inspect().meshBytes).toBe(0);
  });
});
