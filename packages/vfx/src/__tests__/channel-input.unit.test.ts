import { describe, expect, it } from 'vitest';
import { createVfxEffectContract } from '../effect-contract.js';
import { ParticleEffectInstance, type VfxChannelInput } from '../instance.js';
import { VFX_PARTICLE_CORE_LAYOUT } from '../particle-layout.js';

const reflection = {
  version: 3,
  parameters: { name: 'VfxParameters', fields: [], size: 0, alignment: 1 },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  core: VFX_PARTICLE_CORE_LAYOUT,
  customLayout: { name: 'VfxCustom', fields: [], size: 0, alignment: 1, stride: 0, lanes: 0 },
  fingerprint: 'sha256:channel-input',
} as const;

function instance() {
  return new ParticleEffectInstance(createVfxEffectContract(reflection));
}

function input(sequence: number, strength: number): VfxChannelInput {
  return {
    channel: 'impact',
    payload: { position: [sequence, 1, 0], strength },
    sequence,
  };
}

describe('VFX channel input', () => {
  it('commits typed inputs once at the fixed-tick boundary in sequence order', () => {
    const effect = instance();

    expect(effect.submit(input(2, 0.4)).ok).toBe(true);
    expect(effect.submit(input(1, 0.9)).ok).toBe(true);
    const committed = effect.commit({ seed: 3, tick: 8 });

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.channelInputs).toEqual([input(1, 0.9), input(2, 0.4)]);
    expect(committed.value.channelInputs[0]?.tick).toBe(8);
  });

  it('drops new input at capacity without changing another instance', () => {
    const first = instance();
    const second = instance();
    first.setChannelCapacity('impact', 1);

    expect(first.submit(input(1, 0.5)).ok).toBe(true);
    const overflow = first.submit(input(2, 0.6));
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe('vfx-channel-overflow');
    expect(second.submit(input(1, 0.7)).ok).toBe(true);
    const firstCommit = first.commit({ seed: 1, tick: 1 });
    const secondCommit = second.commit({ seed: 2, tick: 1 });
    expect(firstCommit.ok && firstCommit.value).toMatchObject({ droppedCount: 1 });
    expect(secondCommit.ok && secondCommit.value).toMatchObject({ droppedCount: 0 });
  });

  it('clears pending inputs on despawn/reset and preserves replay ordering', () => {
    const effect = instance();
    effect.submit(input(4, 1));
    const committed = effect.commit({ seed: 4, tick: 3 });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const replay = instance().replay(committed.value.replayInput);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.channelInputs).toEqual(committed.value.channelInputs);
  });
});
