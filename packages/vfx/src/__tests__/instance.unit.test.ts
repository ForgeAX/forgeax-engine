import { describe, expect, it } from 'vitest';
import { createVfxEffectContract } from '../effect-contract.js';
import { ParticleEffectInstance, type VfxInstanceParent } from '../instance.js';
import { VFX_PARTICLE_CORE_LAYOUT } from '../particle-layout.js';

type Values = {
  readonly direction: readonly [number, number, number];
  readonly speed: number;
};

const reflection = {
  version: 3,
  parameters: {
    name: 'VfxParameters',
    fields: [
      { name: 'direction', type: 'vec3<f32>', offset: 0, size: 12, alignment: 16 },
      { name: 'speed', type: 'f32', offset: 16, size: 4, alignment: 4 },
    ],
    size: 32,
    alignment: 16,
  },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  core: VFX_PARTICLE_CORE_LAYOUT,
  customLayout: { name: 'VfxCustom', fields: [], size: 0, alignment: 1, stride: 0, lanes: 0 },
  fingerprint: 'sha256:instance-test',
} as const;

function createInstance(initialValues: Partial<Values> = {}) {
  const contract = createVfxEffectContract<Values>(reflection);
  const parent: VfxInstanceParent<Values> = {
    fingerprint: reflection.fingerprint,
    defaults: { direction: [1, 0, 0], speed: 2 },
  };
  return new ParticleEffectInstance(contract, { parent, initialValues });
}

describe('ParticleEffectInstance atomic semantics', () => {
  it('keeps channel input in the same commit as the parameter generation', () => {
    const instance = createInstance();
    const submitted = (
      instance as unknown as {
        submit(input: {
          channel: string;
          payload: { position: readonly [number, number, number]; strength: number };
          sequence: number;
        }): { ok: boolean };
      }
    ).submit({ channel: 'impact', payload: { position: [0, 1, 0], strength: 1 }, sequence: 1 });

    expect(submitted.ok).toBe(true);
    const committed = instance.commit({ seed: 17, tick: 4 });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.generation).toBe(0);
    expect(committed.value.channelInputs).toHaveLength(1);
  });

  it('merges parent defaults before initial values without copying parent runtime state', () => {
    const instance = createInstance({ speed: 3 });

    expect(instance.values).toEqual({ direction: [1, 0, 0], speed: 3 });
    expect(instance.generation).toBe(0);
  });

  it('coalesces same-tick patches into one generation and one canonical payload', () => {
    const instance = createInstance();

    expect(instance.patch({ speed: 4 }).ok).toBe(true);
    expect(instance.patch({ direction: [0, 1, 0] }).ok).toBe(true);
    expect(instance.generation).toBe(0);

    const committed = instance.commit({ seed: 17, tick: 4 });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.generation).toBe(1);
    expect(committed.value.values).toEqual({ direction: [0, 1, 0], speed: 4 });
    expect(committed.value.replayInput).toMatchObject({
      seed: 17,
      tick: 4,
      generation: 1,
    });
    expect(committed.value.replayInput.payload).toEqual(committed.value.canonicalPayload);
  });

  it('rejects a bad patch without changing the last valid generation or values', () => {
    const instance = createInstance();
    const invalid = JSON.parse('{"direction":[0, 1]}');

    const result = instance.patch(invalid);

    expect(result.ok).toBe(false);
    expect(instance.generation).toBe(0);
    expect(instance.values).toEqual({ direction: [1, 0, 0], speed: 2 });
    expect(instance.pendingPatchCount).toBe(0);
  });

  it('replays the same seed, tick, generation, and canonical input bytes', () => {
    const first = createInstance({ speed: 5 });
    const committed = first.commit({ seed: 9, tick: 12 });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const replay = createInstance({ speed: 5 }).replay(committed.value.replayInput);

    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayInput).toEqual(committed.value.replayInput);
    expect([...replay.value.canonicalPayload]).toEqual([...committed.value.canonicalPayload]);
  });
});
