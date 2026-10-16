import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cookParticleCodeEffect,
  type ParticleCodeModuleSet,
} from '@forgeax/engine-vfx-compiler';
import type { MaterialParticleInput } from '@forgeax/engine-types';
import { CINDER_FALL_SOURCE } from '../cast.js';

function module(name: string): ParticleCodeModuleSet {
  return { entry: readFileSync(new URL(`../../assets/${name}.vfx.wgsl`, import.meta.url), 'utf8') };
}

const materials: Readonly<Record<string, readonly MaterialParticleInput[]>> = {
  'c1de0000-0000-7000-8000-000000000002': [
    { name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 },
  ],
};

describe('Cinder Fall Program v3 consumer', () => {
  it('cooks the three emitters through the shared compiler', async () => {
    const cooked = await cookParticleCodeEffect(CINDER_FALL_SOURCE, {
      'cinder-travel': module('cinder-travel'),
      'cinder-impact': module('cinder-impact'),
      'cinder-burn': module('cinder-burn'),
    }, materials);
    expect(cooked.ok).toBe(true);
    if (!cooked.ok) return;
    expect(cooked.value.asset.schemaVersion).toBe(3);
    expect(cooked.value.artifact.program.emitters).toHaveLength(3);
    expect(cooked.value.artifact.program.emitters[0]?.reflection.layout.core?.stride).toBe(112);
    expect(cooked.value.artifact.program.emitters[0]?.reflection.resources).not.toContain('channel');
    const meshProgram = cooked.value.artifact.program.emitters.find((emitter) =>
      emitter.reflection.renderers.some((renderer) => renderer.topology === 'mesh'),
    );
    expect(meshProgram?.wgsl).toContain(
      'forgeax_vfx_quaternion_rotate',
    );
    expect(meshProgram?.wgsl).toContain('mesh_scale');
    expect(cooked.value.artifact.program.emitters[0]?.reflection.eventChannels).toHaveLength(1);
  });
});
