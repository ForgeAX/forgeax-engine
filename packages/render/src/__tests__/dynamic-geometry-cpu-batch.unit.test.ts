import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createDynamicGeometryLifecycle,
  type DynamicGeometryCandidate,
  type DynamicGeometryOrdering,
  type DynamicGeometryPrepareInput,
} from '../dynamic-geometry';

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

type CandidateExtras = Partial<
  Pick<
    DynamicGeometryPrepareInput,
    'fixedStep' | 'materialIdentity' | 'meshHandle' | 'physicsEntity'
  >
>;

const prepareCandidate = (
  lifecycle: ReturnType<typeof createDynamicGeometryLifecycle>,
  world: object,
  entity: number | undefined,
  revision: number,
  topologyRevision = revision,
  extras: CandidateExtras = {},
): DynamicGeometryCandidate =>
  lifecycle
    .prepare(
      {
        world,
        ...(entity === undefined ? {} : { entity }),
        mesh: mesh(),
        revision,
        topologyRevision,
        ...extras,
      },
      1,
    )
    .unwrap();

const prepareCandidateResult = (
  lifecycle: ReturnType<typeof createDynamicGeometryLifecycle>,
  world: object,
  entity: number | undefined,
  revision: number,
) =>
  lifecycle.prepare(
    {
      world,
      ...(entity === undefined ? {} : { entity }),
      mesh: mesh(),
      revision,
    },
    1,
  );

describe('DynamicGeometryLifecycle CPU batch acceptance', () => {
  it('validates and accepts scalar credentials without retaining or copying mesh payloads', () => {
    let copies = 0;
    class CountedPositions extends Float32Array {
      constructor(values: ArrayLike<number>) {
        super(values);
        copies++;
      }
    }
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const source = mesh();
    source.attributes.position = new CountedPositions(source.vertices);
    copies = 0;
    const candidates = lifecycle
      .prepareCandidates(
        [1, 2].map((entity) => ({ world, entity, mesh: source, revision: 1 })),
        1,
      )
      .unwrap();
    expect(copies).toBe(0);
    expect(candidates.every((candidate) => !('mesh' in candidate))).toBe(true);
    const before = lifecycle.inspect();
    const ordering = { world, fixedStep: 1 };
    expect(lifecycle.validateCandidates(candidates, ordering).ok).toBe(true);
    expect(lifecycle.inspect()).toEqual(before);
    const accepted = lifecycle.acceptCandidates(candidates, ordering).unwrap();
    expect(copies).toBe(0);
    expect(accepted.every((candidate) => !('mesh' in candidate))).toBe(true);
    expect(lifecycle.inspect().meshBytes).toBe(before.meshBytes);
    for (const candidate of accepted) lifecycle.cancel(candidate).unwrap();
    expect(lifecycle.inspect()).toMatchObject({ prepared: 0, accepted: 0, meshBytes: 0 });
    lifecycle.dispose();
  });

  it('Reproduces the legacy item-wise path: a later credential refusal accepts the earlier item and invalidates old history', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const oldA = prepareCandidate(lifecycle, world, 1, 1, 1);
    const oldB = prepareCandidate(lifecycle, world, 2, 1, 1);
    const acceptedOldA = lifecycle.accept(oldA, { world, fixedStep: 1 }).unwrap();
    const acceptedOldB = lifecycle.accept(oldB, { world, fixedStep: 1 }).unwrap();
    const nextA = prepareCandidate(lifecycle, world, 1, 2, 2);
    const nextB = prepareCandidate(lifecycle, world, 2, 2, 2);
    const before = lifecycle.inspect();
    const acceptedA = lifecycle.accept(nextA, { world, fixedStep: 2 });
    expect(acceptedA.ok).toBe(true);
    const refusedB = lifecycle.accept({ ...nextB, revision: 3 }, { world, fixedStep: 2 });
    expect(refusedB).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-receipt-mismatch' },
    });
    expect(before).toMatchObject({
      prepared: 2,
      accepted: 2,
      published: 0,
      historyInvalidations: 0,
      invalidated: 0,
    });
    expect(lifecycle.inspect()).toMatchObject({
      prepared: 1,
      accepted: 3,
      published: 0,
      historyInvalidations: 1,
      invalidated: 1,
    });
    expect(lifecycle.receipt(acceptedOldA)).toBeUndefined();
    expect(lifecycle.receipt(acceptedOldB)).toBeUndefined();
    if (acceptedA.ok) lifecycle.cancel(acceptedA.value).unwrap();
    lifecycle.cancel(nextB).unwrap();
    lifecycle.cancel(acceptedOldA).unwrap();
    lifecycle.cancel(acceptedOldB).unwrap();
  });

  it('C01 rejects the whole batch on a later invalid credential in either order and preserves prior accepted history', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const oldA = lifecycle
      .accept(prepareCandidate(lifecycle, world, 1, 1, 1), { world, fixedStep: 1 })
      .unwrap();
    const oldB = lifecycle
      .accept(prepareCandidate(lifecycle, world, 2, 1, 1), { world, fixedStep: 1 })
      .unwrap();
    const nextA = prepareCandidate(lifecycle, world, 1, 2, 2);
    const nextB = prepareCandidate(lifecycle, world, 2, 2, 2);
    const tamperedB = { ...nextB, revision: nextB.revision + 1 };
    const before = lifecycle.inspect();

    for (const candidates of [
      [nextA, tamperedB],
      [tamperedB, nextA],
    ]) {
      expect(lifecycle.acceptCandidates(candidates, { world, fixedStep: 2 })).toMatchObject({
        ok: false,
        error: { code: 'dynamic-geometry-receipt-mismatch' },
      });
      expect(lifecycle.inspect()).toEqual(before);
      expect(lifecycle.receipt(oldA)).toBeUndefined();
      expect(lifecycle.receipt(oldB)).toBeUndefined();
    }
    lifecycle.cancel(nextA).unwrap();
    lifecycle.cancel(nextB).unwrap();
    expect(lifecycle.inspect()).toMatchObject({
      prepared: 0,
      accepted: 2,
      historyInvalidations: 0,
      invalidated: 0,
    });
    lifecycle.cancel(oldA).unwrap();
    lifecycle.cancel(oldB).unwrap();
  });

  it('C02 checks every scalar credential without trusting the external MeshAsset copy', () => {
    const firstHandle = {} as AssetHandle<'mesh'>;
    const secondHandle = {} as AssetHandle<'mesh'>;
    const mutations: readonly {
      readonly name: string;
      readonly expected:
        | 'dynamic-geometry-candidate-not-found'
        | 'dynamic-geometry-receipt-mismatch';
      readonly mutate: (
        candidate: DynamicGeometryCandidate,
        otherWorld: object,
      ) => DynamicGeometryCandidate;
    }[] = [
      {
        name: 'candidateId',
        expected: 'dynamic-geometry-candidate-not-found',
        mutate: (candidate) => ({ ...candidate, candidateId: `${candidate.candidateId}:tampered` }),
      },
      {
        name: 'owner',
        expected: 'dynamic-geometry-candidate-not-found',
        mutate: (candidate) => ({ ...candidate, owner: {} }),
      },
      {
        name: 'world',
        expected: 'dynamic-geometry-candidate-not-found',
        mutate: (candidate, otherWorld) => ({ ...candidate, world: otherWorld }),
      },
      {
        name: 'generation',
        expected: 'dynamic-geometry-candidate-not-found',
        mutate: (candidate) => ({ ...candidate, generation: candidate.generation + 1 }),
      },
      {
        name: 'entity',
        expected: 'dynamic-geometry-receipt-mismatch',
        mutate: (candidate) => ({ ...candidate, entity: (candidate.entity ?? 0) + 1 }),
      },
      {
        name: 'physicsEntity',
        expected: 'dynamic-geometry-receipt-mismatch',
        mutate: (candidate) => ({
          ...candidate,
          physicsEntity: (candidate.physicsEntity ?? 0) + 1,
        }),
      },
      {
        name: 'gpuReady',
        expected: 'dynamic-geometry-receipt-mismatch',
        mutate: (candidate) => ({ ...candidate, gpuReady: !candidate.gpuReady }),
      },
      {
        name: 'meshBytes',
        expected: 'dynamic-geometry-receipt-mismatch',
        mutate: (candidate) => ({ ...candidate, meshBytes: candidate.meshBytes + 1 }),
      },
      {
        name: 'revision',
        expected: 'dynamic-geometry-receipt-mismatch',
        mutate: (candidate) => ({ ...candidate, revision: candidate.revision + 1 }),
      },
      {
        name: 'topologyRevision',
        expected: 'dynamic-geometry-receipt-mismatch',
        mutate: (candidate) => ({ ...candidate, topologyRevision: candidate.topologyRevision + 1 }),
      },
      {
        name: 'materialIdentity',
        expected: 'dynamic-geometry-receipt-mismatch',
        mutate: (candidate) => ({
          ...candidate,
          materialIdentity: `${candidate.materialIdentity ?? ''}:tampered`,
        }),
      },
      {
        name: 'meshHandle',
        expected: 'dynamic-geometry-receipt-mismatch',
        mutate: (candidate) => ({ ...candidate, meshHandle: secondHandle }),
      },
      {
        name: 'fixedStep',
        expected: 'dynamic-geometry-receipt-mismatch',
        mutate: (candidate) => ({ ...candidate, fixedStep: (candidate.fixedStep ?? 0) + 1 }),
      },
    ];

    for (const mutation of mutations) {
      const lifecycle = createDynamicGeometryLifecycle();
      const world = {};
      const otherWorld = {};
      const first = prepareCandidate(lifecycle, world, 1, 1, 1, {
        physicsEntity: 101,
        materialIdentity: 'surface',
        meshHandle: firstHandle,
        fixedStep: 1,
      });
      const second = prepareCandidate(lifecycle, world, 2, 1, 1, {
        physicsEntity: 102,
        materialIdentity: 'surface',
        meshHandle: firstHandle,
        fixedStep: 1,
      });
      const before = lifecycle.inspect();
      expect(
        lifecycle.acceptCandidates([first, mutation.mutate(second, otherWorld)], {
          world,
          fixedStep: 2,
        }),
      ).toMatchObject({ ok: false, error: { code: mutation.expected } });
      expect(lifecycle.inspect()).toEqual(before);
      lifecycle.cancel(first).unwrap();
      lifecycle.cancel(second).unwrap();
    }

    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const first = prepareCandidate(lifecycle, world, 1, 1, 1);
    const second = prepareCandidate(lifecycle, world, 2, 1, 1);
    expect(second).not.toHaveProperty('mesh');
    const accepted = lifecycle.acceptCandidates([first, second], { world, fixedStep: 2 }).unwrap();
    expect(accepted[1]).not.toHaveProperty('mesh');
    for (const candidate of accepted) lifecycle.cancel(candidate).unwrap();
  });

  it('C02 rejects forged input states, accepted replay, and credentials from another owner', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const otherLifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const first = prepareCandidate(lifecycle, world, 1, 1, 1);
    const second = prepareCandidate(lifecycle, world, 2, 1, 1);
    const before = lifecycle.inspect();
    expect(
      lifecycle.acceptCandidates([first, { ...second, state: 'accepted' }], {
        world,
        fixedStep: 2,
      }),
    ).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-candidate-state' } });
    expect(lifecycle.inspect()).toEqual(before);

    const acceptedSecond = lifecycle.accept(second, { world, fixedStep: 2 }).unwrap();
    const beforeReplay = lifecycle.inspect();
    expect(
      lifecycle.acceptCandidates([first, { ...acceptedSecond, state: 'prepared' }], {
        world,
        fixedStep: 2,
      }),
    ).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-candidate-state' } });
    expect(lifecycle.inspect()).toEqual(beforeReplay);

    const foreign = prepareCandidate(otherLifecycle, world, 3, 1, 1);
    expect(lifecycle.acceptCandidates([first, foreign], { world, fixedStep: 2 })).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-candidate-not-found' },
    });
    expect(lifecycle.inspect()).toEqual(beforeReplay);
    lifecycle.cancel(first).unwrap();
    lifecycle.cancel(acceptedSecond).unwrap();
    otherLifecycle.cancel(foreign).unwrap();
  });

  it('C01-C05 scan all credentials and states before checking ordering', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const otherWorld = {};
    const first = prepareCandidate(lifecycle, world, 1, 1, 1, { fixedStep: 3 });
    const second = prepareCandidate(lifecycle, world, 2, 1, 1, { fixedStep: 3 });
    const before = lifecycle.inspect();

    expect(
      lifecycle.acceptCandidates([first, { ...second, revision: 2 }], {
        world: otherWorld,
        fixedStep: 2,
      }),
    ).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-receipt-mismatch' } });
    expect(lifecycle.inspect()).toEqual(before);

    expect(
      lifecycle.acceptCandidates([first, { ...second, state: 'accepted' }], {
        world: otherWorld,
        fixedStep: 2,
      }),
    ).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-candidate-state' } });
    expect(lifecycle.inspect()).toEqual(before);
    lifecycle.cancel(first).unwrap();
    lifecycle.cancel(second).unwrap();
  });

  it('C03 rejects duplicate credentials, duplicate render entities, and conflicts in the undefined entity slot', () => {
    const sameCandidateLifecycle = createDynamicGeometryLifecycle();
    const sameWorld = {};
    const sameCandidate = prepareCandidate(sameCandidateLifecycle, sameWorld, 1, 1, 1);
    const sameCandidateBefore = sameCandidateLifecycle.inspect();
    expect(
      sameCandidateLifecycle.acceptCandidates([sameCandidate, sameCandidate], {
        world: sameWorld,
        fixedStep: 2,
      }),
    ).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-invalid' } });
    expect(sameCandidateLifecycle.inspect()).toEqual(sameCandidateBefore);
    sameCandidateLifecycle.cancel(sameCandidate).unwrap();

    for (const entity of [7, undefined] as const) {
      const lifecycle = createDynamicGeometryLifecycle();
      const world = {};
      const first = prepareCandidate(lifecycle, world, entity, 1, 1);
      const second = prepareCandidate(lifecycle, world, entity, 2, 1);
      const before = lifecycle.inspect();
      expect(lifecycle.acceptCandidates([first, second], { world, fixedStep: 2 })).toMatchObject({
        ok: false,
        error: { code: 'dynamic-geometry-invalid' },
      });
      expect(lifecycle.inspect()).toEqual(before);
      lifecycle.cancel(first).unwrap();
      lifecycle.cancel(second).unwrap();
    }
  });

  it('C04 rejects the whole batch for a stale later member and requires matching World ordering and preparation step', async () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const old = lifecycle
      .accept(prepareCandidate(lifecycle, world, 1, 1, 4), { world, fixedStep: 1 })
      .unwrap();
    const other = prepareCandidate(lifecycle, world, 2, 1, 1);
    const regressed = prepareCandidate(lifecycle, world, 1, 2, 3);
    const before = lifecycle.inspect();
    expect(lifecycle.acceptCandidates([other, regressed], { world, fixedStep: 2 })).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-stale' },
    });
    expect(lifecycle.inspect()).toEqual(before);
    lifecycle.cancel(other).unwrap();
    lifecycle.cancel(regressed).unwrap();
    lifecycle.cancel(old).unwrap();

    const invalidOrderings: readonly DynamicGeometryOrdering[] = [
      { world: {}, fixedStep: 2 },
      { world, fixedStep: -1 },
      { world, fixedStep: 1.5 },
      { world, fixedStep: 1 },
    ];
    for (const invalidOrdering of invalidOrderings) {
      const orderingLifecycle = createDynamicGeometryLifecycle();
      const candidate = prepareCandidate(orderingLifecycle, world, 1, 1, 1, { fixedStep: 2 });
      const orderingBefore = orderingLifecycle.inspect();
      expect(orderingLifecycle.acceptCandidates([candidate], invalidOrdering)).toMatchObject({
        ok: false,
        error: { code: 'dynamic-geometry-ordering-required' },
      });
      expect(orderingLifecycle.inspect()).toEqual(orderingBefore);
      orderingLifecycle.cancel(candidate).unwrap();
    }

    const fencedLifecycle = createDynamicGeometryLifecycle();
    const fencedWorld = {};
    const active = prepareCandidate(fencedLifecycle, fencedWorld, 1, 1, 1);
    const cancelled = prepareCandidate(fencedLifecycle, fencedWorld, 2, 1, 1);
    let resolveFence: (() => void) | undefined;
    const fence = new Promise<void>((resolve) => {
      resolveFence = resolve;
    });
    fencedLifecycle.cancel(cancelled, fence).unwrap();
    const afterInvalidation = fencedLifecycle.inspect();
    expect(
      fencedLifecycle.acceptCandidates([active, cancelled], { world: fencedWorld, fixedStep: 2 }),
    ).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-candidate-state' },
    });
    expect(fencedLifecycle.inspect()).toEqual(afterInvalidation);
    fencedLifecycle.cancel(active).unwrap();
    resolveFence?.();
    await fence;
    await Promise.resolve();
    expect(fencedLifecycle.inspect().meshBytes).toBe(0);
  });

  it('C04 invalidates the generation before refusing a snapshot and reserves no budget for an invalid topology revision', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const first = prepareCandidate(lifecycle, world, 1, 1, 1);
    const second = prepareCandidate(lifecycle, world, 2, 1, 1);
    lifecycle.invalidateGeneration(2);
    const afterGenerationChange = lifecycle.inspect();
    expect(lifecycle.acceptCandidates([first, second], { world, fixedStep: 2 })).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-candidate-not-found' },
    });
    expect(lifecycle.inspect()).toEqual(afterGenerationChange);

    const topologyLifecycle = createDynamicGeometryLifecycle();
    const topologyWorld = {};
    const before = topologyLifecycle.inspect();
    for (const topologyRevision of [-1, 1.5, Number.NaN]) {
      expect(
        topologyLifecycle.prepare(
          { world: topologyWorld, entity: 1, mesh: mesh(), revision: 1, topologyRevision },
          1,
        ),
      ).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-invalid' } });
      expect(topologyLifecycle.inspect()).toEqual(before);
    }
  });

  it('C04 rejects a batch member superseded by a newer prepared revision', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const newer = prepareCandidate(lifecycle, world, 1, 2, 1);
    const older = prepareCandidate(lifecycle, world, 1, 1, 1);
    const independent = prepareCandidate(lifecycle, world, 2, 1, 1);
    const before = lifecycle.inspect();
    expect(lifecycle.acceptCandidates([independent, older], { world, fixedStep: 2 })).toMatchObject(
      { ok: false, error: { code: 'dynamic-geometry-stale' } },
    );
    expect(lifecycle.inspect()).toEqual(before);
    lifecycle.cancel(newer).unwrap();
    lifecycle.cancel(older).unwrap();
    lifecycle.cancel(independent).unwrap();
  });

  it('C05 avoids double-charging the batch and keeps exact-limit and over-budget preparation stable', () => {
    const countLifecycle = createDynamicGeometryLifecycle(2, 2_048);
    const countWorld = {};
    const countFirst = prepareCandidate(countLifecycle, countWorld, 1, 1, 1);
    const countSecond = prepareCandidate(countLifecycle, countWorld, 2, 1, 1);
    const countBeforeOverflow = countLifecycle.inspect();
    expect(prepareCandidateResult(countLifecycle, countWorld, 3, 1)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-budget-exceeded' },
    });
    expect(countLifecycle.inspect()).toEqual(countBeforeOverflow);
    const countAccepted = countLifecycle
      .acceptCandidates([countFirst, countSecond], { world: countWorld, fixedStep: 2 })
      .unwrap();
    expect(countLifecycle.inspect()).toMatchObject({
      prepared: 0,
      accepted: 2,
      meshBytes: countBeforeOverflow.meshBytes,
    });
    for (const candidate of countAccepted) countLifecycle.cancel(candidate).unwrap();

    const byteLimit = 204;
    const byteLifecycle = createDynamicGeometryLifecycle(4, byteLimit);
    const byteWorld = {};
    const byteFirst = prepareCandidate(byteLifecycle, byteWorld, 1, 1, 1);
    const byteSecond = prepareCandidate(byteLifecycle, byteWorld, 2, 1, 1);
    expect(byteFirst.meshBytes + byteSecond.meshBytes).toBe(byteLimit);
    const byteBeforeOverflow = byteLifecycle.inspect();
    expect(prepareCandidateResult(byteLifecycle, byteWorld, 3, 1)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-budget-exceeded' },
    });
    expect(byteLifecycle.inspect()).toEqual(byteBeforeOverflow);
    const byteAccepted = byteLifecycle
      .acceptCandidates([byteFirst, byteSecond], { world: byteWorld, fixedStep: 2 })
      .unwrap();
    expect(byteLifecycle.inspect().meshBytes).toBe(byteLimit);
    for (const candidate of byteAccepted) byteLifecycle.cancel(candidate).unwrap();
  });

  it('C05 keeps the original budget reserved until the cancellation fence settles and releases it only once after rejection', async () => {
    const lifecycle = createDynamicGeometryLifecycle(1, 102);
    const world = {};
    const candidate = prepareCandidate(lifecycle, world, 1, 1, 1);
    let rejectFence: ((reason?: unknown) => void) | undefined;
    const fence = new Promise<void>((_resolve, reject) => {
      rejectFence = reject;
    });
    lifecycle.cancel(candidate, fence).unwrap();
    const beforeOverflow = lifecycle.inspect();
    expect(prepareCandidateResult(lifecycle, world, 2, 1)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-budget-exceeded' },
    });
    expect(lifecycle.inspect()).toEqual(beforeOverflow);
    rejectFence?.(new Error('completion fence rejected'));
    await fence.catch(() => undefined);
    await Promise.resolve();
    expect(lifecycle.inspect()).toMatchObject({ prepared: 0, accepted: 0, meshBytes: 0 });
    expect(lifecycle.cancel(candidate)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-candidate-not-found' },
    });
    const replacement = prepareCandidate(lifecycle, world, 2, 1, 1);
    lifecycle.cancel(replacement).unwrap();
  });

  it('C06 commits two valid topology updates once, returns complete credentials, and creates no receipt', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const oldA = lifecycle
      .accept(prepareCandidate(lifecycle, world, 1, 1, 1), { world, fixedStep: 1 })
      .unwrap();
    const oldB = lifecycle
      .accept(prepareCandidate(lifecycle, world, 2, 1, 1), { world, fixedStep: 1 })
      .unwrap();
    const nextA = prepareCandidate(lifecycle, world, 1, 2, 2, { fixedStep: 2 });
    const nextB = prepareCandidate(lifecycle, world, 2, 2, 2, { fixedStep: 2 });
    const before = lifecycle.inspect();
    const accepted = lifecycle.acceptCandidates([nextA, nextB], { world, fixedStep: 3 }).unwrap();
    expect(accepted).toHaveLength(2);
    expect(accepted.map((candidate) => candidate.candidateId)).toEqual([
      nextA.candidateId,
      nextB.candidateId,
    ]);
    expect(accepted.map((candidate) => candidate.state)).toEqual(['accepted', 'accepted']);
    expect(accepted.map((candidate) => candidate.fixedStep)).toEqual([3, 3]);
    expect(lifecycle.inspect()).toMatchObject({
      prepared: before.prepared - 2,
      accepted: before.accepted + 2,
      published: before.published,
      retired: before.retired,
      meshBytes: before.meshBytes,
      historyInvalidations: before.historyInvalidations + 2,
      invalidated: before.invalidated + 2,
    });
    expect(accepted.map((candidate) => lifecycle.receipt(candidate))).toEqual([
      undefined,
      undefined,
    ]);
    const afterAccept = lifecycle.inspect();
    expect(lifecycle.acceptCandidates(accepted, { world, fixedStep: 3 })).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-candidate-state' },
    });
    expect(lifecycle.inspect()).toEqual(afterAccept);
    for (const candidate of accepted) lifecycle.cancel(candidate).unwrap();
    lifecycle.cancel(oldA).unwrap();
    lifecycle.cancel(oldB).unwrap();
  });

  it('C06 geometry updates with the same topologyRevision do not add history invalidations', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const old = lifecycle
      .accept(prepareCandidate(lifecycle, world, 1, 1, 1), { world, fixedStep: 1 })
      .unwrap();
    const sameTopology = prepareCandidate(lifecycle, world, 1, 2, 1);
    const before = lifecycle.inspect();
    const accepted = lifecycle.acceptCandidates([sameTopology], { world, fixedStep: 2 }).unwrap();
    expect(accepted).toHaveLength(1);
    expect(lifecycle.inspect()).toMatchObject({
      historyInvalidations: before.historyInvalidations,
      invalidated: before.invalidated,
      meshBytes: before.meshBytes,
    });
    for (const candidate of accepted) lifecycle.cancel(candidate).unwrap();
    lifecycle.cancel(old).unwrap();
  });
});
