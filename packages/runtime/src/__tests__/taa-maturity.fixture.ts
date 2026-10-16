import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_TAA,
  Camera,
  DirectionalLight,
  DynamicResolution,
  type FrameReceipt,
  Materials,
  MeshFilter,
  MeshRenderer,
  type RendererOptions,
} from '@forgeax/engine-render';
import { halfToFloat } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { createBarrelRendererFixture } from './barrel-distortion-gpu-fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

// Compile the resolve from authored source, retaining the producer's immutable
// material fleet instead of recompiling thousands of unrelated variants.
const manifest = await buildEngineShaderManifest();
const resolveSource = readFileSync('packages/shader/src/taa-resolve.wgsl', 'utf8');
export async function resolveManifestUrl(source: string) {
  const compiledResolve = (await compileShader(source, { id: 'taa-maturity-resolve' })).unwrap();
  return shaderManifestUrl({
    schemaVersion: manifest.schemaVersion,
    materialShaders: manifest.materialShaders,
    entries: manifest.entries.map((entry) =>
      entry.wgsl.includes('fs_taa_resolve')
        ? {
            ...compiledResolve.manifestEntry,
            glsl: '' as const,
            bindings: JSON.stringify(compiledResolve.bindings),
          }
        : entry,
    ),
  });
}
const sourceManifestUrl = await resolveManifestUrl(resolveSource);

export const ROOT = 'artifacts/taa-maturity';
export const save = (name: string, data: Uint8Array | string) => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(`${ROOT}/${name}`, data);
};
export const json = (name: string, value: unknown) =>
  save(name, `${JSON.stringify(value, null, 2)}\n`);
export const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1];
export const error = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0,
    maximum = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const delta = Math.abs((a[i] ?? 0) - (b[i] ?? 0)) / 255;
    sum += delta;
    maximum = Math.max(maximum, delta);
  }
  return { mean: sum / (a.length * 0.75), maximum };
};

/** Real Standard graph. Only observations and scene inputs live in this carrier. */
export async function scene(
  width: number,
  height: number,
  options: {
    timing?: boolean;
    standardProfile?: RendererOptions['standardProfile'];
    rhi?: RendererOptions['rhi'];
    shaderManifestUrl?: string;
    rhiInstrumentation?: RendererOptions['rhiInstrumentation'];
  } = {},
) {
  const fixture = await createBarrelRendererFixture({
    width,
    height,
    shaderManifestUrl: options.shaderManifestUrl ?? sourceManifestUrl,
    ...(options.rhi === undefined ? {} : { rhi: options.rhi }),
    ...(options.timing ? { gpuPassTiming: {} } : {}),
    ...(options.standardProfile === undefined ? {} : { standardProfile: options.standardProfile }),
    ...(options.rhiInstrumentation === undefined
      ? {}
      : { rhiInstrumentation: options.rhiInstrumentation }),
  });
  const { renderer } = fixture;
  const renderErrors: unknown[] = [];
  const offErrors = renderer.subscribe((event) => {
    if (event.kind === 'error') renderErrors.push(event.error);
  });
  const world = new World();
  const lease = renderValue(renderer.attach(world));
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -2,
          right: 2,
          top: 1.5,
          bottom: -1.5,
          near: 0.1,
          far: 20,
          antialias: 0,
          bloom: 0,
          tonemap: 7,
          clearColor: [0.015, 0.015, 0.015, 1],
        },
      },
    )
    .unwrap();
  const mesh = world.allocSharedRef('MeshAsset', createPlaneGeometry(1, 1).unwrap());
  const moving = [];
  for (let i = 0; i < 36; i++) {
    const angle = (i % 6) * 0.12 + 0.13;
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit([i % 3 === 0 ? 2 : 0.1, i % 3 === 1 ? 1 : 0.1, i % 3 === 2 ? 1 : 0.1, 1]),
    );
    const entity = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [((i % 6) - 2.5) * 0.55, (Math.floor(i / 6) - 2.5) * 0.44, 0],
            scale: [0.017 + (i % 3) * 0.009, 0.39, 1],
            quat: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
          },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    moving.push(entity);
  }
  world
    .spawn({ component: DirectionalLight, data: { direction: [0, 0, -1], intensity: 2 } })
    .unwrap();
  let frame = 0;
  const draw = async (observe = false) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    if (observe)
      renderer.requestObservation && renderValue(renderer.requestObservation(['final-display']));
    const start = performance.now();
    const submitted = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!submitted.ok) {
      json('draw-failure.json', {
        mode: process.env.TAA_MATURITY,
        width,
        height,
        frame,
        error: submitted.error,
        renderErrors,
      });
    }
    const receipt = renderValue(submitted);
    const cpuMs = performance.now() - start;
    renderValue(await receipt.completed);
    frame++;
    return { receipt, cpuMs, frame };
  };
  const display = async (receipt: FrameReceipt) => {
    const observed = renderValue(await renderer.observe(receipt, { include: ['final-display'] }));
    const image = observed.observations?.find((o) => o.domain === 'final-display');
    if (!image) throw new Error('missing completed final-display');
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      rgba.set(
        image.bytes.subarray(
          y * image.metadata.bytesPerRow,
          y * image.metadata.bytesPerRow + width * 4,
        ),
        y * width * 4,
      );
    if (image.metadata.format.startsWith('bgra'))
      for (let i = 0; i < rgba.length; i += 4)
        [rgba[i], rgba[i + 2]] = [rgba[i + 2] ?? 0, rgba[i] ?? 0];
    return rgba;
  };
  const pixels = async () => display((await draw(true)).receipt);
  const hdr = async () => {
    if (!renderer.requestObservation) throw new Error('missing HDR observation');
    renderValue(renderer.requestObservation(['linear-hdr']));
    const { receipt } = await draw();
    const image = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((o) => o.domain === 'linear-hdr');
    if (!image || image.metadata.format !== 'rgba16float')
      throw new Error('missing linear HDR pixels');
    const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
    return Float32Array.from({ length: width * height * 4 }, (_, i) =>
      halfToFloat(
        view.getUint16(
          Math.floor(i / (width * 4)) * image.metadata.bytesPerRow + (i % (width * 4)) * 2,
          true,
        ),
      ),
    );
  };
  const mode = (scale: number | undefined, aa = ANTIALIAS_TAA) => {
    world.set(camera, Camera, { antialias: aa, historyVersion: frame + 1 }).unwrap();
    if (scale === undefined) {
      if (world.hasComponent(camera, DynamicResolution))
        world.removeComponent(camera, DynamicResolution).unwrap();
    } else if (world.hasComponent(camera, DynamicResolution))
      world.set(camera, DynamicResolution, { minScale: scale, maxScale: scale }).unwrap();
    else
      world
        .addComponent(camera, {
          component: DynamicResolution,
          data: { minScale: scale, maxScale: scale },
        })
        .unwrap();
  };
  const dispose = async () => {
    offErrors();
    await renderer.dispose();
    fixture.renderTarget.destroy();
  };
  return {
    ...fixture,
    world,
    lease,
    camera,
    moving,
    mesh,
    draw,
    pixels,
    display,
    hdr,
    mode,
    dispose,
  };
}

/** Independent 4x4 spatial sample reference, never a later TAA frame. */
export function downsample(rgba: Float32Array, width: number, height: number) {
  const low = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < 4; dy++)
          for (let dx = 0; dx < 4; dx++)
            sum += rgba[((y * 4 + dy) * width * 4 + x * 4 + dx) * 4 + c] ?? 0;
        const linear = c === 3 ? sum / 16 : sum / 16 / (1 + sum / 16);
        const encoded =
          c === 3
            ? linear
            : linear <= 0.0031308
              ? 12.92 * linear
              : 1.055 * linear ** (1 / 2.4) - 0.055;
        low[(y * width + x) * 4 + c] = Math.round(255 * encoded);
      }
  return low;
}
