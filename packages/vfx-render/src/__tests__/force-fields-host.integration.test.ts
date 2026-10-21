import { AssetRegistry, type CatalogSource } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { textureContribution } from '@forgeax/engine-image';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import {
  type CatalogDelta,
  type CatalogEntry,
  ok,
  type ParticleEffectAsset,
} from '@forgeax/engine-types';
import { ParticleEffectPlayer } from '@forgeax/engine-vfx';
import { cookParticleCodeProgram, createVfxVectorFieldTexture } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { normaliseForPack } from '../../../import/src/import-runner.js';
import { textureAssetOutputProducer } from '../../../import/src/scriptable-pack-output-producers.js';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { createVfxRuntimeHost } from '../host/vfx-runtime-host.js';

it('keeps the accepted field during explicit source reload and retains runtime ownership after source removal', async () => {
  const guid = '01a11250-0000-7000-8000-000000000001';
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const cooked = (
    await cookParticleCodeProgram(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'fields',
            capacity: 4,
            backend: { required: 'gpu' },
            space: 'world',
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
            schedule: { rate: 0, bursts: [{ time: 0, count: 4 }] },
            program: { module: 'fields.wgsl' },
            renderers: [{ kind: 'billboard', material: '01a11250-0000-7000-8000-000000000002' }],
            forceFields: [
              {
                kind: 'vector',
                texture: guid,
                sampling: 'trilinear',
                transform: matrix,
                strength: 1,
                attenuation: 0,
              },
            ],
          },
        ],
      },
      {
        'fields.wgsl': {
          entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_integrate}
#import forgeax_vfx::data::force_fields
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).lifetime=100.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){vfx_apply_force_fields(ctx,p);vfx_integrate(ctx,p);}`,
        },
      },
    )
  ).unwrap();
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: cooked.fingerprint,
    emitters: [{ id: 'fields', capacity: 4 }],
    program: { ...cooked.program, fingerprint: cooked.fingerprint },
  };
  const rows: CatalogEntry[] = [];
  const listeners = new Set<(delta: CatalogDelta) => void>();
  const packages = new Map<string, string | Uint8Array>();
  let delay: Promise<void> | undefined;
  const source: CatalogSource = {
    enumerate: async () => ok([...rows]),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openPackage: () => async (input) => {
      if (String(input).endsWith('field.bin')) await delay;
      const body = packages.get(String(input));
      return new Response(
        body === undefined ? '' : typeof body === 'string' ? body : new Uint8Array(body),
        { status: body === undefined ? 404 : 200 },
      );
    },
  };
  const registry = new AssetRegistry({ scopeId: 'runtime-fields' });
  registry.installDecoder(textureContribution.kind, textureContribution.decoder);
  registry.setCatalogSource(source);
  const publish = async (value: number, revision: number) => {
    const texture = createVfxVectorFieldTexture({
      resolution: [8, 8, 8],
      field: { kind: 'constant', value: [value, 0, 0] },
    }).unwrap();
    const product = (
      await textureAssetOutputProducer.produce({ guid, sourceKey: 'field', asset: texture })
    ).unwrap();
    const body = product.artifacts.body;
    if (body === undefined) throw new Error('texture producer omitted its ordinary artifact');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(body.bytes)));
    const digest = `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const packageUrl = `https://runtime.invalid/fields/${revision}/pack.json`;
    const { pack, publication } = createRuntimePackPublication({
      scopeId: 'runtime-fields',
      sourcePath: 'fields',
      sourceRevision: String(revision),
      packageUrl,
      pack: {
        assets: [
          {
            guid,
            kind: 'texture',
            payload: normaliseForPack(product.payload),
            refs: [],
            artifacts: {
              body: {
                path: 'field.bin',
                mediaType: body.mediaType,
                contentEncoding: 'identity',
                assetCodec: body.assetCodec,
                byteLength: body.bytes.byteLength,
                integrity: { algorithm: 'sha256', digest },
              },
            },
          },
        ],
      },
    });
    packages.set(packageUrl, JSON.stringify(pack));
    packages.set(new URL('field.bin', packageUrl).href, new Uint8Array(body.bytes));
    const row: CatalogEntry = {
      guid,
      kind: 'texture',
      packageUrl,
      sourcePath: 'fields',
      sourceKey: 'field',
      publication,
      lifecycle: 'current',
    };
    const previous = rows.splice(0, rows.length, row);
    for (const listener of listeners)
      listener({
        added: previous.length === 0 ? [row] : [],
        changed: previous.length === 0 ? [] : [row],
        removed: [],
      });
  };
  await publish(0.5, 1);
  const texture = (await registry.load(guid, 'texture')).unwrap();
  const firstTexture = registry.read(texture).unwrap();
  const world = new World({ assets: registry });
  world
    .spawn({
      component: ParticleEffectPlayer,
      data: {
        effect: runtimeAssetRegistry(world.assets)
          .create(runtimeEffectFixture(world, { ...asset, guid: 'effect' }))
          .unwrap(),
        playing: true,
        seed: 21,
        timeScale: 1,
      },
    })
    .unwrap();
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array(matrix),
  };
  const host = createVfxRuntimeHost({ camera: { read: () => camera } });
  (await host.attachWorld({ world, assets: registry })).unwrap();
  let frameNumber = 0;
  const fields = () =>
    host.feature
      .extract({
        worlds: [world],
        owner: 0,
        views: [{ identity: 'main', render: true }],
        frameNumber: ++frameNumber,
      })
      .unwrap()
      .worlds[0]?.intents.at(-1)?.forceFields;
  try {
    world.update(1 / 60).unwrap();
    const first = fields();
    expect(first?.ok).toBe(true);
    let release = () => {};
    delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    await publish(2, 2);
    const pending = fields();
    // A source replacement does not tear down an admitted field while its
    // normal binary artifact is still arriving.
    expect(pending).toEqual(first);
    const loading = registry.reload(texture, { conflict: 'reject' });
    release();
    (await loading).unwrap();
    const secondTexture = registry.read(texture).unwrap();
    expect(secondTexture).not.toBe(firstTexture);
    expect(fields()).toEqual(first);
    world.update(1 / 60).unwrap();
    const second = fields();
    expect(second?.ok).toBe(true);
    if (first?.ok && second?.ok) {
      expect(second.value[0]?.revision).not.toBe(first.value[0]?.revision);
      const read = (reference: { handle: number; revision: number } | undefined) => {
        if (reference === undefined) throw new Error('Missing fixed Texture input');
        const texture = runtimeAssets(world.assets)
          .resolveAsset<import('@forgeax/engine-types').TextureAsset>(
            reference.handle,
            reference.revision,
          )
          .unwrap();
        return new DataView(
          texture.data.buffer,
          texture.data.byteOffset,
          texture.data.byteLength,
        ).getFloat32(0, true);
      };
      expect(read(second.value[0])).toBe(2);
      expect(read(first.value[0])).toBe(0.5);
    }
    rows.length = 0;
    for (const listener of listeners) listener({ added: [], changed: [], removed: [guid] });
    // Let the Catalog owner finish its current reconciliation and accept the
    // buffered removal before asserting the consumer's revocation.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(registry.source(texture).unwrap()?.guid).toBe(guid);
    fields();
    expect((await registry.reload(texture, { conflict: 'reject' })).ok).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fields()).toEqual(second);
  } finally {
    await host.detachWorld({ world });
    registry.dispose();
  }
});
