import { expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program';

const source = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'collision',
      capacity: 100,
      backend: { required: 'gpu' },
      space: 'world',
      schedule: { rate: 0, bursts: [{ time: 0, count: 100 }] },
      bounds: { kind: 'aabb', min: [-8, -8, -8], max: [8, 8, 8] },
      program: { module: 'collision.vfx.wgsl' },
      renderers: [{ kind: 'billboard', material: 'test-material' }],
    },
  ],
};
const entry = `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_integrate}
#import forgeax_vfx::data::scene_sdf
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>) {
 (*p).position=vec3f(0,2,0);(*p).velocity=vec3f(0,-20,0);
 (*p).lifetime=10.0;(*p).sprite_size=vec2f(0.1);
}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>) {
 let contact=vfx_sdf_collide((*p).position,(*p).velocity,ctx.delta,0.05,0.8,0.1);
 (*p).position=contact.position;(*p).velocity=contact.velocity;
}
`;
it('cooks the managed SDF ABI and swept response through the ordinary schema-v3 program', async () => {
  const cooked = await cookParticleCodeProgram(source, { 'collision.vfx.wgsl': { entry } });
  expect(cooked.ok, cooked.ok ? '' : JSON.stringify(cooked.error)).toBe(true);
  if (!cooked.ok) return;
  const emitter = cooked.value.program.emitters[0];
  if (!emitter) throw new Error('missing cooked emitter');
  expect(emitter.reflection.dataInterfaces).toEqual([
    {
      token: 'vfx:scene-sdf',
      kind: 'scene-sdf',
      binding: 15,
      bindingType: 'read-only-storage',
      lifetime: 'generation',
    },
  ]);
  expect(emitter.reflection.bindings[0]?.entries).toContainEqual(
    expect.objectContaining({
      binding: 15,
      buffer: expect.objectContaining({ type: 'read-only-storage' }),
    }),
  );
  expect(emitter.wgsl).toContain('fn vfx_sdf_collide');
});
it('keeps SDF and authored force-field resources on their separate ABI bindings', async () => {
  const input = {
    ...source,
    emitters: source.emitters.map((emitter) => ({
      ...emitter,
      forceFields: [
        {
          kind: 'vector' as const,
          texture: '01a11250-0000-7000-8000-000000000001',
          sampling: 'trilinear' as const,
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          strength: 1,
          attenuation: 0,
        },
      ],
    })),
  };
  const both = entry
    .replace(
      '#import forgeax_vfx::data::scene_sdf',
      '#import forgeax_vfx::data::scene_sdf\n#import forgeax_vfx::data::force_fields',
    )
    .replace('let contact=', 'vfx_apply_force_fields(ctx,p);\n let contact=');
  const cooked = await cookParticleCodeProgram(input, { 'collision.vfx.wgsl': { entry: both } });
  expect(cooked.ok, cooked.ok ? '' : JSON.stringify(cooked.error)).toBe(true);
  if (!cooked.ok) return;
  const emitter = cooked.value.program.emitters[0];
  if (!emitter) throw new Error('missing cooked emitter');
  expect(emitter.reflection.dataInterfaces).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ token: 'vfx:scene-sdf', binding: 15 }),
      expect.objectContaining({ token: 'vfx:force-fields', binding: 17 }),
    ]),
  );
  expect(emitter.reflection.bindings[0]?.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        binding: 15,
        buffer: expect.objectContaining({ type: 'read-only-storage' }),
      }),
      expect.objectContaining({
        binding: 17,
        buffer: expect.objectContaining({ type: 'read-only-storage' }),
      }),
    ]),
  );
  expect(emitter.wgsl).toMatch(
    /@group\(0\)\s*@binding\(15\)\s*var<storage(?:,\s*read)?>\s+[A-Za-z0-9_]+\s*:/,
  );
  expect(emitter.wgsl).toMatch(
    /@group\(0\)\s*@binding\(17\)\s*var<storage(?:,\s*read)?>\s+[A-Za-z0-9_]+\s*:/,
  );
});
it('keeps SDF code and bindings absent without the import', async () => {
  const cooked = await cookParticleCodeProgram(source, {
    'collision.vfx.wgsl': {
      entry: entry
        .replace('#import forgeax_vfx::data::scene_sdf', '')
        .replace(
          /let contact=[^;]*;[\s\S]*?\(\*p\)\.velocity=contact.velocity;/,
          'vfx_integrate(ctx,p);',
        ),
    },
  });
  expect(cooked.ok, cooked.ok ? '' : JSON.stringify(cooked.error)).toBe(true);
  if (!cooked.ok) return;
  expect(cooked.value.program.emitters[0]?.wgsl).not.toContain('forgeax_vfx_scene_sdf');
});
