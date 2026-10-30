import { Hash } from 'node:crypto';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it, vi } from 'vitest';
import { particleEffectContribution } from '../gpu-loader';
import { prepareRuntimeParticleEffect } from '../runtime-prepare';

const cooked = await cookParticleCodeProgram(
  {
    schemaVersion: 3,
    emitters: [
      {
        id: 'sparks',
        capacity: 8,
        backend: { required: 'gpu' },
        space: 'world',
        schedule: { rate: 5 },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 5 },
        program: { module: 'sparks' },
        renderers: [{ kind: 'billboard', material: 'material' }],
      },
    ],
  },
  {
    sparks: {
      entry: `
#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, p: ptr<function,VfxParticle>) { (*p).lifetime = 2.0; }
fn vfx_update(ctx: VfxUpdateContext, p: ptr<function,VfxParticle>) { (*p).age += ctx.delta; }
`,
    },
  },
);

it('atomically validates code-created and edited programs and derives identities without caller versions', () => {
  const result = cooked.unwrap();
  const assets = new AssetRegistry();
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const material = assets
    .create({
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::unlit' } }],
    })
    .unwrap();
  const source = {
    kind: 'particle-effect' as const,
    schemaVersion: 3 as const,
    program: {
      ...result.program,
      emitters: result.program.emitters.map((emitter) => ({
        ...emitter,
        renderers: emitter.renderers.map((renderer) => ({ ...renderer, material })),
      })),
    },
  };
  const handle = assets.create(source).unwrap();
  const before = assets.read(handle).unwrap();
  const version = runtimeAssets(assets).version(handle).unwrap();
  expect(before.programFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(before.emitters).toEqual([{ id: 'sparks', capacity: 8 }]);
  const first = before.program.emitters[0];
  if (first === undefined) throw new Error('missing emitter');
  for (const patch of [
    { schedule: { rate: NaN } },
    { bounds: { kind: 'sphere', center: [0, 0, 0], radius: -1 } },
    { wgsl: 'broken' },
    { reflection: { ...first.reflection, layout: {} } },
    { reflection: { ...first.reflection, bindings: [] } },
  ]) {
    expect(
      assets.update(handle, { program: { ...before.program, emitters: [{ ...first, ...patch }] } }),
    ).toMatchObject({ ok: false, error: { code: 'asset-invalid-value' } });
    expect(runtimeAssets(assets).version(handle).unwrap()).toBe(version);
  }
  const hash = vi.spyOn(Hash.prototype, 'update');
  assets
    .update(handle, {
      program: { ...before.program, emitters: [{ ...first, schedule: { rate: 10 } }] },
    })
    .unwrap();
  const next = assets.read(handle).unwrap();
  expect(next.programFingerprint).not.toBe(before.programFingerprint);
  expect(next.program.fingerprint).toBe(next.programFingerprint);
  expect(hash.mock.calls.every(([text]) => text !== first.wgsl)).toBe(true);
  hash.mockRestore();
  expect(prepareRuntimeParticleEffect(next).unwrap().programFingerprint).toBe(
    next.programFingerprint,
  );
  assets.dispose();
});
