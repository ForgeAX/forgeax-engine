import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, it, vi } from 'vitest';
import type { _InternalRenderPipelineContext } from '../render-context';

// Draw/material projection is not under test; keep it structurally minimal.
vi.mock('../../extract/gpu-driven', () => ({ buildGpuDrivenDraws: () => [] }));
vi.mock('../../gpu-driven/batch-topology', () => ({ eligibleGpuDrivenDraws: () => [] }));
vi.mock('../../gpu-driven/material-artifacts', () => ({
  collectGpuDrivenMaterialArtifacts: () => ({ materialArtifacts: [], shadowMaterialArtifacts: [] }),
  GpuDrivenMaterialProgramProjection: class {
    project() {
      return [];
    }
  },
}));
vi.mock('../../material-resource', async (original) => {
  const real = (await original()) as typeof import('../../material-resource');
  return {
    ...real,
    MaterialResource: class {
      static from = real.MaterialResource.from;
      constructor(readonly snapshot: unknown) {}
    },
  };
});
vi.mock('../../scene/material-dispatch', async (original) => ({
  ...((await original()) as object),
  MaterialFrame: class {
    with() {
      return this;
    }
    without() {
      return this;
    }
  },
}));

const { CandidatePipelinePreparationOwner } = await import('../candidate-pipeline-preparation');

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

it('does not pin the preparing frame or graph through a prepared candidate that outlives it', async () => {
  let graph: object | undefined = { scenePasses: [], scenePipelinePreparations: [() => true] };
  const preparingGraph = new WeakRef(graph);
  const owner = new CandidatePipelinePreparationOwner(() => graph as never);
  const input = {
    preparation: {
      entity: 1,
      transform: new Float32Array(16),
      materials: [{ id: 1, value: { renderState: {} } }],
      template: { snapshot: { material: 1, materials: [1] }, dispatch: [] },
    },
    mesh: { submeshes: [{ materialSlot: 0 }] },
    asset: createBoxGeometry(1, 1, 1).unwrap(),
    isCurrent: () => true,
  } as never;
  const pending = owner.prepare(input);
  // Frame-owned state (selection, dispatch, plans) only this frame references.
  let selection: object | undefined = new Float64Array(1 << 16);
  const released = new WeakRef(selection);
  let frame: object | undefined = { gpuDrivenSelection: selection };
  let context: object | undefined = { frameState: frame, runtime: {} };
  owner.process(context as _InternalRenderPipelineContext, false);
  const result = await pending;
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  selection = undefined;
  frame = undefined;
  context = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  // The lease keeps its prepared result alive; the frame must not be.
  expect(result.value.isCurrent()).toBe(true);
  expect(released.deref()).toBeUndefined();
  // A rebuilt graph replaces the preparing one, which must not stay reachable.
  graph = { scenePasses: [], scenePipelinePreparations: [] };
  expect(result.value.isCurrent()).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  expect(preparingGraph.deref()).toBeUndefined();
  result.value.release();
  expect(result.value.isCurrent()).toBe(false);
});

it('excludes explicit utility programs from candidate raster matching without accepting unknown material demand', async () => {
  const utility = Object.assign(
    vi.fn(() => false),
    { kind: 'utility' as const },
  );
  const material = vi.fn(() => true);
  const graph = { scenePasses: [], scenePipelinePreparations: [utility, material] };
  const readDemand = vi.fn(() => undefined);
  const owner = new CandidatePipelinePreparationOwner(() => graph as never, readDemand);
  const input = {
    preparation: {
      entity: 1,
      transform: new Float32Array(16),
      materials: [{ id: 1, value: { renderState: {} } }],
      template: { snapshot: { material: 1, materials: [1] }, dispatch: [] },
    },
    mesh: { submeshes: [{ materialSlot: 0 }] },
    asset: createBoxGeometry(1, 1, 1).unwrap(),
    isCurrent: () => true,
  } as never;
  const pending = owner.prepare(input);
  expect(owner.inspect().unsupportedGraph).toBe(1);
  expect(readDemand).not.toHaveBeenCalled();
  owner.process({ frameState: {}, runtime: {} } as _InternalRenderPipelineContext, false);
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(material).toHaveBeenCalledOnce();
  expect(utility).toHaveBeenCalledOnce();
  if (result.ok) result.value.release();
  owner.dispose();
});

it('does not treat a utility-only graph as a candidate material raster authority', async () => {
  const utility = Object.assign(
    vi.fn(() => true),
    { kind: 'utility' as const },
  );
  const graph = { scenePasses: [], scenePipelinePreparations: [utility] };
  const readDemand = vi.fn(() => undefined);
  const owner = new CandidatePipelinePreparationOwner(() => graph as never, readDemand);
  const input = {
    preparation: {
      entity: 1,
      transform: new Float32Array(16),
      materials: [{ id: 1, value: { renderState: {} } }],
      template: { snapshot: { material: 1, materials: [1] }, dispatch: [] },
    },
    mesh: { submeshes: [{ materialSlot: 0 }] },
    asset: createBoxGeometry(1, 1, 1).unwrap(),
    isCurrent: () => true,
  } as never;
  const pending = owner.prepare(input);
  expect(owner.inspect().unsupportedGraph).toBe(0);
  expect(readDemand).toHaveBeenCalledOnce();
  owner.process({ frameState: {}, runtime: {} } as _InternalRenderPipelineContext, false);
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(utility).not.toHaveBeenCalled();
  owner.dispose();
});
