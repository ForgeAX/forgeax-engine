import { beforeAll, describe, expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';
import { PARTICLE_EVENT_MANAGED_RUNTIME } from '../managed-program.js';

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
      channels: [{ id: 'impact', capacity: 2, overflow: 'drop-newest' }],
      events: [
        { id: 'impact-event', channel: 'impact', subEmitter: 'bolt', fanOut: 2, recursionDepth: 1 },
      ],
    },
  ],
};
const module = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`;

describe('managed GPU event artifact', () => {
  let result: Awaited<ReturnType<typeof cookParticleCodeProgram>>;

  beforeAll(async () => {
    result = await cookParticleCodeProgram(source, { 'bolt.vfx.wgsl': { entry: module } });
  });

  it('cooks the managed event artifact', () => {
    expect(result.ok).toBe(true);
  });

  it('includes event resources and limits in the cooked reflection', () => {
    if (!result.ok) return;
    const emitter = result.value.program.emitters[0];
    expect(emitter?.reflection).toMatchObject({
      resources: expect.arrayContaining(['eventBuffer']),
      eventChannels: [{ id: 'impact', capacity: 2, overflow: 'drop-newest' }],
      events: [{ id: 'impact-event', channel: 'impact', fanOut: 2, recursionDepth: 1 }],
    });
  });

  it('emits a stable cooked fingerprint', () => {
    if (!result.ok) return;
    expect(result.value.fingerprint).toBeTruthy();
  });

  it('keeps generic event-child mesh transforms bounded', () => {
    expect(PARTICLE_EVENT_MANAGED_RUNTIME).toContain(
      'vec3<f32>(0.06 + clamp(input.strength, 0.0, 1.0) * 0.04)',
    );
    expect(PARTICLE_EVENT_MANAGED_RUNTIME).not.toContain(
      'vec3<f32>(1.0),\n      0.0,\n      input.sequence',
    );
  });
});
