import { readFileSync } from 'node:fs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  createRenderPublisher,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  buildEngineShaderManifest,
  publishShaderManifest,
} from '@forgeax/engine-vite-plugin-shader';
import { expect, it, vi } from 'vitest';
import { installDefaultAssetDecoders } from '../asset-contributions';
import { createRenderer } from '../createRenderer';
import { testAssets } from './helpers/runtime-assets';

function required<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

// Shader preparation is a file prerequisite, as in the maintained Native gate.
const manifestPath = process.env.SHADOW_ADMISSION_SHADER_MANIFEST;
const contents =
  manifestPath === undefined
    ? await (async () => {
        const built = await buildEngineShaderManifest();
        return JSON.stringify(
          'toJSON' in built ? built : publishShaderManifest(built.entries, built.materialShaders),
        );
      })()
    : Uint8Array.from(readFileSync(manifestPath)).buffer;

it('shares physical mesh writes across CPU and GPU shadows while preserving material publication', async () => {
  const manifestUrl = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  installDefaultAssetDecoders(assets);
  const world = new World({ assets });
  const identity = { source: 'shadow-legacy-mesh-consumer', epoch: 1 };
  world
    .spawn(
      { component: Transform, data: { pos: [0, 2, 6] } },
      {
        component: Camera,
        data: { aspect: 1, near: 0.1, far: 60, antialias: 0, bloom: 0, tonemap: 7 },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -0.8, -1],
        castShadow: true,
        mapSize: 64,
        cascadeCount: 3,
        shadowDistance: 30,
      },
    })
    .unwrap();
  const material = testAssets(world)
    .create(Materials.standard({ baseColor: [0.8, 0.1, 0.05, 1] }))
    .unwrap();
  const secondMaterial = testAssets(world)
    .create(Materials.standard({ baseColor: [0.1, 0.1, 0.8, 1] }))
    .unwrap();
  for (let index = 0; index < 2; index++)
    world
      .spawn(
        { component: Transform, data: { pos: [index, 0, 0] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world)
              .create(createBoxGeometry(1, 1, 1).unwrap())
              .unwrap(),
          },
        },
        { component: MeshRenderer, data: { materials: [index === 0 ? material : secondMaterial] } },
      )
      .unwrap();
  world.update(1 / 60).unwrap();
  const publisher = createRenderPublisher(world, assets, identity);
  const prepared = publisher.prepare(world.getResource(Time).elapsed).unwrap();
  const source = structuredClone(prepared.packet);
  prepared.accept();
  const run = async (lane: 'cpu' | 'mixed' | 'reason' | 'gpu') => {
    const labels = new Map<Buffer, string>();
    const writes: { label: string; bytes: number; payload: number[] }[] = [];
    const restores: Array<() => void> = [];
    let device: RhiDevice | undefined;
    const provider: typeof rhi = {
      ...rhi,
      requestAdapter: async (...args) => {
        const result = await rhi.requestAdapter(...args);
        if (!result.ok) return result;
        const original = result.value.requestDevice.bind(result.value);
        const observer = vi
          .spyOn(result.value, 'requestDevice')
          .mockImplementation(async (...options) => {
            const obtained = await original(...options);
            if (!obtained.ok) return obtained;
            device = obtained.value;
            const create = device.createBuffer.bind(device);
            const allocation = vi.spyOn(device, 'createBuffer').mockImplementation((descriptor) => {
              const created = create(descriptor);
              if (created.ok && descriptor.label !== undefined)
                labels.set(created.value, descriptor.label);
              return created;
            });
            const write = device.queue.writeBuffer.bind(device.queue);
            const upload = vi
              .spyOn(device.queue, 'writeBuffer')
              .mockImplementation((target, offset, data, dataOffset, size) => {
                const bytes = size ?? data.byteLength - (dataOffset ?? 0);
                const payload = ArrayBuffer.isView(data)
                  ? new Uint8Array(data.buffer, data.byteOffset + (dataOffset ?? 0), bytes)
                  : new Uint8Array(data, dataOffset ?? 0, bytes);
                writes.push({ label: labels.get(target) ?? '', bytes, payload: [...payload] });
                return write(target, offset, data, dataOffset, size);
              });
            restores.push(() => {
              allocation.mockRestore();
              upload.mockRestore();
            });
            return obtained;
          });
        restores.push(() => observer.mockRestore());
        return result;
      },
    };
    const canvas = { width: 64, height: 64 } as HTMLCanvasElement;
    let renderer: ReturnType<Awaited<ReturnType<typeof createRenderer>>['unwrap']> | undefined;
    try {
      renderer = (
        await createRenderer(
          canvas,
          { rhi: provider, publicationSource: identity },
          { shaderManifestUrl: manifestUrl },
        )
      ).unwrap();
      const packet = structuredClone(source);
      let disabled = 0;
      if (lane !== 'gpu')
        for (const material of packet.materials)
          if (lane === 'cpu' || lane === 'reason' || disabled++ === 0)
            Object.assign(material.value, {
              passes: material.value.passes.map((pass) =>
                (pass.renderState?.tags as { LightMode?: string } | undefined)?.LightMode ===
                'ShadowCaster'
                  ? {
                      ...pass,
                      renderState: {
                        ...pass.renderState,
                        ...(lane === 'reason'
                          ? { blend: { color: {}, alpha: {} } }
                          : { stencil: {} }),
                      },
                    }
                  : pass,
              ),
            });
      writes.length = 0;
      const receipt = required(renderer.draw({ publication: packet }));
      required(await receipt.completed);
      expect(receipt.presentation).toBe('ready');
      const channels = renderer
        .inspect()
        .renderScene.gpuDriven.channels.filter(
          (channel) => channel.viewPass === 'directional-shadow' && channel.lane === 'gpu',
        );
      expect(channels.length > 0).toBe(lane === 'mixed' || lane === 'gpu');
      const meshBytes = writes
        .filter((write) => write.label === 'pbr-mesh-ssbo')
        .reduce((sum, write) => sum + write.bytes, 0);
      const materialBytes = writes
        .filter((write) => write.label === 'pbr-material-ubo')
        .reduce((sum, write) => sum + write.bytes, 0);
      expect(device).toBeDefined();
      const materialPayloads = writes
        .filter((write) => write.label === 'pbr-material-ubo')
        .map((write) => write.payload);
      return { meshBytes, materialBytes, materialPayloads };
    } finally {
      try {
        if (renderer !== undefined) required(await renderer.dispose());
      } finally {
        for (const restore of restores.reverse()) restore();
      }
    }
  };
  try {
    const cpu = await run('cpu'),
      mixed = await run('mixed'),
      reason = await run('reason'),
      gpu = await run('gpu');
    // Main and shadow share each physical source slot, including direct residuals.
    expect(cpu.meshBytes).toBe(2 * 256);
    expect(mixed.meshBytes).toBe(256);
    expect(reason.meshBytes).toBe(cpu.meshBytes);
    expect(gpu.meshBytes).toBe(0);
    expect(gpu.materialBytes).toBe(cpu.materialBytes);
    expect(mixed.materialPayloads).toEqual(cpu.materialPayloads);
    expect(reason.materialPayloads).toEqual(cpu.materialPayloads);
    expect(gpu.materialPayloads).toEqual(cpu.materialPayloads);
    expect(gpu.materialBytes).toBeGreaterThan(0);
  } finally {
    publisher.dispose();
    URL.revokeObjectURL(manifestUrl);
  }
}, 30_000);
