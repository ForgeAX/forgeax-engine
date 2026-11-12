import { mkdirSync, writeFileSync } from 'node:fs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Transform } from '@forgeax/engine-scene';
import type { AssetKind } from '@forgeax/engine-types';
import {
  buildEngineShaderManifest,
  publishShaderManifest,
} from '@forgeax/engine-vite-plugin-shader';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { model } from '../model';
import { sel } from '../selectors';

const SIZE = 192;
const manifest = await buildEngineShaderManifest();
const manifestUrl = URL.createObjectURL(
  new Blob(
    [
      JSON.stringify(
        'toJSON' in manifest
          ? manifest
          : publishShaderManifest(manifest.entries, manifest.materialShaders),
      ),
    ],
    { type: 'application/json' },
  ),
);

/** Rotation that turns the camera's -Z forward axis toward `target` (yaw about Y, then pitch). */
function lookAt(
  eye: [number, number, number],
  target: [number, number, number],
): [number, number, number, number] {
  const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const l = Math.hypot(d[0] as number, d[1] as number, d[2] as number);
  const [x, y, z] = d.map((c) => c / l) as [number, number, number];
  const yaw = Math.atan2(-x, -z);
  const pitch = Math.asin(y);
  const [sy, cy, sp, cp] = [
    Math.sin(yaw / 2),
    Math.cos(yaw / 2),
    Math.sin(pitch / 2),
    Math.cos(pitch / 2),
  ];
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}

function panel(sharp: boolean) {
  const m = model();
  m.box({ size: [1.4, 0.9, 0.9], tag: 'shell' });
  m.inset(sel.tag('shell').and(sel.facing('+z')).one(), {
    thickness: 0.12,
    region: 'merged',
    label: 'panel',
  });
  m.extrude(sel.createdBy('panel', 'inner'), {
    distance: -0.15,
    region: 'merged',
    label: 'recess',
  });
  m.extrude(sel.facing('+y'), { distance: 0.25, region: 'merged', label: 'cap' });
  if (sharp) m.markSharp(sel.edges.dihedral('>', 40));
  m.uv.project({ mode: 'box', scale: 1 });
  const out = m.toMesh({ normals: { mode: sharp ? 'weighted' : 'smooth' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

async function readPixels(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * SIZE, usage: 0x0001 | 0x0008 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: SIZE }, [
    SIZE,
    SIZE,
    1,
  ]);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buffer.mapAsync(0x0001);
  const padded = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const out = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + SIZE * 4), y * SIZE * 4);
  return out;
}

function changedPixels(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d =
      Math.abs((a[i] as number) - (b[i] as number)) +
      Math.abs((a[i + 1] as number) - (b[i + 1] as number)) +
      Math.abs((a[i + 2] as number) - (b[i + 2] as number));
    if (d > 6) n++;
  }
  return n;
}

describe('modeling output on the real renderer (Dawn)', () => {
  it('renders the exported mesh, and sharp-edge intent changes the shading', {
    timeout: 120000,
  }, async () => {
    let device: GPUDevice | undefined;
    let target: GPUTexture | undefined;
    const gpu = globalThis.navigator.gpu;
    const requestAdapter = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (options) => {
      const adapter = await requestAdapter(options);
      if (adapter === null) return adapter;
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (descriptor) => {
        const created = await requestDevice(descriptor);
        device ??= created;
        return created;
      };
      return adapter;
    };
    const canvas = {
      width: SIZE,
      height: SIZE,
      getContext: () => ({
        configure(options: GPUCanvasConfiguration) {
          target ??= options.device.createTexture({
            size: [SIZE, SIZE],
            format: options.format,
            usage: 0x11,
            viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture: () => target,
      }),
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;
    let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
    try {
      host = await constructRuntimeRendererHost(canvas, {}, { shaderManifestUrl: manifestUrl });
    } finally {
      gpu.requestAdapter = requestAdapter;
    }
    if (!host.ok) throw host.error;
    const { renderer } = host.value;
    try {
      const world = new World();
      const assets = new AssetRegistry();
      for (const contribution of defaultAssetDecoderContributions)
        assets.installDecoder(contribution.kind as AssetKind<unknown>, contribution.decoder);
      world.bindAssets(assets).unwrap();
      const attached = renderer.attach(world);
      if (!attached.ok) throw attached.error;
      const material = assets
        .create({
          kind: 'material',
          passes: [
            {
              name: 'Forward',
              program: { module: 'forgeax::default-standard-pbr' },
              renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
            },
          ],
          values: { baseColor: [0.85, 0.55, 0.2], metallic: 0, roughness: 0.45 },
        })
        .unwrap();
      const sharp = assets.create(panel(true)).unwrap();
      const smooth = assets.create(panel(false)).unwrap();
      world
        .spawn({
          component: DirectionalLight,
          data: { direction: [-0.5, -0.7, -0.6], color: [1, 1, 1], intensity: 2.5 },
        })
        .unwrap();
      world
        .spawn(
          {
            component: Transform,
            data: { pos: [1.6, 1.2, 3.2], quat: lookAt([1.6, 1.2, 3.2], [0, 0.1, 0]) },
          },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 50 } as never },
        )
        .unwrap();
      const frame = async () => {
        world.update(1 / 60).unwrap();
        const lease = attached.value;
        for (let i = 0; i < 3; i++) {
          await drawReadyFrame(renderer, {
            leases: [lease],
            camera: { lease },
            environment: { lease },
          });
        }
        if (device === undefined || target === undefined) throw new Error('device not captured');
        return readPixels(device, target);
      };
      const empty = await frame();
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: sharp } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
      const hard = await frame();
      world.set(entity, MeshFilter, { assetHandle: smooth } as never);
      const soft = await frame();
      const directory = 'artifacts/modeling/dawn';
      mkdirSync(directory, { recursive: true });
      for (const [name, pixels] of [
        ['empty', empty],
        ['sharp', hard],
        ['smooth', soft],
      ] as const) {
        const png = new PNG({ width: SIZE, height: SIZE });
        png.data.set(pixels);
        for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
        writeFileSync(`${directory}/${name}.png`, PNG.sync.write(png));
      }
      expect(changedPixels(empty, hard)).toBeGreaterThan(SIZE * SIZE * 0.05);
      expect(changedPixels(hard, soft)).toBeGreaterThan(SIZE * SIZE * 0.005);
      expect(renderer.inspect().state).toBe('alive');
    } finally {
      await renderer.dispose();
    }
  });
});
