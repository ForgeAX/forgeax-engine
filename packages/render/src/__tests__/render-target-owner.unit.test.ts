import { describe, expect, it } from 'vitest';
import type { RenderTargetDescriptor } from '../targets/contracts';
import {
  createRenderTargetOwner,
  type RenderTargetOwner,
  type RenderTargetOwnerInspection,
} from '../targets/owner';

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 128,
  height: 64,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: true,
};

function makeOwner(): RenderTargetOwner {
  return createRenderTargetOwner({ rendererId: Symbol('renderer'), getGeneration: () => 7 });
}

function inspect(owner: RenderTargetOwner, target: Parameters<RenderTargetOwner['inspect']>[0]) {
  const result = owner.inspect(target);
  if (!result.ok) throw result.error;
  return result.value;
}

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

describe('RenderTarget logical owner', () => {
  it('keeps the logical token stable while promotion is receipt-gated', () => {
    const owner = makeOwner();
    const created = owner.create(descriptor);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const target = created.value;
    expect(inspect(owner, target)).toMatchObject({ state: 'uninitialized', generation: 7 });

    const candidate = owner.stage(target);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(inspect(owner, target)).toMatchObject({
      state: 'candidate',
      generation: 7,
      candidate: candidate.value,
    });

    expect(owner.promote(target, candidate.value.generation).ok).toBe(true);
    expect(inspect(owner, target)).toMatchObject({ state: 'active', generation: 7 });
    const promoted = owner.inspect(target);
    expect(promoted.ok).toBe(true);
    if (promoted.ok) expect(promoted.value.token).toBe(target);
  });

  it('retains active descriptor and LKG when a candidate fails at any stage', () => {
    const owner = makeOwner();
    const target = value(owner.create(descriptor));
    value(owner.stage(target));
    value(owner.promote(target, 7));

    const resized = { ...descriptor, width: 256, height: 128 };
    const candidate = value(owner.stage(target, resized));
    const failed = owner.rejectCandidate(target, candidate.generation, 'submit');
    expect(failed.ok).toBe(false);
    expect(inspect(owner, target)).toMatchObject({
      state: 'active',
      generation: 7,
      descriptor,
    });
    expect(inspect(owner, target).candidate).toBeUndefined();
  });

  it('separates logical token identity from physical generation during recovery', () => {
    const owner = makeOwner();
    const target = value(owner.create(descriptor));
    value(owner.stage(target));
    value(owner.promote(target, 7));

    const recovered = owner.beginRecovery(target, 8);
    expect(recovered.ok).toBe(true);
    expect(inspect(owner, target)).toMatchObject({ state: 'rebuilding', generation: 8 });
    expect(owner.finishRecovery(target).ok).toBe(true);
    expect(inspect(owner, target)).toMatchObject({ state: 'uninitialized', generation: 8 });
    expect(inspect(owner, target).token).toBe(target);
  });

  it('retires only the old generation, keeps destroy idempotent, and rejects foreign tokens', () => {
    const owner = makeOwner();
    const other = makeOwner();
    const target = value(owner.create(descriptor));
    value(owner.stage(target));
    value(owner.promote(target, 7));

    expect(owner.retire(target, 7).ok).toBe(true);
    expect(owner.destroy(target).ok).toBe(true);
    expect(owner.destroy(target).ok).toBe(true);
    expect(owner.inspect(target).ok).toBe(false);

    const foreign = value(other.create(descriptor));
    const foreignResult = owner.inspect(foreign);
    expect(foreignResult.ok).toBe(false);
    if (!foreignResult.ok) expect(foreignResult.error.code).toBe('render-target-state-invalid');
  });

  it('exposes only bounded inspection facts for the owner state', () => {
    const owner = makeOwner();
    const target = value(owner.create(descriptor));
    const snapshot = inspect(owner, target);
    const publicFacts: RenderTargetOwnerInspection = snapshot;
    expect(Object.keys(publicFacts).sort()).toEqual(['descriptor', 'generation', 'state', 'token']);
  });
});
