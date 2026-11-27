import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { clusterViewBindings, getOrCreateHdrpBuffers, resetHdrpBuffers } from '../hdrp-buffers';
import type { RenderSystemRuntime } from '../record/render-context';
import { STANDARD_CLUSTER_TEST_ABI } from './cluster-test-abi';

it('binds the current Standard cluster allocation through View', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const fire = vi.fn();
  const runtime = {
    device,
    standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
    errorRegistry: { fire },
  } as unknown as RenderSystemRuntime;
  const grid = { x: 32, y: 16, z: 32 };
  const prepared = getOrCreateHdrpBuffers(runtime, grid);
  if (prepared?.kind !== 'storage') throw new Error('Expected Standard storage allocation');
  const entries = clusterViewBindings(prepared);
  expect(entries.map(({ binding }) => binding)).toEqual([30, 31, 32, 33]);
  expect(entries.map(({ resource }) => resource)).toEqual(
    [
      prepared.lightDataBuffer,
      prepared.clusterGridBuffer,
      prepared.lightIndexListBuffer,
      prepared.clusterUniformBuffer,
    ].map((buffer) => ({ kind: 'buffer', value: { buffer } })),
  );
  expect(getOrCreateHdrpBuffers(runtime, grid)).toBe(prepared);
  expect(fire).not.toHaveBeenCalled();
  resetHdrpBuffers(runtime);
});
