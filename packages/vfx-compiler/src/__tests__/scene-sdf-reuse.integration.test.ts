import * as naga from '@forgeax/engine-naga';
import { afterEach, expect, it, vi } from 'vitest';
import { cookParticleCodeEffect } from '../code-program.js';

const entry = `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
#import forgeax_vfx::data::scene_sdf
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>) {
 (*p).position=vec3f(0,2,0);(*p).velocity=vec3f(0,-20,0);
 (*p).lifetime=10.0;(*p).sprite_size=vec2f(0.1);
}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>) {
 let contact=vfx_sdf_collide((*p).position,(*p).velocity,ctx.delta,0.05,0.8,0.1);
 (*p).position=contact.position;(*p).velocity=contact.velocity;
}`;
const emitter = {
  id: 'sdf-reuse-a',
  capacity: 100,
  backend: { required: 'gpu' },
  space: 'world',
  schedule: { rate: 0, bursts: [{ time: 0, count: 100 }] },
  bounds: { kind: 'aabb', min: [-8, -8, -8], max: [8, 8, 8] },
  program: { module: 'collision.vfx.wgsl' },
  renderers: [{ kind: 'billboard', material: 'material-first' }],
};
afterEach(() => vi.restoreAllMocks());
it('shares real SDF composition across distinct emitter identities while keeping fresh metadata and rejection', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const first = await cookParticleCodeEffect(
    { schemaVersion: 3, emitters: [emitter] },
    { 'collision.vfx.wgsl': { entry } },
  );
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(compose).toHaveBeenCalledTimes(1);
  const secondEmitter = {
    ...emitter,
    id: 'sdf-reuse-b',
    capacity: 200,
    renderers: [{ kind: 'billboard', material: 'material-second' }],
  };
  const second = await cookParticleCodeEffect(
    { schemaVersion: 3, emitters: [emitter, secondEmitter] },
    { 'collision.vfx.wgsl': { entry } },
  );
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(compose).toHaveBeenCalledTimes(1);
  expect(second.value.asset.program.emitters.map((e) => [e.id, e.capacity])).toEqual([
    ['sdf-reuse-a', 100],
    ['sdf-reuse-b', 200],
  ]);
  expect(second.value.refs).toEqual(['material-first', 'material-second']);
  expect(first.value.refs).toEqual(['material-first']);
  expect(second.value.artifact.fingerprint).not.toBe(first.value.artifact.fingerprint);
  for (const cooked of second.value.asset.program.emitters) {
    expect(cooked.wgsl).toBe(first.value.asset.program.emitters[0]?.wgsl);
    expect(cooked.reflection).toHaveProperty('dataInterfaces', [
      {
        token: 'vfx:scene-sdf',
        kind: 'scene-sdf',
        binding: 15,
        bindingType: 'read-only-storage',
        lifetime: 'generation',
      },
    ]);
  }
  const invalid = {
    'collision.vfx.wgsl': { entry: `${entry}\nfn invalid() { missing_sdf_function(); }` },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = await cookParticleCodeEffect(
      { schemaVersion: 3, emitters: [emitter] },
      invalid,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('vfx-shader-invalid');
  }
  expect(compose).toHaveBeenCalledTimes(3);
  const recovered = await cookParticleCodeEffect(
    { schemaVersion: 3, emitters: [emitter] },
    { 'collision.vfx.wgsl': { entry } },
  );
  expect(recovered.ok).toBe(true);
  if (recovered.ok) expect(recovered.value.artifact.bytes).toEqual(first.value.artifact.bytes);
  expect(compose).toHaveBeenCalledTimes(3);
}, 30_000);
