import { Materials } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, material, spawnMesh } from '../../lab/stage';
import { bootWebgl2App, submittedFrames } from '../rhi-backends/support/webgl2-app';
import { inspect, mainChannel, spawnGrid } from './support/scene';

export default defineFeature({
  title: 'CPU capability fallback',
  catalog: 'CPU capability fallback',
  kind: 'probe',
  summary:
    'Ineligible objects (a blended cube here) and backends without compute/storage (the wgpu-webgl2 inset) use CPU/specialized recording; nothing fakes a GPU lane that cannot exist.',
  expect:
    "All checks pass: on WebGPU the opaque grid stays on lane 'gpu' while the blended cube is counted as a CPU fallback draw; the wgpu-webgl2 inset reports GPU Scene 'unsupported', no GPU lane, and still submits frames.",
  async setup({ app, world, frames }) {
    spawnGrid(world);
    const glass = material(
      world,
      Materials.unlit([0.2, 0.9, 1, 0.45], {
        renderState: {
          depthWriteEnabled: false,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        },
        queue: 3000,
      }),
    );
    spawnMesh(world, MESH.cube, glass, { pos: [0, 1.6, 1], scale: [1.4, 1.4, 1.4] });
    await frames(20);
    const inset = await bootWebgl2App();
    return {
      async checks() {
        const checks = new CheckList();
        const { driven } = inspect(app);
        const main = mainChannel(app);
        checks.equal('WebGPU main lane for the opaque grid', main?.lane, 'gpu');
        checks.ok(
          'blended cube recorded on the CPU lane',
          driven.cpuFallbackDrawItems >= 1,
          `cpuFallbackDrawItems=${driven.cpuFallbackDrawItems}`,
        );
        checks.ok(
          'opaque grid still claimed by the GPU lane',
          (main?.claimedDrawCount ?? 0) >= 20,
          JSON.stringify(main),
        );

        checks.ok('wgpu-webgl2 inset boots', inset.ok, inset.ok ? undefined : inset.reason);
        if (!inset.ok) return checks.items;
        const insetFrames = await submittedFrames(inset.app, 10);
        const low = inspect(inset.app);
        checks.equal('inset caps.storageBuffer', low.caps.storageBuffer, false);
        checks.equal('inset GPU Scene status', low.gpu.status, 'unsupported');
        checks.ok(
          'inset has no GPU lane',
          low.driven.channels.every((channel) => channel.lane !== 'gpu'),
          JSON.stringify(
            low.driven.channels.map(
              (channel) => `${channel.viewPass}:${channel.lane}:${channel.reason}`,
            ),
          ),
        );
        checks.ok('inset keeps submitting frames', insetFrames >= 10, `frames=${insetFrames}`);
        return checks.items;
      },
    };
  },
});
