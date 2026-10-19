import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { type Buffer, err, RhiError } from '@forgeax/engine-rhi';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { constructRuntimeRendererHost } from '../renderer-host';

it('discards a prepared recovery graph after its probe fails and recovers on retry', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  let signalLoss: (() => void) | undefined;
  let devices = 0;
  let rejectedProbe = false;
  const candidateBuffers = new Map<Buffer, string>();
  let bufferCount = 0;
  const created = await constructRuntimeRendererHost(
    canvas,
    {
      rhiInstrumentation: {
        deviceLost(device) {
          const index = devices++;
          if (index === 1) {
            const createBuffer = device.createBuffer.bind(device);
            device.createBuffer = (descriptor) => {
              const result = createBuffer(descriptor);
              // Persistent projection tables have explicit candidate ownership.
              // Fixed bootstrap buffers belong to the backend device lifetime.
              if (result.ok && descriptor.label?.startsWith('gpu-scene-')) {
                const key = `${descriptor.label ?? 'buffer'}:${++bufferCount}`;
                candidateBuffers.set(result.value, key);
              }
              return result;
            };
            const destroyBuffer = device.destroyBuffer.bind(device);
            device.destroyBuffer = (buffer) => {
              const result = destroyBuffer(buffer);
              if (result.ok) candidateBuffers.delete(buffer);
              return result;
            };
            const createEncoder = device.createCommandEncoder.bind(device);
            device.createCommandEncoder = (descriptor) => {
              if (descriptor?.label === 'renderer-recovery-graph-probe.encoder') {
                rejectedProbe = true;
                return err(
                  new RhiError({
                    code: 'webgpu-runtime-error',
                    expected: 'the candidate device probe encoder to be available',
                    hint: 'injected candidate probe failure after graph preparation',
                  }),
                );
              }
              return createEncoder(descriptor);
            };
          }
          return new Promise((resolve) => {
            if (index === 0)
              signalLoss = () =>
                resolve({ reason: 'unknown', message: 'candidate discard regression' });
          });
        },
      },
    },
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!created.ok) throw created.error;
  const { renderer } = created.value;
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin()]);
  try {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1 }) },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: {
          castShadow: true,
          mapSize: testQuality.shadowMapSize,
          cascadeCount: testQuality.cascadeCount,
          direction: [0, -1, -1],
        },
      })
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    const lease = renderer.attach(world).unwrap();
    const draw = async () => {
      world.update(1 / 60).unwrap();
      const receipt = renderer
        .draw({ leases: [lease], camera: { lease }, environment: { lease } })
        .unwrap();
      (await receipt.completed).unwrap();
      return receipt;
    };
    expect((await draw()).deviceGeneration).toBe(0);
    expect(signalLoss).toBeTypeOf('function');
    signalLoss?.();
    await expect.poll(() => renderer.state()).toBe('device-lost');
    const failed = await renderer.recover();
    expect(rejectedProbe, JSON.stringify(failed)).toBe(true);
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('the armed device probe must reject recovery');
    expect(JSON.stringify(failed.error)).toContain('injected candidate probe failure');
    expect(JSON.stringify(failed.error)).not.toContain('read only property');
    expect(renderer.state()).toBe('device-lost');
    expect(bufferCount).toBeGreaterThan(0);
    expect([...candidateBuffers.values()]).toEqual([]);
    const recovered = await renderer.recover();
    expect(recovered.ok, recovered.ok ? '' : JSON.stringify(recovered.error)).toBe(true);
    expect((await draw()).deviceGeneration).toBe(1);
    expect(renderer.state()).toBe('alive');
  } finally {
    await renderer.dispose();
    await context.fiber.dispose();
    canvas.remove();
  }
}, 120_000);
