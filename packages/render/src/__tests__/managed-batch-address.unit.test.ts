import { frustum, mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { RenderScene } from '../scene/render-scene';
import { observeCandidateReads } from './gpu-driven-candidate-read-observer';
import { preparedSnapshot, updateSnapshot } from './gpu-driven-production-fixture';
import { updateGpuView } from './helpers/gpu-input-read-domain';

it('encodes material addresses per execution batch without reading members', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'structural fixture' })).unwrap();
  const scene = new RenderScene();
  const source = preparedSnapshot(1, 3);
  const delta = scene.apply(
    Array.from({ length: 10_000 }, (_, entityKey) => updateSnapshot({ ...source, entityKey })),
  );
  const available = GpuScene.create(device, 10_000).unwrap();
  assert(available.status === 'available');
  const gpu = available.scene;
  gpu.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.apply(delta);
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const perMember = vi.spyOn(gpu, 'materialIndexForSlot');
  let candidateReads = 0;
  const before = topology.query(topology.sourcePlan(), undefined);
  const stopObservingCandidates = observeCandidateReads(
    before.batches.map((batch) => batch.candidates),
    () => {
      candidateReads++;
    },
  );
  try {
    updateGpuView(view, before, gpu, planes).unwrap();
    expect(perMember.mock.calls.length).toBe(0);
    const uploads = view.inspect().sharedInputUploadBytes;
    assert(uploads > 0);
    expect(candidateReads).toBeGreaterThan(0);
    candidateReads = 0;
    const after = {
      ...before,
      batches: before.batches.map((batch) => ({ ...batch, materialAddress: 17 })),
    };
    updateGpuView(view, after, gpu, planes).unwrap();
    expect(perMember.mock.calls.length).toBe(0);
    expect(view.inspect().sharedInputUploadBytes).toBe(0);
    expect(candidateReads).toBe(0);
    expect(after.batches.at(0)?.candidates).toBe(before.batches.at(0)?.candidates);
  } finally {
    stopObservingCandidates();
    perMember.mockRestore();
    view.dispose();
    gpu.dispose();
  }
});
