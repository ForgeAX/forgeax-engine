import { mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import { GpuScene } from '../gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import { RenderScene } from '../scene/render-scene';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';
import {
  admitGpuFixture,
  mesh,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

export async function shadowPublicationFixture(instances = 16) {
  const source = createFilterPlanFixture({ instances, sharedGeometry: true });
  source.material.adopt({
    ...source.material.snapshot,
    passes: [
      ...source.material.snapshot.passes,
      {
        name: 'shadow',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'ShadowCaster' } },
      },
    ],
    materialProgramKeys: {
      forward: 'forgeax::default-standard-pbr',
      shadow: 'forgeax::default-standard-pbr',
    },
  });
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const projection = new RenderScene();
  const available = GpuScene.create(device, 32).unwrap();
  if (available.status !== 'available') throw Error('GPU Scene unavailable');
  const scene = available.scene;
  scene.sync(projection.apply(source.slots.map((slot) => updateSnapshot(slot.snapshot)))).unwrap();
  const resident = mesh(device, true, true);
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const input = {
    ...standardPbrInputs(device, shader, viewLayout),
    scene: {
      scene,
      plan: source.source,
      slots: projection.slotsSnapshot(),
      slotAt: projection.slotAt,
    },
    camera: makeZeroCameraFallbackSnapshot(),
    meshBySlot: new Map(source.slots.map((slot) => [slot.slot, resident])),
    viewBindGroupLayout: viewLayout,
    meshResidencyEpoch: 1,
    shadowViews: true,
  };
  const identities = [0, 1, 2].flatMap((index) => [
    { kind: 'directional' as const, index, layer: 'static' as const },
    { kind: 'directional' as const, index },
  ]);
  const requests = identities
    .filter((identity) => !('layer' in identity))
    .map((identity) => ({
      identity,
      planes: new Float32Array(24),
      matrix: mat4.identity(mat4.create()),
    }));
  function prepare(
    selected?: readonly number[],
    bindings?: ReadonlyMap<string, string>,
    commit = true,
  ) {
    const frame = production
      .prepare(
        admitGpuFixture({
          ...input,
          ...(bindings === undefined ? {} : { materialBindingClasses: bindings }),
        }),
      )
      .unwrap();
    if (frame === undefined) throw Error('Missing GPU frame');
    frame
      .updateShadowViews?.(
        requests.map((request) => ({
          ...request,
          ...(selected === undefined ? {} : { candidatePrimitiveIndices: selected }),
        })),
      )
      .unwrap();
    const views = identities.map((identity) => {
      const submission = frame.shadowViewPool?.submission(identity);
      const bindings = frame.shadowBatchProjections?.get(shadowViewIdentityKey(identity));
      if (submission === undefined || bindings === undefined)
        throw Error('Missing shadow publication');
      return { submission, bindings };
    });
    if (commit) frame._commitResourceReplacement();
    return { frame, views };
  }
  return {
    source,
    device,
    production,
    input,
    scene,
    projection,
    identities,
    prepare,
    dispose() {
      production.dispose();
      scene.dispose();
      resident.vertexBuffer.destroy().unwrap();
      resident.indexBuffer?.destroy().unwrap();
    },
  };
}
