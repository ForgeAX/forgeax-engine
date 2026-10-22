import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { definePack, PackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import {
  cookParticleCodeEffect,
  createParticleCodeNativeCooker,
} from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { buildScriptablePack } from '../scriptable-pack-build-core';
import { createStandardAssetOutputProducerRegistry } from '../standard-output-producers';

const source = {
  effect: {
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
        renderers: [{ kind: 'billboard', material: '019ffa97-3000-7000-8000-000000000001' }],
      },
    ],
  },
  modules: {
    'inline.vfx.wgsl': {
      entry: `
#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).lifetime=1.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){}
`,
    },
  },
};
const parsedPackageId = PackageId.parse('019ffa97-3000-7000-8000-000000000010');
if (!parsedPackageId.ok) throw parsedPackageId.error;
const packageId = parsedPackageId.value;

it('publishes generated particle sources through the standard producer and complete Pack boundary', async () => {
  const outputs = createStandardAssetOutputProducerRegistry();
  const cookers = new NativeCookerRegistry();
  cookers.register(createParticleCodeNativeCooker({}));
  const definition = definePack({
    schemaVersion: '2.0.0',
    packageId,
    build: () => ok({ 'effect/inline': { kind: 'particle-effect' as const, source } }),
  });
  const built = (
    await buildScriptablePack({
      definition,
      sourcePath: 'inline.pack.ts',
      outputs,
      cookers,
      deferReferenceValidation: true,
    })
  ).unwrap();
  const asset = built.product.assets[0];
  if (asset === undefined) throw new Error('Missing particle output');
  const direct = (await cookParticleCodeEffect(source.effect, source.modules)).unwrap();
  const producer = outputs.get('particle-effect');
  if (producer === undefined) throw new Error('Missing standard particle producer');
  const expected = (
    await producer.produce({ guid: asset.guid, sourceKey: 'effect/inline', asset: direct.asset })
  ).unwrap();
  expect(asset.kind).toBe('particle-effect');
  expect(asset.payload).toEqual(expected.payload);
  expect(asset.refs).toEqual(expected.refs);
  expect(asset.artifacts).toEqual(expected.artifacts);
  expect(asset.payload).not.toHaveProperty('source');
});

it('keeps builtin custom-cooker overrides rejected and requires the native host for sources', async () => {
  for (const asset of [
    { kind: 'particle-effect' as const, execution: 'cooked' as const, source },
    { kind: 'particle-effect' as const, source },
  ]) {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: () => ok({ 'effect/inline': asset }),
    });
    expect(
      (
        await buildScriptablePack({
          definition,
          sourcePath: 'inline.pack.ts',
          outputs: createStandardAssetOutputProducerRegistry(),
        })
      ).ok,
    ).toBe(false);
  }
});
