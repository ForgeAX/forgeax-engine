import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectedEnvironmentFrame } from '../environment/frame';
import type { RenderSystemInternals } from '../record/render-context';
import type { ReflectionProbeFact, ReflectionProbeSelectionResult } from '../reflection/projection';
import * as fallbackProjection from '../reflection/projection';
import { ReflectionProbeRecordOwner } from '../reflection/record-owner';
import type { SkylightSnapshot } from '../render-system-extract';

type FakeResource = {
  fact: ReflectionProbeFact;
  activeFact: ReflectionProbeFact | undefined;
  pmrem: { active: object | undefined };
  filter: { activeGeneration: number };
};

type Tickets = ReadonlyMap<
  string,
  {
    readonly ticket: number;
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly projection: fallbackProjection.ReflectionFallbackProjection;
    readonly signature: string;
  }
>;

function probeFact(entityKey: number): ReflectionProbeFact {
  return {
    entityKey,
    center: [0, 0, 0],
    halfExtents: [4, 4, 4],
    priority: 0,
    intensity: 1,
    resolution: 16,
    revision: 1,
  };
}

function readyResource(fact: ReflectionProbeFact): FakeResource {
  return { fact, activeFact: fact, pmrem: { active: {} }, filter: { activeGeneration: 1 } };
}

function probeSelection(entityKey: number, normalizedDistance: number) {
  return { kind: 'probe' as const, entityKey, normalizedDistance };
}

/**
 * Twenty consumers: ten inside a ready probe, five inside a probe whose
 * filtered result is not active yet (Skylight recovery), five outside every
 * probe. The scene inputs are mutable so a test can edit one input at a time.
 */
function scene() {
  const near = probeFact(7);
  const pending = probeFact(8);
  const accepted = new Map<string, FakeResource>([
    ['7', readyResource(near)],
    [
      '8',
      {
        fact: pending,
        activeFact: undefined,
        pmrem: { active: undefined },
        filter: { activeGeneration: 0 },
      },
    ],
  ]);
  const selections = new Map<string, ReflectionProbeSelectionResult>();
  for (let row = 0; row < 10; row++) selections.set(`r${row}`, probeSelection(7, row * 0.05));
  for (let row = 10; row < 15; row++) selections.set(`r${row}`, probeSelection(8, 0.25));
  for (let row = 15; row < 20; row++) selections.set(`r${row}`, { kind: 'skylight' });
  const skylight: { value: SkylightSnapshot | undefined } = {
    value: {
      entityHandle: 3,
      equirectHandle: 1,
      color: [1, 1, 1],
      intensity: 1,
      rotation: [0, 0, 0, 1],
    },
  };
  const environment = { value: { environmentSignature: 'env-a' } as SelectedEnvironmentFrame };
  return { facts: [near, pending], accepted, selections, skylight, environment };
}

function fixture() {
  const internals = {
    device: { caps: { rgba16floatRenderable: true } },
    deviceScope: { owner: 'test', generation: 0 },
    assets: {},
    gpuStore: { getCubemapIbl: () => undefined },
    captureReflectionFallbackReadback: false,
  } as unknown as RenderSystemInternals;
  return { owner: new ReflectionProbeRecordOwner(internals), internals };
}

function stageOn(
  owner: ReflectionProbeRecordOwner,
  state: ReturnType<typeof scene>,
  frame: number,
) {
  // biome-ignore lint/complexity/useLiteralKeys: Exercise the private staging seam the frame prepare path calls.
  return owner['stageFallbackProjections'](
    state.facts,
    state.selections,
    state.accepted as never,
    frame,
    state.skylight.value,
    state.environment.value,
  ).tickets as Tickets;
}

function completeOn(owner: ReflectionProbeRecordOwner, tickets: Tickets, frameId: number) {
  // biome-ignore lint/complexity/useLiteralKeys: Invoke the real asynchronous completion boundary.
  return owner['completeSubmission'](true, tickets as never, Promise.resolve(), {
    frameId,
    format: 'rgba16float',
    size: { width: 1, height: 1 },
    graphGeneration: 1,
    textureIdentity: frameId,
  }) as Promise<void>;
}

/** A fresh owner derives every row from scratch: the reference for one frame's evidence. */
function freshEvidence(state: ReturnType<typeof scene>, frame: number) {
  const tickets = stageOn(fixture().owner, state, frame);
  return new Map(
    [...tickets].map(([key, pending]) => [
      key,
      { projection: pending.projection, signature: pending.signature },
    ]),
  );
}

function expectFreshEvidence(tickets: Tickets, state: ReturnType<typeof scene>, frame: number) {
  const reference = freshEvidence(state, frame);
  expect([...tickets.keys()]).toEqual([...reference.keys()]);
  for (const [key, pending] of tickets) {
    expect(pending.projection).toEqual(reference.get(key)?.projection);
    expect(pending.signature).toBe(reference.get(key)?.signature);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fallback projection staging at steady state', () => {
  it('derives no projection, signature or source key for rows whose inputs did not change', () => {
    const state = scene();
    const { owner } = fixture();
    const derive = vi.spyOn(fallbackProjection, 'deriveReflectionFallbackProjection');
    const signature = vi.spyOn(fallbackProjection, 'reflectionFallbackProjectionSignature');
    const sourceKey = vi.spyOn(fallbackProjection, 'reflectionFallbackSourceKey');
    stageOn(owner, state, 1);
    expect(derive).toHaveBeenCalledTimes(20);
    expect(signature).toHaveBeenCalledTimes(20);
    expect(sourceKey).toHaveBeenCalledTimes(20);
    for (let frame = 2; frame <= 6; frame++) stageOn(owner, state, frame);
    expect(derive).toHaveBeenCalledTimes(20);
    expect(signature).toHaveBeenCalledTimes(20);
    expect(sourceKey).toHaveBeenCalledTimes(20);
  });

  it('re-derives exactly the rows whose inputs changed', () => {
    const state = scene();
    const { owner, internals } = fixture();
    stageOn(owner, state, 1);
    const derive = vi.spyOn(fallbackProjection, 'deriveReflectionFallbackProjection');
    let frame = 1;
    const derivedBy = (edit: () => void) => {
      derive.mockClear();
      edit();
      frame += 1;
      const tickets = stageOn(owner, state, frame);
      const derived = derive.mock.calls.length;
      expectFreshEvidence(tickets, state, frame);
      return derived;
    };
    expect(derivedBy(() => {})).toBe(0);
    expect(derivedBy(() => state.selections.set('r3', probeSelection(7, 0.9)))).toBe(1);
    // A replaced but value-identical selection keeps its evidence.
    expect(derivedBy(() => state.selections.set('r3', probeSelection(7, 0.9)))).toBe(0);
    const near = state.accepted.get('7') as FakeResource;
    expect(
      derivedBy(() => {
        near.filter = { activeGeneration: 2 };
      }),
    ).toBe(10);
    expect(
      derivedBy(() => {
        near.fact = { ...near.fact, intensity: 0.5 };
      }),
    ).toBe(10);
    expect(
      derivedBy(() => {
        near.fact = { ...near.fact, boxProjection: true };
      }),
    ).toBe(10);
    // Every row inside an accepted probe carries its extent, including Skylight recovery rows.
    const pending = state.accepted.get('8') as FakeResource;
    expect(
      derivedBy(() => {
        pending.fact = { ...pending.fact, halfExtents: [2, 4, 4] };
      }),
    ).toBe(5);
    expect(
      derivedBy(() => {
        pending.pmrem.active = {};
        pending.activeFact = pending.fact;
      }),
    ).toBe(5);
    // A moved probe whose active result was captured elsewhere stops being ready.
    expect(
      derivedBy(() => {
        near.fact = { ...near.fact, center: [1, 0, 0] };
      }),
    ).toBe(10);
    const sky = state.skylight.value as SkylightSnapshot;
    expect(
      derivedBy(() => {
        state.skylight.value = { ...sky, intensity: 2 };
      }),
    ).toBe(20);
    // The borrowed color array is shared with the current Skylight: an in-place edit is a change.
    expect(
      derivedBy(() => {
        (sky.color as unknown as number[])[0] = 0.5;
      }),
    ).toBe(20);
    expect(
      derivedBy(() => {
        state.skylight.value = sky;
      }),
    ).toBe(20);
    expect(
      derivedBy(() => {
        state.skylight.value = { ...sky, entityHandle: 4 };
      }),
    ).toBe(15);
    expect(
      derivedBy(() => {
        state.environment.value = { environmentSignature: 'env-b' } as never;
      }),
    ).toBe(15);
    expect(derivedBy(() => Object.assign(internals.deviceScope, { generation: 1 }))).toBe(0);
    expect(
      derivedBy(() => {
        state.skylight.value = undefined;
      }),
    ).toBe(20);
    expect(derivedBy(() => {})).toBe(0);
  });

  it('issues a fresh frame ticket per row while reusing unchanged evidence', () => {
    const state = scene();
    const { owner, internals } = fixture();
    const first = stageOn(owner, state, 1);
    const second = stageOn(owner, state, 2);
    let previousTicket = 0;
    for (const [key, pending] of second) {
      const earlier = first.get(key);
      expect(pending).not.toBe(earlier);
      expect(pending.frameId).toBe(2);
      expect(pending.deviceGeneration).toBe(0);
      expect(pending.ticket).toBe((earlier?.ticket ?? 0) + 20);
      expect(pending.ticket).toBeGreaterThan(previousTicket);
      previousTicket = pending.ticket;
      expect(pending.signature).toBe(earlier?.signature);
      expect(pending.projection).toEqual(earlier?.projection);
      expect(Object.isFrozen(pending.projection)).toBe(true);
    }
    Object.assign(internals.deviceScope, { generation: 1 });
    for (const pending of stageOn(owner, state, 3).values()) {
      expect(pending.deviceGeneration).toBe(1);
      expect(pending.frameId).toBe(3);
    }
  });

  it('keeps receipts, generations and stale-ticket rejection across a steady sequence', async () => {
    const state = scene();
    const { owner, internals } = fixture();
    const first = stageOn(owner, state, 1);
    await completeOn(owner, first, 1);
    const receipts = () =>
      new Map((owner.inspect().reflectionFallbacks ?? []).map((r) => [r.renderableKey ?? '', r]));
    expect(receipts().get('r0')).toMatchObject({
      state: 'active',
      frameId: 1,
      sourceGeneration: 1,
      projectionGeneration: 1,
    });
    const second = stageOn(owner, state, 2);
    stageOn(owner, state, 3);
    await completeOn(owner, second, 2);
    expect(receipts().get('r0')).toMatchObject({ frameId: 2, sourceGeneration: 1 });
    expect(receipts().size).toBe(20);
    // A changed row hides its receipt until its own completion.
    state.selections.set('r3', probeSelection(7, 0.9));
    const changed = stageOn(owner, state, 4);
    expect(receipts().has('r3')).toBe(false);
    await completeOn(owner, changed, 4);
    expect(receipts().get('r3')).toMatchObject({ frameId: 4, sourceGeneration: 2 });
    expect(receipts().get('r0')).toMatchObject({ frameId: 4, sourceGeneration: 1 });
    // Disappear and reappear: the old frame's ticket must stay stale.
    const before = stageOn(owner, state, 5);
    const r5 = state.selections.get('r5') as ReflectionProbeSelectionResult;
    state.selections.delete('r5');
    stageOn(owner, state, 6);
    expect(receipts().has('r5')).toBe(false);
    state.selections.set('r5', r5);
    const reappeared = stageOn(owner, state, 7);
    expectFreshEvidence(reappeared, state, 7);
    await completeOn(owner, before, 5);
    expect(receipts().has('r5')).toBe(false);
    expect(receipts().get('r0')).toMatchObject({ frameId: 5 });
    await completeOn(owner, reappeared, 7);
    expect(receipts().get('r5')).toMatchObject({ frameId: 7, sourceGeneration: 1 });
    // A ticket from the previous device generation never commits.
    const oldDevice = stageOn(owner, state, 8);
    Object.assign(internals.deviceScope, { generation: 1 });
    await completeOn(owner, oldDevice, 8);
    expect(receipts().get('r0')).toMatchObject({ frameId: 7 });
    const newDevice = stageOn(owner, state, 9);
    await completeOn(owner, newDevice, 9);
    expect(receipts().get('r0')).toMatchObject({
      frameId: 9,
      deviceGeneration: 1,
      sourceGeneration: 1,
    });
  });

  it('records an invalid row failure on every frame that stages it', async () => {
    const state = scene();
    const { owner } = fixture();
    state.selections.set('r3', probeSelection(7, Number.NaN));
    const first = stageOn(owner, state, 1);
    expect(first.has('r3')).toBe(false);
    expect(owner.inspect().reflectionFallbackInspection.failureCode).toBe(
      'reflection-fallback-input-invalid',
    );
    await completeOn(owner, first, 1);
    expect(owner.inspect().reflectionFallbackInspection.failureCode).toBeUndefined();
    const second = stageOn(owner, state, 2);
    expect(second.has('r3')).toBe(false);
    expect(owner.inspect().reflectionFallbackInspection.failureCode).toBe(
      'reflection-fallback-input-invalid',
    );
    state.selections.set('r3', probeSelection(7, 0.5));
    expectFreshEvidence(stageOn(owner, state, 3), state, 3);
  });
});
