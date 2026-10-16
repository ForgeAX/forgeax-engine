import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { Materials } from '@forgeax/engine/render';
import {
  describeVfxGpuEffect,
  isVfxGpuEffectAsset,
  loadVfxGpuEffect,
  vfxGpuEffectPackLoader,
} from '@forgeax/engine/vfx';
import { cookParticleCodeEffect } from '@forgeax/engine/vfx-compiler';
import {
  errorCode,
  guid,
  installMemoryPack,
} from '../../features/asset-formats/fixtures/memory-pack';
import { defineFeature } from '../../lab/feature';

const EFFECT = guid(0x601);
const MATERIAL = guid(0x602);

const PROGRAM = `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0);
  (*particle).velocity = vec3<f32>(0.0, 1.0, 0.0);
  (*particle).lifetime = 1.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).position += (*particle).velocity * ctx.delta;
}
`;

const SOURCE = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'lab.sparks',
      capacity: 32,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 2 },
      schedule: { rate: 10 },
      program: { module: 'lab.vfx.wgsl' },
      renderers: [{ kind: 'billboard', material: MATERIAL }],
    },
  ],
};

export default defineFeature({
  title: 'Particle-effect asset',
  catalog: 'Particle-effect asset',
  kind: 'headless',
  summary:
    'A code-first particle source is cooked into a Pack v2 particle-effect row plus program artifact, then AssetRegistry loadByGuid (through the registered VFX pack loader) returns the payload for the consumer to wrap in a shared handle.',
  expect:
    'Cook succeeds, the row references its billboard material, loadVfxGpuEffect returns a VfxGpuEffect with one 32-capacity emitter after fetching the Pack and program artifact, and an unknown GUID fails with a structured code.',
  async run(checks) {
    const cooked = await cookParticleCodeEffect(
      SOURCE as never,
      { 'lab.vfx.wgsl': { entry: PROGRAM } } as never,
    );
    checks.ok(
      'cookParticleCodeEffect ok',
      cooked.ok,
      cooked.ok ? undefined : errorCode(cooked.error),
    );
    if (!cooked.ok) return;
    const { asset, refs, artifact } = cooked.value as unknown as {
      readonly asset: unknown;
      readonly refs: readonly string[];
      readonly artifact: {
        readonly artifactKey: string;
        readonly mimeType: string;
        readonly bytes: Uint8Array;
      };
    };
    checks.ok(
      'row references the billboard material',
      refs.includes(MATERIAL),
      JSON.stringify(refs),
    );

    const registry = new AssetRegistry({} as never);
    registry.loaders.registerPackLoader(vfxGpuEffectPackLoader);
    const { fetched } = installMemoryPack(registry, [
      { guid: MATERIAL, kind: 'material', payload: Materials.unlit([1, 0.5, 0.1, 1]) },
      {
        guid: EFFECT,
        kind: 'particle-effect',
        payload: asset,
        refs,
        artifacts: {
          [artifact.artifactKey]: {
            path: 'fx/program.json',
            mediaType: artifact.mimeType,
            bytes: artifact.bytes,
          },
        },
      },
    ]);
    const loaded = await loadVfxGpuEffect(registry, EFFECT as never);
    checks.ok('loadVfxGpuEffect ok', loaded.ok, loaded.ok ? undefined : errorCode(loaded.error));
    if (loaded.ok) {
      checks.ok('payload is a VfxGpuEffect', isVfxGpuEffectAsset(loaded.value));
      const emitters = loaded.value.program.emitters as readonly {
        readonly id: string;
        readonly capacity?: number;
      }[];
      checks.equal(
        'one 32-capacity emitter',
        emitters.map((e) => [e.id, e.capacity]),
        [['lab.sparks', 32]],
      );
      checks.equal(
        'descriptor names the loaded GUID',
        describeVfxGpuEffect(loaded.value).assetGuid,
        EFFECT,
      );
    }
    checks.ok(
      'program artifact fetched through the Pack',
      fetched.some((url) => url.endsWith('fx/program.json')),
      fetched.join(' '),
    );
    const missing = await loadVfxGpuEffect(registry, guid(0x6ff) as never);
    checks.ok(
      'unknown GUID fails structurally',
      !missing.ok && errorCode(missing.error) !== 'undefined',
      missing.ok ? 'ok' : errorCode(missing.error),
    );
  },
});
