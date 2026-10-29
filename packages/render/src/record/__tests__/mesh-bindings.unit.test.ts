import type {
  BindGroup,
  BindGroupDescriptor,
  BindGroupLayout,
  Buffer,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import type { MeshSsboBufferWrapper } from '../../assembly/mesh-ssbo-grow';
import { meshSlotBindGroup } from '../frame-lighting';
import type { RenderFrameState } from '../frame-snapshot';
import { findFromChain } from '../mesh-ssbo';
import type { PipelineState } from '../render-context';

function fixture() {
  const descriptors: BindGroupDescriptor[] = [];
  const failure = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'fixture creation succeeds',
    hint: 'retry fixture creation',
  });
  let rejecting = false;
  const device = {
    caps: { storageBuffer: true },
    createBindGroup(descriptor: BindGroupDescriptor) {
      if (rejecting) return err(failure);
      descriptors.push(descriptor);
      return ok({} as BindGroup);
    },
  } as unknown as RhiDevice;
  const storage = { buffer: {} as Buffer, pages: undefined as MeshSsboBufferWrapper['pages'] };
  const pipelineOwner = {
    meshStorageBuffer: storage,
    meshBindGroupLayout: {} as BindGroupLayout,
  };
  const pipeline = pipelineOwner as unknown as PipelineState;
  const state = { meshBindGroupCache: new WeakMap<object, unknown>() } as RenderFrameState;
  const counts = { createBindGroup: 0, keys: [] as string[] };
  return {
    device,
    pipeline,
    pipelineOwner,
    storage,
    state,
    counts,
    descriptors,
    failure,
    reject: (value: boolean) => {
      rejecting = value;
    },
  };
}

it('shares the generic cache namespace and invalidates physical buffer or layout changes', () => {
  const f = fixture();
  const firstBuffer = f.storage.buffer;
  const firstLayout = f.pipeline.meshBindGroupLayout;
  const first = meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 0);
  expect(meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 64)).toBe(first);
  expect(findFromChain(f.state.meshBindGroupCache, [firstLayout, firstBuffer], 'mesh')).toBe(first);
  expect(f.counts.createBindGroup).toBe(1);
  f.storage.buffer = {} as Buffer;
  const second = meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 0);
  expect(second).not.toBe(first);
  f.pipelineOwner.meshBindGroupLayout = {} as BindGroupLayout;
  expect(meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 0)).not.toBe(second);
  expect(f.counts).toEqual({ createBindGroup: 3, keys: ['mesh', 'mesh', 'mesh'] });
  expect(f.descriptors[0]?.layout).toBe(firstLayout);
});

it('does not cache or count failed creations, and retries through the same owner', () => {
  const f = fixture();
  f.reject(true);
  expect(() => meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 0)).toThrow(f.failure);
  expect(f.counts.createBindGroup).toBe(0);
  f.reject(false);
  const created = meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 0);
  expect(meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 0)).toBe(created);
  expect(f.counts.createBindGroup).toBe(1);
});

it('keys paged storage by its physical page rather than the stable wrapper', () => {
  const f = fixture();
  const first = {} as Buffer;
  const second = {} as Buffer;
  f.storage.pages = { byteStride: 256, byteSize: 32768, buffers: [first, second] };
  const a = meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 0);
  expect(meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 128)).toBe(a);
  const b = meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 256);
  expect(b).not.toBe(a);
  expect(meshSlotBindGroup(f.device, f.state, f.pipeline, f.counts, 384)).toBe(b);
  expect(f.counts.createBindGroup).toBe(2);
  expect(
    findFromChain(f.state.meshBindGroupCache, [f.pipeline.meshBindGroupLayout, second], 'mesh'),
  ).toBe(b);
});
