import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import {
  cloneOwnedRenderFeaturePlanSignatureSnapshot,
  cloneRenderFeaturePlanSignatureSnapshot,
  type RenderFeaturePlanSignatureSnapshot,
  type RenderFeatureWorkPlan,
} from '../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { RenderFeatureComputeGraphProjection } from '../features/render-graph-compute';
import { nativeDeviceFixture } from './native-device-fixture';

const wgsl = (value: number) => `${'// primitive token evidence\n'.repeat(1000)}
@group(0) @binding(0) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(1) fn main() { output[0] = ${value}u; }`;
const declarations = [
  { entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] },
];

// Actual native compute/graph/readback verifies text replacement and retired
// resources. This is a signature/prepare component, not a full Game VFX kernel
// or a performance measurement of the complete Renderer.
it('keeps Native outputs and private Host signatures exact through shared, retired and changed programs', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({
      createShaderModule: (descriptor) => createShaderModuleImmediate(device, descriptor),
    }),
  });
  const host = createRenderFeatureHost([
    { identity: 'token-native', extract: () => ok(undefined), plan: () => ok({ work: [] }) },
  ]).unwrap();
  const session = owner.beginFeature('token-native', 0);
  const readback = device.createBuffer({ size: 16, usage: 1 | 8 }).unwrap();
  let previous: RenderFeaturePlanSignatureSnapshot | undefined;
  try {
    const sequences = [
      [
        ['a', 1],
        ['b', 1],
        ['c', 2],
        ['d', 2],
      ],
      [
        ['b', 1],
        ['c', 2],
        ['d', 2],
      ],
      [
        ['b', 1],
        ['c', 7],
        ['d', 2],
      ],
      [
        ['e', 3],
        ['f', 4],
        ['g', 5],
        ['h', 6],
      ],
    ] as const;
    let firstFrame = true;
    for (const rows of sequences) {
      const plan: RenderFeatureWorkPlan = {
        resources: rows.map(([name, value]) => ({
          kind: 'compute-program',
          name,
          program: { wgsl: wgsl(value), entryPoints: ['main'], bindings: declarations },
        })),
        passes: [],
      };
      const actual = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan, previous);
      expect(actual).toEqual(cloneRenderFeaturePlanSignatureSnapshot(plan, previous));
      previous = actual;
      const signature = host.recordPlanSignature?.('token-native', plan, 'left');
      expect(signature).toBeDefined();
      expect(host.recordPlanSignature?.('token-native', plan, 'left')).toBe(signature);
      expect(host.recordPlanSignature?.('token-native', plan, 'right')).toBeDefined();
      if (!firstFrame) session.beginFrame();
      firstFrame = false;
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      const projection = new RenderFeatureComputeGraphProjection(graph);
      const buffers = rows.map(([name, value]) => {
        const program = session
          .prepareProgram(name, {
            wgsl: wgsl(value),
            entryPoints: ['main'],
            bindings: declarations,
          })
          .unwrap();
        const buffer = session
          .prepareBuffer(`${name}.output`, { size: 4, usage: ['storage', 'copy-src'] })
          .unwrap();
        const bindings = session
          .prepareBindings(`${name}.bindings`, { program, entries: [{ binding: 0, buffer }] })
          .unwrap();
        const resolved = session
          .resolveComputePass('token-native', {
            program,
            bindings,
            dispatches: [{ entryPoint: 'main', workgroups: [1, 1, 1] }],
          })
          .unwrap();
        projection
          .addPasses([
            {
              name: `${name}.compute`,
              featureIdentity: 'token-native',
              order: 0,
              resolvedGpuCompute: resolved,
            },
          ])
          .unwrap();
        const physical = session.resolveBuffer(buffer);
        if (physical === undefined) throw new Error('Missing Native signature output');
        return physical.buffer;
      });
      const leases = session.commitFrame();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      try {
        const encoder = device.createCommandEncoder().unwrap();
        compiled.execute({ encoder }).unwrap();
        buffers.forEach((buffer, index) => {
          encoder.copyBufferToBuffer(buffer, 0, readback, index * 4, 4);
        });
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        const mapped = (await readback.mapAsync(1)).unwrap();
        const values = new Uint32Array(
          mapped
            .getMappedRange()
            .unwrap()
            .slice(0, rows.length * 4),
        );
        mapped.unmap();
        expect([...values]).toEqual(rows.map(([, value]) => value));
      } finally {
        await compiled.retire();
        for (const lease of leases) lease.release().unwrap();
      }
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    host.dispose().unwrap();
    owner.dispose().unwrap();
    device.destroyBuffer(readback).unwrap();
    native.destroy();
  }
});
