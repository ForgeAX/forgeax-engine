import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import {
  createVfxStructuredInputBank,
  ParticleEffectPlayer,
  type VfxGpuEffectAsset,
  vfxPlayerParameters,
} from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { worldRenderResources } from '../../../render/src/publication/resource-scope';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { createStructuredInputProvider } from '../host/data-interface-providers';
import { createVfxRuntimeHost } from '../host/vfx-runtime-host';

it('transports four real Player inputs through Source publication and exact native per-entry upload plans', async () => {
  const cooked = (
    await cookParticleCodeProgram(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'observations',
            capacity: 4,
            space: 'world',
            backend: { required: 'gpu' },
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
            schedule: { rate: 60 },
            simulationWhenCulled: 'continue',
            program: { module: 'observations.wgsl' },
            renderers: [],
          },
        ],
      },
      {
        'observations.wgsl': {
          entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
#import forgeax_vfx::data::structured_input
struct VfxParameters { stationIndex: u32, }
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).position=bitcast<vec4<f32>>(structured_input[vfx_parameters().stationIndex*273u]).xyz;(*p).lifetime=2.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){(*p).age+=ctx.delta;}
`,
        },
      },
    )
  ).unwrap();
  const effect: VfxGpuEffectAsset = {
    guid: 'fixture-structured',
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: cooked.fingerprint,
    emitters: [{ id: 'observations', capacity: 4 }],
    program: { ...cooked.program, fingerprint: cooked.fingerprint },
  };
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const bank = createVfxStructuredInputBank({ recordStrideBytes: 273 * 16, capacity: 4 }).unwrap();
  for (let i = 0; i < 4; i++) {
    const record = new Uint8Array(273 * 16);
    record[0] = 10 + i;
    bank.write(i, record).unwrap();
  }
  const host = createVfxRuntimeHost({
    providers: [createStructuredInputProvider({ snapshot: () => bank.snapshot() })],
    camera: {
      read: () => ({
        position: new Float32Array(3),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      }),
    },
  });
  (await host.attachWorld({ world, assets })).unwrap();
  try {
    const handle = runtimeAssetRegistry(assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    for (let i = 0; i < 4; i++)
      world
        .spawn({
          component: ParticleEffectPlayer,
          data: { effect: handle, parameters: vfxPlayerParameters({ stationIndex: i }) },
        })
        .unwrap();
    world.update(1 / 60).unwrap();
    const extracted = host.feature
      .extract({ world, frameNumber: 1, views: [{ identity: 'main', render: true }] })
      .unwrap();
    const transported = structuredClone(extracted);
    bank.clear().unwrap();
    bank.dispose();
    const portable = transported.source?.portableDataInterfaces?.find(
      (row) => row.kind === 'structured-input',
    );
    expect(portable?.resource?.kind).toBe('storage-data');
    const bytes = portable?.resource?.value;
    if (!(bytes instanceof Uint8Array)) throw new Error('missing actual portable snapshot');
    expect([0, 1, 2, 3].map((i) => bytes[i * 273 * 16])).toEqual([10, 11, 12, 13]);
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const frame = { frameNumber: 1 } as never;
    const planned = host.feature
      .plan(transported, {
        generation: 1,
        frame,
        caps: device.caps,
        views: [{ identity: 'main', render: true, frame, targets: [], sceneData: {} as never }],
        resolveAsset: (handle, revision) =>
          worldRenderResources(world).resolveAsset(handle, revision),
      })
      .unwrap();
    const declarations = planned.work.flatMap((work) => work.resources);
    const uploads = declarations.filter(
      (row) => row.kind === 'buffer' && row.size === 17472 && row.data instanceof Uint8Array,
    );
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.every((row) => row.kind === 'buffer' && row.usage.includes('storage'))).toBe(
      true,
    );
    expect(uploads[0]?.kind === 'buffer' && uploads[0].data).toEqual(bytes);
    const programs = declarations.filter((row) => row.kind === 'compute-program');
    expect(programs.every((row) => row.program.entryPoints.length === 1)).toBe(true);
    host.feature.onFrameSubmitted?.(transported, {
      works: planned.work.map((work) => ({
        scope: work.scope,
        passes: work.passes.map((pass) => ({ name: pass.name })),
      })),
    });
    expect(host.feature.inspect().frameNumber).toBe(1);
    host.feature.onSourceFrameSubmitted?.(extracted, structuredClone(planned.sourceFeedback));
    expect(host.inspect(world)?.players.every((player) => player.queuedIntents === 0)).toBe(true);
  } finally {
    await host.detachWorld({ world });
    assets.dispose();
  }
});
