import { describe, expect, it } from 'vitest';
import { selectEnvironment } from '../environment/frame';
import type { EnvironmentCandidate, EnvironmentFrame, FogCandidate } from '../extract/environment';
import { earthAtmosphere } from './atmosphere-fixture';

const atmosphereParameters = earthAtmosphere;

const sun = { entityKey: 99, direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 } as const;

function select(environments: readonly EnvironmentCandidate[], fogs: readonly FogCandidate[]) {
  return selectEnvironment({ environments, fogs, suns: [sun], lane: 'direct' });
}

function unwrapFrame(result: ReturnType<typeof select>): EnvironmentFrame {
  if (!result.ok) throw result.error;
  return result.value;
}

const image = (entityKey: number, sourceKey: string): EnvironmentCandidate => ({
  kind: 'image',
  entityKey,
  sourceKey,
});
const atmosphere = (entityKey: number, sourceKey: string): EnvironmentCandidate => ({
  kind: 'atmosphere',
  entityKey,
  sourceKey,
  atmosphere: atmosphereParameters,
});
const fog = (entityKey: number): FogCandidate => ({
  entityKey,
  color: [0.4, 0.5, 0.6],
  density: 0.01,
  heightFalloff: 0.2,
  maxOpacity: 0.9,
});

describe('immutable frame plan contract', () => {
  it('selects none, one image, or one atmosphere deterministically', () => {
    expect(unwrapFrame(select([], [])).source.kind).toBe('none');
    expect(unwrapFrame(select([image(2, 'image-a')], [])).source).toEqual({
      kind: 'image',
      sourceKey: 'image-a',
      entityKey: 2,
    });
    expect(unwrapFrame(select([atmosphere(7, 'sky-a')], [])).source).toEqual({
      kind: 'atmosphere',
      sourceKey: 'sky-a',
      entityKey: 7,
      atmosphere: atmosphereParameters,
    });
  });

  it('rejects mixed source kinds and conflicting source keys', () => {
    expect(select([image(1, 'a'), atmosphere(2, 'b')], [])).toMatchObject({
      ok: false,
      error: { code: 'environment-source-conflict' },
    });
    expect(select([image(1, 'a'), image(2, 'b')], [])).toMatchObject({
      ok: false,
      error: { code: 'environment-source-conflict' },
    });
  });

  it('keeps Fog independent from environment source and bounds cardinality', () => {
    const withoutFog = unwrapFrame(select([], []));
    expect(withoutFog.fog).toBeUndefined();
    const withFog = unwrapFrame(select([], [fog(4)]));
    expect(withFog.fog?.entityKey).toBe(4);
    expect(select([], [fog(4), fog(8)])).toMatchObject({
      ok: false,
      error: { code: 'fog-cardinality' },
    });
  });

  it('returns detached facts without GPU handles and freezes nested values', () => {
    const result = select([image(1, 'stable')], [fog(3)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.source)).toBe(true);
    expect('device' in result.value).toBe(false);
    expect('texture' in result.value).toBe(false);
    expect('buffer' in result.value).toBe(false);
  });
});

describe('auto exposure resize contract', () => {
  it('retains accepted EV while changing the target generation', async () => {
    const { commitAutoExposureCandidate, createAutoExposureState, resetAutoExposureState } =
      await import('../pipeline/standard-output/auto-exposure/state');
    const initial = createAutoExposureState({ fallback: 1, targetGeneration: 1, deviceEpoch: 1 });
    if (!initial.ok) throw initial.error;
    const accepted = commitAutoExposureCandidate(initial.value, {
      ev: 1.5,
      generation: 1,
      deviceEpoch: 1,
      frameId: 3,
    });
    const resized = resetAutoExposureState(accepted, 'camera-change', {
      targetGeneration: 2,
      deviceEpoch: 1,
    });

    expect(resized.acceptedEv).toBe(1.5);
    expect(resized.lastKnownGood).toBe(1.5);
    expect(resized.targetGeneration).toBe(2);
    expect(resized.receipt.committed).toBe(false);
  });
});
