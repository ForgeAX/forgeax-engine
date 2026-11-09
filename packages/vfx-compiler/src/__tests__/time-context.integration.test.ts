import { describe, expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';

const source = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'smoke',
      capacity: 16,
      backend: { required: 'gpu' as const },
      space: 'world',
      schedule: { rate: 0, bursts: [{ time: 0, count: 16 }] },
      bounds: { kind: 'aabb', min: [-4, -4, -4], max: [4, 4, 4] },
      program: { module: 'smoke.vfx.wgsl' },
      renderers: [{ kind: 'billboard', material: 'material-guid' }],
    },
  ],
};

const entry = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_forever, vfx_loop_phase}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).lifetime = vfx_forever();
  (*particle).position.x = ctx.world_time;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let phase = vfx_loop_phase(ctx.time_whole, ctx.time_fract, 0.065, f32(ctx.particleId) * 0.1);
  (*particle).position.y = phase + ctx.time + ctx.world_time_fract + f32(ctx.world_time_whole);
}`;

describe('VFX time contexts', () => {
  it('cooks hooks that read player and world time through both contexts', async () => {
    const result = await cookParticleCodeProgram(source, { 'smoke.vfx.wgsl': { entry } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wgsl = result.value.program.emitters.at(0)?.wgsl ?? '';
    expect(wgsl).toContain('timeWhole: u32');
    expect(wgsl).toContain('worldTimeFract: f32');
  });
});

describe('effect-declared parameters', () => {
  const withParams = {
    ...source,
    parameters: {
      origin: { type: 'vec3<f32>', default: [1, 2, 3] },
      worldScale: { type: 'f32', default: 9.5 },
    },
  };
  const paramEntry = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let p = vfx_parameters();
  (*particle).position = p.origin;
  (*particle).sprite_size = vec2<f32>(p.worldScale);
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`;

  it('synthesizes VfxParameters and reflects names, types and defaults', async () => {
    const result = await cookParticleCodeProgram(withParams, {
      'smoke.vfx.wgsl': { entry: paramEntry },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fields = result.value.program.emitters.at(0)?.reflection.layout.parameters.fields ?? [];
    expect(fields.map((f) => [f.name, f.type, f.defaultValue])).toEqual([
      ['origin', 'vec3<f32>', [1, 2, 3]],
      ['worldScale', 'f32', 9.5],
    ]);
  });

  it('rejects a hand-written struct VfxParameters beside the parameters table', async () => {
    const result = await cookParticleCodeProgram(withParams, {
      'smoke.vfx.wgsl': { entry: `${paramEntry}\nstruct VfxParameters { a: f32, }` },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('vfx-reserved-surface-conflict');
  });

  it('rejects a bad parameter declaration at the source boundary', async () => {
    const bad = { ...source, parameters: { x: { type: 'mat4x4<f32>' } } };
    const result = await cookParticleCodeProgram(bad, { 'smoke.vfx.wgsl': { entry } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail).toMatchObject({ path: 'parameters.x.type' });
  });
});
