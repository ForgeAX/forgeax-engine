import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { type MaterialRenderState, ok, type Result } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import type { GpuDrivenPreparationError } from '../errors/gpu-driven';
import type { BatchExecution } from '../gpu-driven/batch-execution';
import { capturedGpuDrivenBatchKey, captureMeshBatch } from '../gpu-driven/batch-key';
import { BatchTopology, type GpuDrivenBatch } from '../gpu-driven/batch-topology';
import { freezePreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import { type GpuDrivenPrepareInput, GpuDrivenProduction } from '../gpu-driven/production-raster';
import type { PreparedProductionPlan } from '../gpu-driven/production-raster-prepare';
import { GpuScene, type GpuSceneResourceFrame } from '../gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import { RenderScene } from '../scene/render-scene';
import {
  admitGpuFixture,
  mesh,
  preparedPbrSnapshot,
  snapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

type Execution = Extract<BatchExecution, { route: 'gpu' }>;
type Assembly = {
  assemblePrepared(
    scene: NonNullable<GpuDrivenPrepareInput['scene']>,
    resources: GpuSceneResourceFrame,
    pass: 'forward' | 'shadow',
    executions: NonNullable<GpuDrivenPrepareInput['batchExecutions']>,
    meshes: NonNullable<GpuDrivenPrepareInput['meshByBinding']>,
  ): Result<PreparedProductionPlan, GpuDrivenPreparationError>;
};

async function fixture() {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const inputs = standardPbrInputs(device, shader, viewLayout);
  const projection = new RenderScene();
  const delta = projection.apply([updateSnapshot(preparedPbrSnapshot(snapshot(1, 3)))]);
  const available = GpuScene.create(device, 4).unwrap();
  assert(available.status === 'available');
  available.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const plan = topology.query(topology.sourcePlan(), undefined);
  const source = plan.batches.at(0);
  assert(source);
  const batch = captureMeshBatch(source);
  assert(capturedGpuDrivenBatchKey(batch));
  const scene = {
    scene: available.scene,
    plan: { ...plan, batches: [batch] },
    slots: projection.slotsSnapshot(),
    slotAt: projection.slotAt,
  };
  const resident = mesh(device);
  const input = admitGpuFixture({
    ...inputs,
    scene,
    camera: makeZeroCameraFallbackSnapshot(),
    meshBySlot: new Map([[0, resident]]),
    viewBindGroupLayout: viewLayout,
  });
  const binding = batch.binding;
  assert(binding && input.batchExecutions && input.meshByBinding);
  const selected = input.batchExecutions.get(binding)?.forward;
  assert(selected?.route === 'gpu');
  let execution: Execution = selected;
  let materialAddress = 1;
  let geometryAddress: number | undefined = 2;
  const resources = available.scene.captureResources().unwrap();
  vi.spyOn(resources, 'logicalForResource').mockImplementation(() => materialAddress);
  vi.spyOn(resources, 'logicalForGeometry').mockImplementation(() => geometryAddress);
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const owner = production as unknown as Assembly;
  const assemble = (sourceBatch = batch) => {
    scene.plan = { ...plan, batches: [sourceBatch] };
    const executions = new Map(input.batchExecutions);
    executions.set(binding, { forward: execution, shadow: { route: 'none' } });
    return owner
      .assemblePrepared(scene, resources, 'forward', executions, input.meshByBinding)
      .unwrap();
  };
  return {
    batch,
    assemble,
    get execution() {
      return execution;
    },
    set execution(value: Execution) {
      execution = value;
    },
    set materialAddress(value: number) {
      materialAddress = value;
    },
    set geometryAddress(value: number | undefined) {
      geometryAddress = value;
    },
    dispose() {
      resources.release();
      production.dispose();
      available.scene.dispose();
      resident.vertexBuffer.destroy();
      resident.indexBuffer?.destroy();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const changes: readonly [string, (f: Fixture) => void][] = [
  [
    'material address',
    (f) => {
      f.materialAddress = 3;
    },
  ],
  [
    'geometry address',
    (f) => {
      f.geometryAddress = 4;
    },
  ],
  [
    'absent geometry address',
    (f) => {
      f.geometryAddress = undefined;
    },
  ],
  [
    'material handle',
    (f) => {
      f.execution = { ...f.execution, material: { ...f.execution.material, materialHandle: 17 } };
    },
  ],
  [
    'texture mask',
    (f) => {
      f.execution = {
        ...f.execution,
        material: { ...f.execution.material, standardTextureMask: 1 },
      };
    },
  ],
  [
    'alpha admission',
    (f) => {
      f.execution = {
        ...f.execution,
        material: {
          ...f.execution.material,
          paramSnapshot: { ...f.execution.material.paramSnapshot, alphaCutoff: 0.5 },
        },
      };
    },
  ],
  [
    'material pass',
    (f) => {
      f.execution = { ...f.execution, material: { ...f.execution.material, deferredPass: true } };
    },
  ],
  [
    'prepared receipt identity',
    (f) => {
      f.execution = {
        ...f.execution,
        prepared: freezePreparedGpuDrivenDraw({
          ...f.execution.prepared,
          receiptIdentity: 'replacement-receipt',
        }),
      };
    },
  ],
];

it.each(changes)('invalidates native retained rows after changing %s', async (_name, change) => {
  const f = await fixture();
  try {
    const first = f.assemble().batchRows[0];
    expect(f.assemble().batchRows[0]).toBe(first);
    change(f);
    const changed = f.assemble().batchRows[0];
    expect(changed).not.toBe(first);
    expect(f.assemble().batchRows[0]).toBe(changed);
  } finally {
    f.dispose();
  }
});

it('observes the pipeline class when borrowed prepared draws have no captured material key', async () => {
  const f = await fixture();
  try {
    f.execution = { ...f.execution, prepared: { ...f.execution.prepared } };
    const first = f.assemble().batchRows[0];
    expect(first?.source.key.preparedIdentity).toBe('');
    f.execution = {
      ...f.execution,
      prepared: {
        ...f.execution.prepared,
        identity: { ...f.execution.prepared.identity, material: 'replacement-program' },
      },
    };
    const changed = f.assemble().batchRows[0];
    expect(changed).not.toBe(first);
    expect(changed?.source.key.preparedIdentity).toBe('');
    expect(changed?.source.key.pipelineClass).toBe('replacement-program');
  } finally {
    f.dispose();
  }
});

it('observes in-place render-state mutation without relying on the state object identity', async () => {
  const f = await fixture();
  try {
    const state: MaterialRenderState & { depthBias: number } = { depthBias: 0 };
    f.execution = { ...f.execution, pass: { ...f.execution.pass, renderState: state } };
    const first = f.assemble().batchRows[0];
    state.depthBias = 1;
    const changed = f.assemble().batchRows[0];
    expect(changed).not.toBe(first);
    expect(changed?.fact?.renderState?.depthBias).toBe(1);
  } finally {
    f.dispose();
  }
});

it('compares the complete captured source key and retains facts after a visible-window rebase', async () => {
  const f = await fixture();
  try {
    const first = f.assemble().batchRows[0];
    const rebased = captureMeshBatch({ ...f.batch, visibleBase: f.batch.visibleBase + 8 });
    const moved = f.assemble(rebased).batchRows[0];
    expect(moved).not.toBe(first);
    expect(moved?.fact).toBe(first?.fact);
    expect(moved?.source.visibleBase).toBe(rebased.visibleBase);
    expect(f.assemble(rebased).batchRows[0]).toBe(moved);
    const changed = captureMeshBatch({
      ...rebased,
      key: Object.freeze({ ...rebased.key, count: rebased.key.count + 1 }),
    });
    expect(f.assemble(changed).batchRows[0]?.fact).not.toBe(moved?.fact);
  } finally {
    f.dispose();
  }
});

it('keeps borrowed source keys on live observation and handles a later captured source', async () => {
  const f = await fixture();
  try {
    const key = { ...f.batch.key };
    const borrowed: GpuDrivenBatch = { ...f.batch, key };
    const first = f.assemble(borrowed).batchRows[0];
    expect(f.assemble(borrowed).batchRows[0]).toBe(first);
    key.count++;
    const changed = f.assemble(borrowed).batchRows[0];
    expect(changed).not.toBe(first);
    const captured = captureMeshBatch({ ...borrowed, key: Object.freeze({ ...key }) });
    const adopted = f.assemble(captured).batchRows[0];
    expect(adopted).not.toBe(changed);
    expect(f.assemble(captured).batchRows[0]).toBe(adopted);
  } finally {
    f.dispose();
  }
});
