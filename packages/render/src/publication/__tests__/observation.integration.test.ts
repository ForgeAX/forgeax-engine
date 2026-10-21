import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { afterEach, expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { renderPublicationTransfers } from '../contract';
import { SOURCE_PREPARATION_PROTOCOL, type SourcePreparationControl } from '../observation';
import { createRenderPublisher } from '../publisher';

const root = globalThis as typeof globalThis & {
  __forgeaxFramePhaseDiagnostics?: { sourcePreparation?: SourcePreparationControl };
};
afterEach(() => {
  delete root.__forgeaxFramePhaseDiagnostics;
});
it('observes the original partial extraction and cloned runtime mesh once without changing packet bytes', () => {
  function run(enabled: boolean) {
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    });
    const world = new World({ assets });
    const publisher = createRenderPublisher(world, assets, { source: 'actual-source', epoch: 2 });
    const first = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: first } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    world.update(0).unwrap();
    const initial = publisher.prepare(0).unwrap();
    initial.accept();
    publisher.recycle(initial.packet.revision, renderPublicationTransfers(initial.packet)).unwrap();
    const c: SourcePreparationControl = {
      protocol: SOURCE_PREPARATION_PROTOCOL,
      enabled,
      token: 'integration',
      build: 'b'.repeat(40),
      worldIdentity: world.identity,
      maxAttempts: 2,
      attempts: 0,
      skipped: 0,
      dropped: 0,
      failures: 0,
      probeWallMs: 0,
      observerWallMs: 0,
      clockCalls: 0,
      clockFailures: 0,
      cancelled: false,
      finalizationWallMs: 0,
      outcomes: { accepted: 0, discarded: 0, 'prepare-error': 0, retired: 0 },
    };
    root.__forgeaxFramePhaseDiagnostics = { sourcePreparation: c };
    const second = assets.create(createBoxGeometry(2, 1, 1).unwrap()).unwrap();
    world.set(entity, MeshFilter, { assetHandle: second }).unwrap();
    world.update(0).unwrap();
    const tx = publisher.prepare(0, false, { frameId: 37 }).unwrap();
    const mesh = tx.packet.assets.find((row) => row.handle === second)?.value;
    if (mesh?.kind !== 'mesh') throw Error('Expected actual emitted mesh');
    const bytes = [...mesh.vertices, ...(mesh.indices ?? [])];
    expect(Object.hasOwn(tx.packet, 'observation')).toBe(false);
    tx.accept();
    publisher.dispose();
    return { bytes, c };
  }
  const before = run(false),
    after = run(true);
  expect(after.bytes).toEqual(before.bytes);
  expect(before.c.attempts).toBe(0);
  expect(after.c.result).toMatchObject({
    status: 'accepted',
    frameId: 37,
    source: 'actual-source',
    revision: 2,
    runtimeMeshes: 1,
    facts: { changed: 1, assetChanges: 1 },
    counts: { 'renderable-component-or-new': 1 },
  });
  expect(after.c.failures).toBe(0);
  expect(after.c.enabled).toBe(false);
});
