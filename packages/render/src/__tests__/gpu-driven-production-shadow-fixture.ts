import { mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { assert } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import { GpuScene } from '../gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import { RenderScene } from '../scene/render-scene';
import {
  admitGpuFixture,
  mesh,
  preparedSnapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

export async function productionShadowFixture(count = 3, cascades = 3) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const projection = new RenderScene();
  const topology = new BatchTopology();
  const available = GpuScene.create(device, 16).unwrap();
  assert(available.status === 'available');
  const scene = available.scene;
  const rows = Array.from({ length: count }, (_, i) => {
    const source = preparedSnapshot(i + 1, i + 3);
    source.material.adopt({
      ...source.material.snapshot,
      materialHandle: i + 10,
      passes: ['Forward', 'ShadowCaster'].map((mode) => ({
        name: mode,
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: mode } },
      })),
      materialProgramKeys: {
        Forward: 'forgeax::default-standard-pbr',
        ShadowCaster: 'forgeax::default-standard-pbr',
      },
    });
    return source;
  });
  const owned = Array.from({ length: count }, () => mesh(device));
  const meshes = new Map(owned.map((value, i) => [i, value]));
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const input = {
    ...standardPbrInputs(device, shader, viewLayout),
    scene: {
      scene,
      plan: topology.query(topology.sourcePlan(), undefined),
      slots: projection.slotsSnapshot(),
      slotAt: projection.slotAt,
    },
    camera: makeZeroCameraFallbackSnapshot(),
    meshBySlot: meshes,
    viewBindGroupLayout: viewLayout,
    shadowViews: true,
  };
  const requests = Array.from({ length: cascades }, (_, index) => ({
    identity: { kind: 'directional' as const, index },
    planes: new Float32Array(24),
    matrix: mat4.identity(mat4.create()),
  }));
  const apply = (operations: Parameters<RenderScene['apply']>[0]) => {
    const delta = projection.apply(operations);
    topology.apply(delta);
    scene.sync(delta, undefined, (slot) => projection.cullingWorldBoundsAt(slot)).unwrap();
    input.scene = {
      scene,
      plan: topology.query(topology.sourcePlan(), undefined),
      slots: projection.slotsSnapshot(),
      slotAt: projection.slotAt,
    };
  };
  apply(rows.map(updateSnapshot));
  const prepare = (commit = true, selected?: readonly number[]) => {
    const admitted = admitGpuFixture(input);
    assert(admitted.materialFrame);
    scene.sync({ ...projection.apply([]), materials: admitted.materialFrame }).unwrap();
    const frame = production.prepare(admitted).unwrap();
    assert(frame);
    frame
      .updateShadowViews?.(
        requests.map((request) => ({
          ...request,
          ...(selected === undefined ? {} : { candidatePrimitiveIndices: selected }),
        })),
      )
      .unwrap();
    const views = requests
      .flatMap(({ identity }) => [{ ...identity, layer: 'static' as const }, identity])
      .map((identity) => {
        const submission = frame.shadowViewPool?.submission(identity);
        const bindings = frame.shadowBatchProjections?.()?.get(shadowViewIdentityKey(identity));
        assert(submission && bindings);
        return {
          identity,
          submission,
          bindings,
          selection: new GpuDrawSelection(submission.plan.batches),
        };
      });
    if (commit) frame._commitResourceReplacement();
    return { frame, views, admitted };
  };
  return {
    device,
    shader,
    viewLayout,
    scene,
    projection,
    topology,
    rows,
    meshes,
    production,
    input,
    requests,
    apply,
    prepare,
    dispose() {
      production.dispose();
      scene.dispose();
      for (const value of owned) {
        value.vertexBuffer.destroy().unwrap();
        value.indexBuffer?.destroy().unwrap();
      }
    },
  };
}
