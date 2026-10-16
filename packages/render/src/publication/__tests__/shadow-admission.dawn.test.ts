import { readFileSync } from 'node:fs';
import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import {
  Camera,
  createRenderPublisher,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type RenderPublication,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  buildEngineShaderManifest,
  publishShaderManifest,
} from '@forgeax/engine-vite-plugin-shader';
import { afterAll, expect, it } from 'vitest';
import { createRenderer } from '../../../../runtime/src/createRenderer';

function required<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

const path = process.env.SHADOW_ADMISSION_SHADER_MANIFEST;
const contents =
  path === undefined
    ? await (async () => {
        const built = await buildEngineShaderManifest();
        return JSON.stringify(
          'toJSON' in built ? built : publishShaderManifest(built.entries, built.materialShaders),
        );
      })()
    : Uint8Array.from(readFileSync(path)).buffer;
const manifestUrl = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
afterAll(() => URL.revokeObjectURL(manifestUrl));

it.each([
  {
    name: 'three cascades',
    cascades: [3, 3, 3, 3, 3, 3],
    gpuEnabled: [true, true, true, true, true, true],
  },
  {
    name: 'changing cascade demand',
    cascades: [3, 1, 4, 1, 3, 2],
    gpuEnabled: [true, true, true, true, true, true],
  },
  {
    name: 'changing mixed legacy geometry consumers',
    cascades: [3, 3, 3, 3, 3, 3],
    gpuEnabled: [true, false, true, false, true, true],
  },
])('matches the explicit CPU lane across $name and dynamic publication changes', async ({
  cascades,
  gpuEnabled,
}) => {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const identity = { source: 'late-shadow-native', epoch: 1 };
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 2, 6], quat: [Math.sin(-0.16), 0, 0, Math.cos(-0.16)] },
      },
      {
        component: Camera,
        data: {
          aspect: 1,
          fov: Math.PI / 3,
          near: 0.1,
          far: 60,
          antialias: 0,
          bloom: 0,
          tonemap: 7,
        },
      },
    )
    .unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -0.8, -1],
        intensity: 3,
        castShadow: true,
        mapSize: 64,
        cascadeCount: 3,
        shadowDistance: 30,
      },
    })
    .unwrap();
  const red = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.8, 0.1, 0.05, 1], roughness: 0.8 }),
  );
  const blue = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.05, 0.1, 0.8, 1], roughness: 0.8 }),
  );
  const spawn = (material = red) =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const floor = spawn(blue);
  world.set(floor, Transform, { pos: [0, -1, 0], scale: [5, 0.2, 5] }).unwrap();
  const caster = spawn();
  const publisher = createRenderPublisher(world, assets, identity);
  const packets: RenderPublication[] = [];
  let added = caster;
  try {
    for (let frame = 0; frame < 6; frame++) {
      world.set(sun, DirectionalLight, { cascadeCount: cascades[frame] as 1 | 2 | 3 | 4 }).unwrap();
      world.set(camera, Transform, { pos: [frame * 0.06, 2, 6] }).unwrap();
      world.set(caster, Transform, { pos: [(frame - 2) * 0.16, 0, 0] }).unwrap();
      if (frame === 1) added = spawn();
      if (frame === 2) world.set(caster, MeshRenderer, { materials: [blue] }).unwrap();
      if (frame === 3) world.despawn(added).unwrap();
      if (frame === 4) added = spawn(blue);
      world.update(1 / 60).unwrap();
      const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
      const packet = structuredClone(candidate.packet);
      candidate.accept();
      packets.push(packet);
      publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    }
  } finally {
    publisher.dispose();
  }
  const run = async (cpu: boolean) => {
    let device: GPUDevice | undefined, texture: GPUTexture | undefined;
    const errors: unknown[] = [];
    const canvas = {
      width: 64,
      height: 64,
      getContext: () => ({
        configure: (options: GPUCanvasConfiguration) => {
          device = options.device;
          device.addEventListener('uncapturederror', (event) => errors.push(event.error));
          texture?.destroy();
          texture = device.createTexture({
            size: [64, 64],
            format: options.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture: () => texture,
      }),
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;
    const renderer = (
      await createRenderer(
        canvas,
        { rhi, publicationSource: identity },
        { shaderManifestUrl: manifestUrl },
      )
    ).unwrap();
    const images: Uint8Array[] = [];
    let shadowClaims = 0;
    let mixedResidualFrames = 0;
    try {
      for (const [frameIndex, original] of packets.entries()) {
        const packet = structuredClone(original);
        const gpuShadow = !cpu && gpuEnabled[frameIndex] === true;
        if (!gpuShadow) {
          for (const template of packet.templates) {
            const row = template.snapshot;
            if (row.shadowCasterPasses !== undefined)
              Object.assign(row, {
                shadowCasterPasses: row.shadowCasterPasses.map((pass) => ({
                  ...pass,
                  gpuDrivenEligible: false,
                })),
              });
          }
        }
        const receipt = required(renderer.draw({ publication: packet }));
        required(await receipt.completed);
        expect(receipt.presentation).toBe('ready');
        const inspection = renderer.inspect();
        const channels = inspection.renderScene.gpuDriven.channels.filter(
          (channel) => channel.viewPass === 'directional-shadow' && channel.lane === 'gpu',
        );
        shadowClaims += channels.reduce((total, channel) => total + channel.claimedDrawCount, 0);
        // The first population starts in the static layer: the final view has
        // no dynamic batch but inherits that layer's admitted GPU draw keys.
        // Logical claims remain observable even when depth is retained/copied.
        if (gpuShadow) {
          const indices = new Set(channels.map((channel) => channel.viewIndex));
          if (frameIndex > 0) {
            // Retain the graph used on the preceding submitted frame until
            // replacement: decreases must not prematurely drop its demand.
            const required = Math.max(cascades[frameIndex] ?? 4, cascades[frameIndex - 1] ?? 4);
            expect([...indices].sort(), JSON.stringify(channels)).toEqual(
              Array.from({ length: required }, (_, index) => index),
            );
          }
          expect(
            Array.from({ length: cascades[frameIndex] ?? 4 }, (_, index) => index).every((index) =>
              indices.has(index),
            ),
            JSON.stringify(inspection.renderScene.gpuDriven.channels),
          ).toBe(true);
          if (packet.revision === 1) {
            for (const channel of channels.filter((value) => value.viewIndex < 3)) {
              expect(channel).toMatchObject({
                drawCount: 2,
                totalDrawCount: 2,
                claimedDrawCount: 2,
                residualDrawCount: 0,
              });
            }
          }
        }
        if (!cpu && channels.some((channel) => channel.residualDrawCount > 0))
          mixedResidualFrames += 1;
        if (device === undefined || texture === undefined)
          throw new Error('missing native surface');
        const buffer = device.createBuffer({
          size: 64 * 256,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [64, 64]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          images.push(new Uint8Array(buffer.getMappedRange().slice(0)));
          buffer.unmap();
        } finally {
          buffer.destroy();
        }
      }
      expect(errors).toEqual([]);
      expect(cpu ? shadowClaims === 0 : shadowClaims > 0).toBe(true);
      // Delta templates change only the updated casters: unchanged floor
      // templates retain their admitted GPU lane, so this case is mixed.
      if (!cpu && gpuEnabled.some((value) => !value))
        expect(mixedResidualFrames).toBeGreaterThan(0);
      return images;
    } finally {
      required(await renderer.dispose());
      texture?.destroy();
    }
  };
  const cpu = await run(true),
    gpu = await run(false);
  expect(gpu).toEqual(cpu);
  expect(gpu[0]?.some((value, index) => index % 4 !== 3 && value > 10)).toBe(true);
  expect(gpu[0]).not.toEqual(gpu[2]);
}, 60_000);
