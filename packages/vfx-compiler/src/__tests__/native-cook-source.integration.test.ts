import { expect, it } from 'vitest';
import { cookParticleCodeEffect, createParticleCodeNativeCooker } from '../code-program';

const effect = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'inline',
      capacity: 1,
      backend: { required: 'gpu' },
      space: 'local',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
      schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
      program: { module: 'inline.vfx.wgsl' },
      renderers: [{ kind: 'billboard', material: 'material-guid' }],
    },
  ],
};
const modules = {
  'inline.vfx.wgsl': {
    entry: `
#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).lifetime=1.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){}
`,
  },
};

it('cooks serialized inline author sources through the ordinary native adapter', async () => {
  const direct = (await cookParticleCodeEffect(effect, modules)).unwrap();
  const native = await createParticleCodeNativeCooker({}).cook({
    guid: 'effect-guid',
    source: JSON.parse(JSON.stringify({ effect, modules })),
  });
  expect(native.payload).toEqual(direct.asset);
  expect(native.refs).toEqual(direct.refs);
  expect(native.artifacts[direct.artifact.artifactKey]?.bytes).toEqual(direct.artifact.bytes);
  expect(native.inputFingerprint).toBe(direct.artifact.fingerprint);
});

it('rejects an explicit malformed source instead of using ambient modules', async () => {
  await expect(
    createParticleCodeNativeCooker(modules).cook({
      guid: 'effect-guid',
      source: { effect, modules: { 'inline.vfx.wgsl': { entry: false } } },
    }),
  ).rejects.toThrow();
  await expect(
    createParticleCodeNativeCooker(modules).cook({
      guid: 'effect-guid',
      source: { effect, modules, unexpected: true },
    }),
  ).rejects.toThrow();
});
