import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  createRenderPublisher,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { renderLifecycleManifestUrl } from '../../../render/src/__tests__/shader-manifest-fixture';
import { constructRuntimeRendererHost } from '../renderer-host';

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

it('uses the public publication Renderer for preparation and exact submitted draw evidence', async () => {
  const identity = { source: 'runtime-mesh-residency', epoch: 1 };
  const { renderer, assets, initialization } = value(
    await constructRuntimeRendererHost(
      { width: 64, height: 64, getContext: () => null },
      { rhi, publicationSource: identity, ui: { kind: 'rgba', paint: () => null } },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    ),
  );
  value(await initialization);
  const world = new World();
  const publisher = createRenderPublisher(world, assets, identity, renderer.inspect().capabilities);
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const meshHandle = world.allocSharedRef('MeshAsset', mesh);
  const prepared = (
    await renderer.preparePublishedMeshResidency({ ...identity, meshHandle, mesh })
  ).unwrap();
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit([1, 0, 0, 1]));
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
      },
    )
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const draw = async () => {
    world.update(1 / 60).unwrap();
    const publication = publisher.prepare(0).unwrap();
    const packet = structuredClone(publication.packet);
    publication.accept();
    const receipt = value(renderer.draw({ publication: packet }));
    value(await receipt.completed);
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return receipt;
  };
  try {
    const first = await draw();
    expect(prepared.isCurrent()).toBe(true);
    expect(prepared.recordStageLane(first, entity).unwrap()).toBe('cpu');
    expect(prepared.recordStageLane({ ...first }, entity).ok).toBe(false);
    const second = await draw();
    expect(prepared.recordStageLane(first, entity).ok).toBe(false);
    expect(prepared.recordStageLane(second, entity).unwrap()).toBe('cpu');
    const uiOnly = value(renderer.draw({ leases: [], camera: null, environment: null }));
    value(await uiOnly.completed);
    expect(prepared.recordStageLane(uiOnly, entity).ok).toBe(false);
    const resumed = await draw();
    expect(prepared.recordStageLane(resumed, entity).unwrap()).toBe('cpu');
    value(await renderer.dispose());
    expect(prepared.isCurrent()).toBe(false);
  } finally {
    await prepared.release();
    publisher.dispose();
    await renderer.dispose();
  }
});
