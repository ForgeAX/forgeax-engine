import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { ANTIALIAS_TAA, Camera, MeshFilter, MeshRenderer } from '../components';
import type { RenderFeature } from '../features/types';
import { Materials } from '../materials';
import { computeProjectionMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';

const SIZE = 64;
const SHADER = 'test.post-process-depth';
const SOURCE = /* wgsl */ `
@group(1) @binding(3) var depth: texture_depth_2d;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let sample = textureLoad(depth, vec2i(position.xy), 0);
  return vec4f(sample, select(0.0, 1.0, sample > 0.0), 0.0, 1.0);
}`;

const feature: RenderFeature<undefined> = {
  identity: SHADER,
  placement: 'after-tonemap',
  requiredFullscreenPostProcesses: [{ identity: SHADER, source: SOURCE }],
  extract: () => ok(undefined),
  plan: (_data, context) =>
    ok({
      work: context.views.map((view) => ({
        scope: { view: view.identity },
        resources: [
          {
            kind: 'fullscreen-program',
            name: SHADER,
            source: SOURCE,
            reads: ['input', { key: 'depth', sampleType: 'depth' }],
          },
          {
            kind: 'graphics-program',
            name: 'depth',
            program: {
              shader: SHADER,
              preparePipelines: true,
              vertexLayout: 'none',
              colorFormats: ['rgba16float'],
              sampleCount: 1,
            },
          },
          {
            kind: 'graphics-bindings',
            name: 'depth-input',
            program: 'depth',
            values: { group: 1, fullscreen: true, shader: SHADER, depth: 'depth' },
            logicalTargets: { depth: 'depth' },
          },
        ],
        passes: [
          {
            kind: 'raster',
            name: 'depth-silhouette',
            sceneDepth: 'before-pass',
            colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
            sampledTargets: ['depth'],
            draws: [
              {
                program: 'depth',
                bindings: ['depth-input'],
                vertexData: [],
                vertexLayout: 'none',
                draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
              },
            ],
          },
        ],
      })),
    }),
};

/** The front box face has an independently projected rectangular silhouette. */
function expectedCoverage(projection: 'perspective' | 'orthographic'): Uint8Array {
  const matrix = computeProjectionMatrix(
    {
      projection,
      fov: 1,
      aspect: 1,
      near: 0.1,
      far: 100,
      orthoLeft: -2,
      orthoRight: 2,
      orthoBottom: -2,
      orthoTop: 2,
    } as CameraSnapshot,
    mat4.create(),
  );
  const w = (matrix[11] ?? 0) * -4.9 + (matrix[15] ?? 0);
  const px = (x: number) => ((((matrix[0] ?? 0) * (x - 0.11)) / w + 1) * SIZE) / 2;
  const py = (y: number) => ((1 - ((matrix[5] ?? 0) * (y - 0.03)) / w) * SIZE) / 2;
  const left = px(-0.65),
    right = px(0.65),
    top = py(0.65),
    bottom = py(-0.65);
  return Uint8Array.from({ length: SIZE * SIZE }, (_, index) => {
    const x = (index % SIZE) + 0.5,
      y = Math.floor(index / SIZE) + 0.5;
    return Number(x > left && x < right && y > top && y < bottom);
  });
}

/** Exercise real Standard geometry and after-tonemap depth through 60 jittered frames. */
export async function verifyPostProcessDepth(url = '/shaders/manifest.json') {
  let native: GPUDevice | undefined, target: GPUTexture | undefined;
  const failures: unknown[] = [];
  const context = {
    configure(descriptor: GPUCanvasConfiguration) {
      native = descriptor.device;
      native.addEventListener('uncapturederror', (event) => failures.push(event.error.message));
      target?.destroy();
      target = native.createTexture({
        size: [SIZE, SIZE],
        format: descriptor.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: descriptor.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      if (target === undefined) throw new Error('Missing GPU surface');
      return target;
    },
    unconfigure() {},
  };
  const host = await createRenderer(
    {
      width: SIZE,
      height: SIZE,
      getContext: (kind: string) => (kind === 'webgpu' ? context : null),
    },
    { features: [feature] },
    { shaderManifestUrl: url },
    { rhi, createShaderModule: (device, descriptor) => rhi.createShaderModule(device, descriptor) },
  );
  host.onError((error) => failures.push(error));
  const initialized = await host.initialization;
  if (!initialized.ok) {
    await host.dispose();
    throw initialized.error;
  }
  const renderer = exposeRenderer(host);
  const observations: { projection: string; frames: number }[] = [];
  try {
    const assets = host.assetRegistry,
      world = new World({ assets });
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const lease = attachment.value;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0.11, 0.03, 5] } },
        {
          component: Camera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_TAA,
            left: -2,
            right: 2,
            bottom: -2,
            top: 2,
          },
        },
      )
      .unwrap();
    const mesh = assets.create(createBoxGeometry(1.3, 1.3, 0.2).unwrap()).unwrap();
    const material = assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    for (const [projection, code] of [
      ['perspective', 0],
      ['orthographic', 1],
    ] as const) {
      world.set(camera, Camera, { projection: code }).unwrap();
      const expected = expectedCoverage(projection);
      let frames = 0;
      let pending: unknown;
      const deadline = performance.now() + 45_000;
      while (frames < 60 && performance.now() < deadline) {
        world.update(1 / 60).unwrap();
        const drawn = renderer.draw({ source: lease, camera: { entityKey: camera } });
        if (!drawn.ok) throw new Error(JSON.stringify({ draw: drawn.error, failures }));
        const receipt = drawn.value;
        const completed = await receipt.completed;
        if (!completed.ok) throw completed.error;
        if (receipt.presentation !== 'ready') {
          pending = receipt.presentationPendingReason;
          await new Promise((resolve) => setTimeout(resolve, 16));
          continue;
        }
        if (native === undefined || target === undefined) throw new Error('Missing GPU surface');
        const buffer = native.createBuffer({
          size: SIZE * 256,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
          const encoder = native.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [
            SIZE,
            SIZE,
          ]);
          native.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const pixels = new Uint8Array(buffer.getMappedRange());
          for (const [index, coverage] of expected.entries()) {
            if (pixels[index * 4 + 1] !== coverage * 255)
              throw new Error(
                `${projection} frame ${frames}: depth silhouette differs at ${index % SIZE},${Math.floor(index / SIZE)}; expected=${coverage * 255}, actual=${pixels[index * 4 + 1]}; ${JSON.stringify({ channelMax: [0, 1, 2, 3].map((channel) => Math.max(...pixels.filter((_value, pixel) => pixel % 4 === channel))), failures })}`,
              );
          }
          buffer.unmap();
        } finally {
          buffer.destroy();
        }
        frames++;
      }
      if (frames !== 60) throw new Error(JSON.stringify({ projection, frames, pending, failures }));
      if (failures.length) throw new Error(JSON.stringify(failures));
      observations.push({ projection, frames });
    }
    return observations;
  } finally {
    await renderer.dispose().then((result) => {
      if (!result.ok) throw result.error;
    });
    target?.destroy();
  }
}
