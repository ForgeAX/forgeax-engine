import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../../renderer-host';
import { shaderManifestUrl } from '../shader-manifest-url.fixture';

const WIDTH = 64;
const HEIGHT = 64;
const CLEAR_USAGE = 0x10 | 0x01;
const MAP_READ = 0x0001;
const COPY_DST = 0x0008;
const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);
const LIGHTWEIGHT_DAWN = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';

interface AlphaCase {
  readonly caseId: string;
  readonly mode: 'OPAQUE' | 'MASK' | 'BLEND';
  readonly baseAlpha: number;
  readonly cutoff?: number;
  readonly baseColor: readonly [number, number, number, number];
  readonly textureColor?: readonly [number, number, number, number];
  readonly clear: readonly [number, number, number, number];
}

const CASES: readonly AlphaCase[] = [
  {
    caseId: 'material-alpha-rgba-factor',
    mode: 'OPAQUE',
    baseAlpha: 0.4,
    baseColor: [0.8, 0.2, 0.1, 1],
    textureColor: [1, 1, 1, 0.35],
    clear: [0, 0, 0, 0],
  },
  {
    caseId: 'material-alpha-mask-default',
    mode: 'MASK',
    baseAlpha: 0.49,
    cutoff: 0.5,
    baseColor: [1, 1, 1, 1],
    clear: [0, 0, 0, 0],
  },
  {
    caseId: 'material-alpha-mask-explicit',
    mode: 'MASK',
    baseAlpha: 0.6,
    cutoff: 0.25,
    baseColor: [1, 0.2, 0.1, 1],
    clear: [0, 0, 0, 0],
  },
  {
    caseId: 'material-alpha-mask-zero',
    mode: 'MASK',
    baseAlpha: 0.75,
    cutoff: 0,
    baseColor: [1, 0.2, 0.1, 1],
    clear: [0, 0, 0, 0],
  },
  {
    caseId: 'material-alpha-mask-one',
    mode: 'MASK',
    baseAlpha: 0.99,
    cutoff: 1,
    baseColor: [1, 0.2, 0.1, 1],
    clear: [0, 0, 0, 0],
  },
  {
    caseId: 'material-alpha-mask-equal',
    mode: 'MASK',
    baseAlpha: 0.5,
    cutoff: 0.5,
    baseColor: [1, 0.2, 0.1, 1],
    clear: [0, 0, 0, 0],
  },
  {
    caseId: 'material-alpha-blend',
    mode: 'BLEND',
    baseAlpha: 1,
    baseColor: [0.8, 0.2, 0.1, 1],
    textureColor: [1, 1, 1, 0.4],
    clear: [0.2, 0.4, 0.6, 1],
  },
];

const DAWN_CASES = LIGHTWEIGHT_DAWN
  ? CASES.filter((testCase) =>
      [
        'material-alpha-rgba-factor',
        'material-alpha-mask-explicit',
        'material-alpha-blend',
      ].includes(testCase.caseId),
    )
  : CASES;

function textureBytes(color: readonly [number, number, number, number]): Uint8Array {
  return Uint8Array.from(color.map((channel) => Math.round(channel * 255)));
}

function makeTexture(color: readonly [number, number, number, number]): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm-srgb',
    data: textureBytes(color),
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}

async function readCenter(
  device: GPUDevice,
  target: GPUTexture,
): Promise<[number, number, number, number]> {
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: MAP_READ | COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const offset = Math.floor(HEIGHT / 2) * bytesPerRow + Math.floor(WIDTH / 2) * 4;
  return [
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  ];
}

async function captureCase(testCase: AlphaCase): Promise<[number, number, number, number]> {
  if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function')
    throw new Error('dawn-node WebGPU unavailable');
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const original = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
  globalThis.navigator.gpu.requestAdapter = async (options) => {
    const adapter = await original(options);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const next = await requestDevice(descriptor);
      device ??= next;
      return next;
    };
    return adapter;
  };
  const canvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          target ??= desc.device.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: desc.format ?? 'rgba8unorm',
            usage: CLEAR_USAGE,
            viewFormats: ['rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          if (target === undefined) throw new Error('render target was not configured');
          return target;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
  try {
    host = await constructRuntimeRendererHost(
      canvas,
      {},
      {
        shaderManifestUrl: ENGINE_MANIFEST_URL,
      },
    );
  } finally {
    globalThis.navigator.gpu.requestAdapter = original;
  }
  expect(host.ok).toBe(true);
  if (!host.ok || device === undefined) throw new Error('runtime Dawn renderer not ready');
  const { renderer } = host.value;
  expect(renderer.inspect().state).toBe('alive');

  try {
    const world = new World();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const plane = createPlaneGeometry(2.8, 2.8);
    expect(plane.ok).toBe(true);
    if (!plane.ok) throw new Error('plane creation failed');
    const meshHandle = world.allocSharedRef('MeshAsset', plane.value);
    const texture =
      testCase.textureColor === undefined ? undefined : makeTexture(testCase.textureColor);
    const textureHandle =
      texture === undefined ? undefined : world.allocSharedRef('TextureAsset', texture);
    // The renderer-owned record stage derives GPU residency from this world
    // asset. No renderer store upload is part of the public contract.
    const renderState =
      testCase.mode === 'BLEND'
        ? {
            cullMode: 'none' as const,
            depthWriteEnabled: false,
            blend: {
              color: {
                srcFactor: 'src-alpha' as const,
                dstFactor: 'one-minus-src-alpha' as const,
                operation: 'add' as const,
              },
              alpha: {
                srcFactor: 'one' as const,
                dstFactor: 'one-minus-src-alpha' as const,
                operation: 'add' as const,
              },
            },
          }
        : { cullMode: 'none' as const };
    const material = Materials.standard({
      baseColor: Materials.srgb([
        testCase.baseColor[0],
        testCase.baseColor[1],
        testCase.baseColor[2],
        testCase.baseAlpha,
      ]),
      metallic: 0,
      roughness: 1,
      queue: testCase.mode === 'BLEND' ? 3000 : testCase.mode === 'MASK' ? 2450 : 2000,
      renderState,
      ...(textureHandle === undefined
        ? {}
        : { baseColorTexture: { texture: textureHandle as never } }),
      ...(testCase.mode === 'MASK' && testCase.cutoff !== undefined
        ? { alphaCutoff: testCase.cutoff }
        : {}),
    });
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1] } },
      {
        component: Camera,
        data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 10, clearColor: testCase.clear },
      },
    );
    world.spawn({
      component: DirectionalLight,
      data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
    });
    world.update().unwrap();
    const drawn = renderer.draw({
      leases: [attachment.value],
      camera: { lease: attachment.value },
      environment: { lease: attachment.value },
    });
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) throw new Error(`draw failed: ${drawn.error.code}`);
    await device.queue.onSubmittedWorkDone();
    if (target === undefined) throw new Error('runtime Dawn render target not configured');
    return await readCenter(device, target);
  } finally {
    const disposed = await renderer.dispose();
    target?.destroy();
    expect(disposed.ok).toBe(true);
  }
}

function expectedVisible(testCase: AlphaCase): boolean {
  const alpha = testCase.baseAlpha * (testCase.textureColor?.[3] ?? 1);
  return (
    testCase.mode !== 'MASK' || (testCase.cutoff ?? 0.5) <= 0 || alpha > (testCase.cutoff ?? 0.5)
  );
}

describe('M2 runtime PBR alpha readback', () => {
  // The browser parity gate still closes all seven alpha cases. Dawn keeps
  // one opaque, one mask, and one blend boundary on overloaded PR runners;
  // local/nightly runs retain the complete threshold matrix.
  for (const testCase of DAWN_CASES) {
    it(`${testCase.caseId}: Materials.standard single draw is observable`, async () => {
      const actual = await captureCase(testCase);
      const expected = testCase.clear.map((channel) => Math.round(channel * 255));
      const isClear = actual.every(
        (channel, index) => Math.abs(channel - (expected[index] ?? 0)) <= 3,
      );
      expect(isClear, `${testCase.caseId} first draw clear state`).toBe(!expectedVisible(testCase));
      if (expectedVisible(testCase)) expect(actual).not.toEqual(expected);
    }, 60_000);
  }
});
