// Real production preparation over retained RenderScene and GPU Scene owners.
// RhiNull keeps this a CPU diagnostic; it makes no raster/GPU/FPS claim.
import { deepStrictEqual } from 'node:assert';
import { ok } from '@forgeax/engine-rhi';
import {
  createShaderModule,
  RhiNullCommandEncoder,
  RhiNullDevice,
  RhiNullQueue,
} from '@forgeax/engine-rhi-null';
import {
  mesh,
  preparedSnapshot,
  standardPbrInputs,
  updateSnapshot,
} from '../src/__tests__/gpu-driven-production-fixture';
import { BatchTopology } from '../src/gpu-driven/batch-topology';
import { materialBindingKey } from '../src/gpu-driven/material-bindings';
import { GpuDrivenProduction } from '../src/gpu-driven/production-raster';
import { GpuScene } from '../src/gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../src/record/frame-snapshot';
import { RenderScene } from '../src/scene/render-scene';

export const modes = ['stable-empty', 'stable-bound', 'one-dirty', 'all-dirty'] as const;

export async function createCase(mode: (typeof modes)[number], batchCount = 2300) {
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
  );
  const shader = (await createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const resident = mesh(device);
  const projection = new RenderScene();
  const snapshots = Array.from({ length: batchCount }, (_, i) => preparedSnapshot(i + 1, i + 1));
  const delta = projection.apply(snapshots.map(updateSnapshot));
  const available = GpuScene.create(device, batchCount).unwrap();
  if (available.status !== 'available') throw Error('Missing Null GPU Scene capability');
  available.scene.sync(delta).unwrap();
  const slots = projection.slotsSnapshot();
  const topology = new BatchTopology();
  topology.rebuild(slots);
  const bindings = new Map<string, string>();
  const dirtyCount = mode === 'one-dirty' ? 1 : mode === 'all-dirty' ? batchCount : 0;
  const keys = slots.map((slot) =>
    materialBindingKey(slot.snapshot, slot.snapshot.material.materialHandle ?? -1),
  );
  if (mode !== 'stable-empty') for (const key of keys) bindings.set(key, 'forward|probe:2');
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const input = {
    ...standardPbrInputs(device, shader, viewLayout),
    scene: { scene: available.scene, plan: topology.plan(), slots, slotAt: projection.slotAt },
    camera: makeZeroCameraFallbackSnapshot(),
    meshBySlot: new Map(slots.map((slot) => [slot.slot, resident])),
    meshResidencyEpoch: 0,
    viewBindGroupLayout: viewLayout,
    materialBindingClasses: bindings,
    shadowCasterMembership: [],
  };
  const prepare = () => {
    const frame = production.prepare(input).unwrap();
    if (frame === undefined) throw Error('Missing admitted frame');
    frame._commitResourceReplacement();
    return frame;
  };
  const first = prepare();
  if (first.drawKeys.size !== batchCount) throw Error('Unexpected benchmark draw roster');
  let step = 0;
  const change = () => {
    step = 1 - step;
    for (let i = 0; i < dirtyCount; i++) {
      const key = keys[i];
      if (key === undefined) throw Error('Missing benchmark binding');
      bindings.set(key, step === 0 ? 'forward|probe:2' : 'forward|probe:3');
    }
  };
  for (let i = 0; i < 2; i++) {
    change();
    const frame = prepare();
    deepStrictEqual(frame.drawKeys, first.drawKeys);
    deepStrictEqual(frame.topologySignature, first.topologySignature);
    const work = production.inspect();
    if (work.filteredBatchBuilds !== dirtyCount || work.preparedBatchBuilds !== 0)
      throw Error(`Unexpected benchmark work: ${JSON.stringify(work)}`);
  }
  return {
    run(iterations: number) {
      let elapsed = 0;
      for (let i = 0; i < iterations; i++) {
        change();
        const start = performance.now();
        prepare();
        elapsed += performance.now() - start;
      }
      return elapsed / iterations;
    },
    inspect() {
      const work = production.inspect();
      return {
        batchCount,
        preparedBatchBuilds: work.preparedBatchBuilds,
        filteredBatchBuilds: work.filteredBatchBuilds,
        filteredPlanBuilds: work.filteredPlanBuilds,
      };
    },
    close() {
      production.dispose();
      available.scene.dispose();
      resident.vertexBuffer.destroy().unwrap();
      resident.indexBuffer?.destroy().unwrap();
    },
  };
}
