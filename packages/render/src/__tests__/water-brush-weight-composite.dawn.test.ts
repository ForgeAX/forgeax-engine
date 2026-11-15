import type { Buffer, RhiCommandEncoder, RhiDevice, TextureView } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import type { WaterBrushTerrainManifest } from '@forgeax/engine-water';
import { expect, it } from 'vitest';
import {
  executeWaterBrushWeightComposite,
  type WaterBrushWeightCompositeExecution,
  type WaterBrushWeightTextureInput,
} from '../water-brush/weight-composite';
import {
  waterWeightCompositionFailures,
  waterWeightCompositionFixture,
} from './water-brush-weight-composite.fixture';

const widthPx = 5;
const heightPx = 3;
const paddedRowBytes = 256;

function observeWeightPasses(device: RhiDevice) {
  const views = new Map<TextureView, Parameters<RhiDevice['createTextureView']>[0]>();
  const passes: { label: string | undefined; buffer: Buffer }[] = [];
  const failures: string[] = [];
  const forward = (target: object, key: PropertyKey) => {
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const observeEncoder = (encoder: RhiCommandEncoder) =>
    new Proxy(encoder, {
      get(target, key) {
        if (key !== 'beginRenderPass') return forward(target, key);
        return (descriptor: Parameters<RhiCommandEncoder['beginRenderPass']>[0]) => {
          const pass = target.beginRenderPass(descriptor);
          return new Proxy(pass, {
            get(ownedPass, passKey) {
              if (passKey !== 'end') return forward(ownedPass, passKey);
              return () => {
                ownedPass.end();
                // Copy the original R8 output before the next actor overwrites it.
                // No shader, draw, submission or acceptance assertion is replaced.
                try {
                  if (passes.length >= 3) throw new Error('Unexpected extra Water weight pass');
                  const view = Array.from(descriptor.colorAttachments)[0]?.view;
                  const texture = view === undefined ? undefined : views.get(view);
                  if (texture === undefined) throw new Error('Unobserved Water weight output');
                  const buffer = device
                    .createBuffer({
                      label: `water-weight-pass-evidence-${passes.length}`,
                      size: paddedRowBytes * heightPx,
                      usage: 0x08 | 0x01,
                    })
                    .unwrap();
                  passes.push({ label: descriptor.label, buffer });
                  target.copyTextureToBuffer(
                    { texture, mipLevel: 0 },
                    { buffer, bytesPerRow: paddedRowBytes, rowsPerImage: heightPx },
                    [widthPx, heightPx, 1],
                  );
                } catch (error) {
                  failures.push(error instanceof Error ? error.message : String(error));
                }
              };
            },
          });
        };
      },
    });
  return {
    device: new Proxy(device, {
      get(target, key) {
        if (key === 'createTextureView')
          return (...args: Parameters<RhiDevice['createTextureView']>) => {
            const result = target.createTextureView(...args);
            if (result.ok) views.set(result.value, args[0]);
            return result;
          };
        if (key === 'createCommandEncoder')
          return (...args: Parameters<RhiDevice['createCommandEncoder']>) => {
            const result = target.createCommandEncoder(...args);
            return result.ok ? ok(observeEncoder(result.value)) : result;
          };
        return forward(target, key);
      },
    }),
    async report() {
      const observations = [];
      for (const entry of passes) {
        try {
          const mapped = (await entry.buffer.mapAsync(0x01)).unwrap();
          try {
            const padded = new Uint8Array(mapped.getMappedRange().unwrap());
            const bytes = Array.from({ length: heightPx }, (_, row) => [
              ...padded.subarray(row * paddedRowBytes, row * paddedRowBytes + widthPx),
            ]).flat();
            observations.push({ label: entry.label, bytes });
          } finally {
            mapped.unmap();
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      // biome-ignore lint/suspicious/noConsole: original Linux failed-case intermediate byte evidence.
      console.info(
        JSON.stringify({
          kind: 'water-weight-original-pass-bytes',
          platform: process.platform,
          passes: observations,
          failures,
        }),
      );
      return { passes: observations, failures };
    },
    destroy() {
      for (const entry of passes) device.destroyBuffer(entry.buffer);
    },
  };
}

function texture(
  device: Awaited<ReturnType<typeof createDevice>>,
  format: 'r8unorm' | 'r32float',
): WaterBrushWeightTextureInput {
  return {
    texture: device
      .createTexture({
        label: `water-brush-weight-test-${format}`,
        size: [widthPx, heightPx, 1],
        format,
        usage: 0x01 | 0x02 | 0x04,
        textureBindingViewDimension: '2d',
      })
      .unwrap(),
    widthPx,
    heightPx,
    format,
  };
}

async function createDevice() {
  return (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
}

function writeTexture(
  device: Awaited<ReturnType<typeof createDevice>>,
  input: WaterBrushWeightTextureInput,
  values: readonly number[],
) {
  const bytes = new Uint8Array(paddedRowBytes * heightPx);
  const view = new DataView(bytes.buffer);
  const stride = input.format === 'r8unorm' ? 1 : 4;
  for (let y = 0; y < heightPx; y++)
    for (let x = 0; x < widthPx; x++) {
      const offset = y * paddedRowBytes + x * stride;
      if (stride === 1) view.setUint8(offset, requiredFixtureValue(values[x + y * widthPx]));
      else view.setFloat32(offset, requiredFixtureValue(values[x + y * widthPx]), true);
    }
  device.queue
    .writeTexture(
      { texture: input.texture, mipLevel: 0 },
      bytes,
      { offset: 0, bytesPerRow: paddedRowBytes, rowsPerImage: heightPx },
      [widthPx, heightPx, 1],
    )
    .unwrap();
}

it('adds two named Water weight layers in manifest order through real R8 ping-pong passes', async () => {
  const device = await createDevice();
  const native = device.nativeDevice().unwrap();
  native.pushErrorScope('validation');
  const ownedInputs: WaterBrushWeightTextureInput[] = [];
  const make = (format: 'r8unorm' | 'r32float', values: readonly number[]) => {
    const input = texture(device, format);
    ownedInputs.push(input);
    writeTexture(device, input, values);
    return input;
  };
  const baseGrass = make('r8unorm', waterWeightCompositionFixture.baseGrass);
  const baseRock = make('r8unorm', Array(widthPx * heightPx).fill(128));
  const grassAContribution = make('r32float', waterWeightCompositionFixture.grassA);
  const rockAContribution = make('r32float', Array(widthPx * heightPx).fill(0.25));
  const grassBContribution = make('r32float', waterWeightCompositionFixture.grassB);
  const manifest = {
    terrainCapture: { resolutionPx: [widthPx, heightPx], layerNameToIndex: { grass: 0, rock: 1 } },
    terrainReadbackLayout: {
      weightTexturesByLayer: { grass: 'weight:grass:ping', rock: 'weight:rock:pong' },
    },
    textures: [
      { name: 'weight:grass:ping', widthPx, heightPx, format: 'r8unorm' },
      { name: 'weight:grass:pong', widthPx, heightPx, format: 'r8unorm' },
      { name: 'weight:rock:ping', widthPx, heightPx, format: 'r8unorm' },
      { name: 'weight:rock:pong', widthPx, heightPx, format: 'r8unorm' },
    ],
    actorPassPlan: [
      {
        actorId: 'water/a',
        weightPasses: [
          { layerName: 'grass', read: 'weight:grass:ping', write: 'weight:grass:pong' },
          { layerName: 'rock', read: 'weight:rock:ping', write: 'weight:rock:pong' },
        ],
      },
      {
        actorId: 'water/b',
        weightPasses: [
          { layerName: 'grass', read: 'weight:grass:pong', write: 'weight:grass:ping' },
        ],
      },
    ],
  } as unknown as WaterBrushTerrainManifest;
  const observation = observeWeightPasses(device);
  let output: WaterBrushWeightCompositeExecution | undefined;
  try {
    const result = await executeWaterBrushWeightComposite(
      observation.device,
      (code, label) => createShaderModule(device, { code, label }),
      manifest,
      { grass: baseGrass, rock: baseRock },
      {
        'water/a': {
          grass: {
            contribution: grassAContribution,
            opacity: waterWeightCompositionFixture.grassOpacity,
          },
          rock: { contribution: rockAContribution, opacity: 1 },
        },
        'water/b': {
          grass: {
            contribution: grassBContribution,
            opacity: waterWeightCompositionFixture.grassOpacity,
          },
        },
      },
    );
    if (!result.ok) throw result.error;
    output = result.value;
    const validationError = await native.popErrorScope();
    if (validationError !== null)
      throw new Error(`Water Brush weight composite validation failed: ${validationError.message}`);
    const evidence = await observation.report();
    expect(evidence.failures).toEqual([]);
    expect(output.passCount).toBe(3);
    expect(output.fenceCompleted).toBe(true);
    expect(Object.keys(output.readbacksByLayer).sort()).toEqual(['grass', 'rock']);
    expect(requiredFixtureValue(output.readbacksByLayer.grass).bytes).toHaveLength(
      widthPx * heightPx,
    );
    expect(requiredFixtureValue(output.readbacksByLayer.grass).bytesPerRow).toBe(256);
    expect(requiredFixtureValue(output.readbacksByLayer.grass).paddedSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(requiredFixtureValue(output.readbacksByLayer.grass).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      waterWeightCompositionFailures(evidence.passes, [
        ...requiredFixtureValue(output.readbacksByLayer.grass).bytes,
      ]),
    ).toEqual([]);
    expect([...requiredFixtureValue(output.readbacksByLayer.rock).bytes]).toEqual(
      Array(widthPx * heightPx).fill(192),
    );

    const staleLayout = {
      ...manifest,
      actorPassPlan: [],
      terrainReadbackLayout: {
        weightTexturesByLayer: { grass: 'weight:grass:pong', rock: 'weight:rock:pong' },
      },
    } as unknown as WaterBrushTerrainManifest;
    const staleResult = await executeWaterBrushWeightComposite(
      device,
      (code, label) => createShaderModule(device, { code, label }),
      staleLayout,
      { grass: baseGrass, rock: baseRock },
      {},
    );
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok)
      expect(staleResult.error.message).toContain(
        'readback target does not match final ping-pong output',
      );

    const baseOnlyManifest = {
      ...manifest,
      actorPassPlan: [],
      terrainReadbackLayout: {
        weightTexturesByLayer: { grass: 'weight:grass:ping', rock: 'weight:rock:ping' },
      },
    } as unknown as WaterBrushTerrainManifest;
    const baseOnly = await executeWaterBrushWeightComposite(
      device,
      (code, label) => createShaderModule(device, { code, label }),
      baseOnlyManifest,
      { grass: baseGrass, rock: baseRock },
      {},
    );
    if (!baseOnly.ok) throw baseOnly.error;
    try {
      expect(baseOnly.value.passCount).toBe(0);
      expect([...requiredFixtureValue(baseOnly.value.readbacksByLayer.grass).bytes]).toEqual(
        waterWeightCompositionFixture.baseGrass,
      );
      expect([...requiredFixtureValue(baseOnly.value.readbacksByLayer.rock).bytes]).toEqual(
        Array(widthPx * heightPx).fill(128),
      );
    } finally {
      baseOnly.value.destroy();
    }

    const noLayersManifest = {
      ...manifest,
      terrainCapture: { ...manifest.terrainCapture, layerNameToIndex: {} },
      textures: [],
      actorPassPlan: [],
      terrainReadbackLayout: { weightTexturesByLayer: {} },
    } as unknown as WaterBrushTerrainManifest;
    const noLayers = await executeWaterBrushWeightComposite(
      device,
      (code, label) => createShaderModule(device, { code, label }),
      noLayersManifest,
      {},
      {},
    );
    if (!noLayers.ok) throw noLayers.error;
    expect(noLayers.value.passCount).toBe(0);
    expect(noLayers.value.readbacksByLayer).toEqual({});
    noLayers.value.destroy();
  } finally {
    observation.destroy();
    output?.destroy();
    for (const input of ownedInputs) device.destroyTexture(input.texture);
    native.destroy();
  }
});

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Required native fixture value is absent');
  return value;
}
