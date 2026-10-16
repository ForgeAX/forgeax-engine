import { describe, expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';

const source = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'bolt',
      capacity: 64,
      backend: { required: 'gpu' as const },
      space: 'world' as const,
      bounds: { kind: 'sphere' as const, center: [0, 0, 0], radius: 4 },
      schedule: { rate: 1 },
      program: { module: 'bolt.vfx.wgsl' },
      renderers: [{ kind: 'billboard' as const, material: 'material-guid' }],
    },
  ],
};

const module = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}
// #vfx stage bad entry=vfx_bad domain=particle resources=privateBuffer:read dependsOn=update iterationBudget=1
fn vfx_bad(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`;

describe('managed stage artifact validation', () => {
  it('rejects invalid stages without a candidate artifact', async () => {
    const result = await cookParticleCodeProgram(source, { 'bolt.vfx.wgsl': { entry: module } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-stage-resource-unknown');
      expect(result.error.detail).toMatchObject({ stageId: 'bad', resource: 'privateBuffer' });
    }
  });
});
