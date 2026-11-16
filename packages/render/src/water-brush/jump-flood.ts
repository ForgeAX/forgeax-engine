import {
  type BindGroup,
  type Buffer,
  type RhiDevice,
  type RhiError,
  type ShaderModule,
  type Texture,
  textureReadbackLayout,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { WaterBrushTerrainManifest } from '@forgeax/engine-water';
import { requireWaterValue } from '@forgeax/engine-water/internal';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const WATER_BRUSH_JUMP_FLOOD_WGSL = /* wgsl */ `
struct Parameters { width: u32, height: u32, step: u32, _pad: u32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

@compute @workgroup_size(8, 8, 1)
fn jump_flood(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= parameters.width || id.y >= parameters.height) { return; }
  let pixel = vec2<i32>(id.xy);
  let uv = (vec2<f32>(pixel) + vec2<f32>(0.5)) / vec2<f32>(f32(parameters.width), f32(parameters.height));
  let currentSeed = textureLoad(source, pixel, 0);
  var best = vec4<f32>(0.0);
  var bestDistance = 1.0e30;
  if (!(currentSeed.x == 0.0 && currentSeed.y == 0.0)) {
    best = currentSeed;
    bestDistance = distance(uv, currentSeed.xy);
  }
  let offsets = array<vec2<i32>, 8>(
    vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(0, 1), vec2<i32>(0, -1),
    vec2<i32>(1, 1), vec2<i32>(1, -1), vec2<i32>(-1, 1), vec2<i32>(-1, -1),
  );
  for (var index = 0; index < 8; index += 1) {
    let candidatePixel = pixel + offsets[index] * i32(parameters.step);
    if (candidatePixel.x < 0 || candidatePixel.y < 0 || candidatePixel.x >= i32(parameters.width) || candidatePixel.y >= i32(parameters.height)) { continue; }
    let candidate = textureLoad(source, candidatePixel, 0);
    let candidateUv = (vec2<f32>(candidatePixel) + vec2<f32>(0.5)) / vec2<f32>(f32(parameters.width), f32(parameters.height));
    if ((candidate.x <= 0.0 && candidate.y <= 0.0) || candidateUv.x <= 0.0 || candidateUv.x >= 1.0 || candidateUv.y <= 0.0 || candidateUv.y >= 1.0) { continue; }
    let candidateDistance = distance(uv, candidate.xy);
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  textureStore(outputTexture, pixel, vec4<f32>(best.rgb, 1.0 - currentSeed.a));
}
`;

export const WATER_BRUSH_BLUR_EDGES_WGSL = /* wgsl */ `
struct Parameters { width: u32, height: u32, _pad0: u32, _pad1: u32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

fn sample_clamp_linear(texelCenter: vec2<f32>) -> vec4<f32> {
  let base = vec2<i32>(floor(texelCenter));
  let fraction = fract(texelCenter);
  let maximum = vec2<i32>(i32(parameters.width) - 1, i32(parameters.height) - 1);
  let p00 = textureLoad(source, clamp(base, vec2<i32>(0), maximum), 0);
  let p10 = textureLoad(source, clamp(base + vec2<i32>(1, 0), vec2<i32>(0), maximum), 0);
  let p01 = textureLoad(source, clamp(base + vec2<i32>(0, 1), vec2<i32>(0), maximum), 0);
  let p11 = textureLoad(source, clamp(base + vec2<i32>(1, 1), vec2<i32>(0), maximum), 0);
  return mix(mix(p00, p10, fraction.x), mix(p01, p11, fraction.x), fraction.y);
}

@compute @workgroup_size(8, 8, 1)
fn blur_edges(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= parameters.width || id.y >= parameters.height) { return; }
  let pixel = vec2<i32>(id.xy);
  let current = textureLoad(source, pixel, 0);
  if (current.x + current.y == 0.0) { textureStore(outputTexture, pixel, vec4<f32>(current.rgb, 1.0 - current.a)); return; }
  var sum = vec2<f32>(0.0);
  var count = 0.0;
  let offsets = array<vec2<i32>, 8>(
    vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(0, 1), vec2<i32>(0, -1),
    vec2<i32>(1, 1), vec2<i32>(1, -1), vec2<i32>(-1, 1), vec2<i32>(-1, -1),
  );
  for (var index = 0; index < 8; index += 1) {
    let offset = offsets[index];
    let neighborPosition = vec2<f32>(pixel) + vec2<f32>(f32(offset.x), f32(offset.y) * f32(parameters.height) / f32(parameters.width));
    let neighbor = sample_clamp_linear(neighborPosition);
    if (neighbor.x + neighbor.y <= 0.0) { continue; }
    sum += neighbor.xy;
    count += 1.0;
  }
  if (count > 0.0) { sum /= count; }
  textureStore(outputTexture, pixel, vec4<f32>(sum, current.z, 1.0 - current.a));
}
`;

export type WaterBrushJumpFloodReadback = Readonly<{
  widthPx: number;
  heightPx: number;
  format: 'rgba32float';
  bytesPerRow: number;
  rowBytes: number;
  paddedBytes: Uint8Array;
  tightBytes: Uint8Array;
  paddedSha256: string;
  values: Float32Array;
  sha256: string;
}>;

export type WaterBrushJumpFloodExecution = Readonly<{
  executedBlurPassCount: number;
  executedPassCount: number;
  executedStepOffsets: readonly number[];
  executedFinalTarget: 'jump-flood-a' | 'jump-flood-b';
  cacheSelectedTarget: 'jump-flood-a' | 'jump-flood-b';
  cacheReadback: WaterBrushJumpFloodReadback;
  textures: Readonly<{ 'jump-flood-a': Texture; 'jump-flood-b': Texture }>;
  readbacksByTarget: Readonly<Record<'jump-flood-a' | 'jump-flood-b', WaterBrushJumpFloodReadback>>;
  readback: WaterBrushJumpFloodReadback;
  fenceCompleted: true;
  destroy(): Result<void, RhiError>;
}>;

export type WaterBrushShaderModuleFactory = (
  source: string,
  label: string,
) => Promise<Result<ShaderModule, RhiError>>;

const TEXTURE_USAGE = 0x01 | 0x02 | 0x04 | 0x08;
const BUFFER_MAP_READ = 0x01;
const BUFFER_COPY_DST = 0x08;
const BUFFER_UNIFORM = 0x40;
const BINDING_ENTRIES = [
  { binding: 0, visibility: 4, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
  {
    binding: 1,
    visibility: 4,
    storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d' },
  },
  { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
] as const;
const BLUR_BINDING_ENTRIES = [
  { binding: 0, visibility: 4, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
  {
    binding: 1,
    visibility: 4,
    storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d' },
  },
  { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
] as const;

function resource<T>(result: Result<T, RhiError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Execute the manifest's actual JFA dispatches using the Render-owned RHI device. */
export async function executeWaterBrushJumpFlood(
  device: RhiDevice,
  createModule: WaterBrushShaderModuleFactory,
  seedTexture: Texture,
  manifest: WaterBrushTerrainManifest,
  actorId: string,
): Promise<Result<WaterBrushJumpFloodExecution, RhiError | Error>> {
  const readJumpFloodManifestActorInputs = () => {
    const actorPass = manifest.actorPassPlan.find((pass) => pass.actorId === actorId);
    const textureA = manifest.textures.find(
      (item) => item.name === `actor:${actorId}:jump-flood-a`,
    );
    const textureB = manifest.textures.find(
      (item) => item.name === `actor:${actorId}:jump-flood-b`,
    );
    const width = textureA?.widthPx;
    const height = textureA?.heightPx;
    return { actorPass, textureA, textureB, width, height };
  };
  const { actorPass, textureA, textureB, width, height } = readJumpFloodManifestActorInputs();
  if (
    actorPass === undefined ||
    textureA === undefined ||
    textureB === undefined ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    requireWaterValue(width) < 1 ||
    requireWaterValue(height) < 1 ||
    textureA.format !== 'rgba32float' ||
    textureB.format !== 'rgba32float' ||
    textureB.widthPx !== width ||
    textureB.heightPx !== height
  ) {
    return err(
      new Error(
        `Water Brush manifest has no consistent RGBA32Float JFA layout and pass plan for actor ${actorId}`,
      ),
    );
  }
  const jfaPassCount = Math.ceil(
    Math.log2(Math.max(requireWaterValue(width), requireWaterValue(height))),
  );
  const blurPassCount = actorPass.blurPassCount;
  const validateJumpFloodBlurPassCount = () => {
    if (!Number.isSafeInteger(blurPassCount) || blurPassCount < 0 || blurPassCount > 9) {
      return err(new Error(`Water Brush manifest blur pass count is invalid for actor ${actorId}`));
    }
    return undefined;
  };
  const blurCountFailure = validateJumpFloodBlurPassCount();
  if (blurCountFailure !== undefined) return blurCountFailure;
  const expectedOffsets = Array.from(
    { length: jfaPassCount },
    (_, pass) => 2 ** (jfaPassCount - pass - 1),
  );
  const validateJumpFloodOffsets = () => {
    if (
      actorPass.jumpFloodPassCount !== jfaPassCount ||
      actorPass.jfaStepOffsets.length !== expectedOffsets.length ||
      actorPass.jfaStepOffsets.some((step, index) => step !== expectedOffsets[index])
    ) {
      return err(new Error(`Water Brush manifest JFA offsets are invalid for actor ${actorId}`));
    }
    if (
      actorPass.jumpFloodPassCount !== actorPass.jfaStepOffsets.length ||
      actorPass.jfaStepOffsets.some((step) => !Number.isSafeInteger(step) || step < 1)
    ) {
      return err(
        new Error(`Water Brush JFA pass count and step offsets disagree for actor ${actorId}`),
      );
    }
    return undefined;
  };
  const offsetFailure = validateJumpFloodOffsets();
  if (offsetFailure !== undefined) return offsetFailure;
  const admitJumpFloodDeviceCapabilities = () => {
    if (!device.caps.compute || !device.caps.storageTexture)
      return err(new Error('Water Brush JFA requires compute and storage texture support'));
    return undefined;
  };
  const deviceCapabilityFailure = admitJumpFloodDeviceCapabilities();
  if (deviceCapabilityFailure !== undefined) return deviceCapabilityFailure;
  const targetNames = ['jump-flood-a', 'jump-flood-b'] as const;
  const opposite = (name: (typeof targetNames)[number]) =>
    name === 'jump-flood-a' ? ('jump-flood-b' as const) : ('jump-flood-a' as const);
  const expectedFinalTarget =
    (blurPassCount + jfaPassCount) % 2 === 0 ? 'jump-flood-a' : 'jump-flood-b';
  const validateJumpFloodTargetParity = () => {
    if (actorPass.jumpFloodExecutedFinalTarget !== expectedFinalTarget)
      return err(
        new Error(
          `Water Brush manifest final JFA target does not match executed blur/JFA parity for actor ${actorId}`,
        ),
      );
    if (
      actorPass.jumpFloodCacheSelectedTarget !== 'jump-flood-a' &&
      actorPass.jumpFloodCacheSelectedTarget !== 'jump-flood-b'
    )
      return err(
        new Error(`Water Brush manifest cache-selected JFA target is invalid for actor ${actorId}`),
      );
    if (
      !Number.isSafeInteger(actorPass.jumpFloodCachePassIndex) ||
      actorPass.jumpFloodCachePassIndex < 0 ||
      actorPass.jumpFloodCacheParity !== actorPass.jumpFloodCachePassIndex % 2 ||
      actorPass.jumpFloodCacheSelectedTarget !==
        (actorPass.jumpFloodCacheParity === 0 ? 'jump-flood-a' : 'jump-flood-b')
    )
      return err(
        new Error(
          `Water Brush manifest cache target does not match raw-radius parity for actor ${actorId}`,
        ),
      );
    return undefined;
  };
  const parityFailure = validateJumpFloodTargetParity();
  if (parityFailure !== undefined) return parityFailure;

  const ownedTextures: Texture[] = [];
  const ownedBuffers: Buffer[] = [];
  try {
    const a = resource(
      device.createTexture({
        label: `water-brush:${actorId}:jump-flood-a`,
        size: [width, height, 1],
        format: 'rgba32float',
        usage: TEXTURE_USAGE,
        textureBindingViewDimension: '2d',
      }),
    );
    ownedTextures.push(a);
    const b = resource(
      device.createTexture({
        label: `water-brush:${actorId}:jump-flood-b`,
        size: [width, height, 1],
        format: 'rgba32float',
        usage: TEXTURE_USAGE,
        textureBindingViewDimension: '2d',
      }),
    );
    ownedTextures.push(b);
    const targetViews = {
      'jump-flood-a': resource(device.createTextureView(a, { dimension: '2d' })),
      'jump-flood-b': resource(device.createTextureView(b, { dimension: '2d' })),
    };
    const layout = resource(device.createBindGroupLayout({ entries: BINDING_ENTRIES }));
    const pipelineLayout = resource(device.createPipelineLayout({ bindGroupLayouts: [layout] }));
    const shader = await createModule(WATER_BRUSH_JUMP_FLOOD_WGSL, 'water-brush-jump-flood-v1');
    const module = resource(shader);
    const pipeline = resource(
      device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module, entryPoint: 'jump_flood' },
      }),
    );
    const blurShader = resource(
      await createModule(WATER_BRUSH_BLUR_EDGES_WGSL, 'water-brush-blur-edges-v1'),
    );
    const blurLayout = resource(device.createBindGroupLayout({ entries: BLUR_BINDING_ENTRIES }));
    const blurPipelineLayout = resource(
      device.createPipelineLayout({ bindGroupLayouts: [blurLayout] }),
    );
    const blurPipeline = resource(
      device.createComputePipeline({
        layout: blurPipelineLayout,
        compute: { module: blurShader, entryPoint: 'blur_edges' },
      }),
    );
    const layoutInfo = textureReadbackLayout(width, height, {
      blockWidth: 1,
      blockHeight: 1,
      bytesPerBlock: 16,
    });
    const clearBytes = new Uint8Array(layoutInfo.byteLength);
    const clearJumpFloodTextures = () => {
      for (const texture of [a, b])
        resource(
          device.queue.writeTexture(
            { texture, mipLevel: 0 },
            clearBytes,
            {
              offset: 0,
              bytesPerRow: layoutInfo.bytesPerRow,
              rowsPerImage: layoutInfo.rowsPerImage,
            },
            [width, height, 1],
          ),
        );
    };
    clearJumpFloodTextures();
    const readbackBuffers = Object.fromEntries(
      targetNames.map((name) => {
        const buffer = resource(
          device.createBuffer({
            label: `water-brush:${actorId}:${name}:readback`,
            size: layoutInfo.byteLength,
            usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
          }),
        );
        ownedBuffers.push(buffer);
        return [name, buffer];
      }),
    ) as Record<(typeof targetNames)[number], Buffer>;

    const encoder = resource(device.createCommandEncoder({ label: `water-brush:${actorId}:jfa` }));
    encoder.copyTextureToTexture(
      { texture: seedTexture, mipLevel: 0 },
      { texture: a, mipLevel: 0 },
      [width, height, 1],
    );
    let sourceView = resource(device.createTextureView(a, { dimension: '2d' }));
    let sourceName: 'jump-flood-a' | 'jump-flood-b' = 'jump-flood-a';
    const encodeWaterBrushBlurPasses = () => {
      for (let index = 0; index < blurPassCount; index++) {
        const targetName = opposite(sourceName);
        const parameterBuffer = resource(
          device.createBuffer({
            label: `water-brush-blur-parameters-${index}`,
            size: 16,
            usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
          }),
        );
        ownedBuffers.push(parameterBuffer);
        resource(
          device.queue.writeBuffer(parameterBuffer, 0, new Uint32Array([width, height, 0, 0])),
        );
        const group: BindGroup = resource(
          device.createBindGroup({
            layout: blurLayout,
            entries: [
              { binding: 0, resource: { kind: 'textureView', value: sourceView } },
              { binding: 1, resource: { kind: 'textureView', value: targetViews[targetName] } },
              {
                binding: 2,
                resource: { kind: 'buffer', value: { buffer: parameterBuffer, size: 16 } },
              },
            ],
          }),
        );
        const pass = encoder.beginComputePass({ label: `blur-edges:${index + 1}` });
        pass.setPipeline(blurPipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
        pass.end();
        sourceName = targetName;
        sourceView = targetViews[targetName];
      }
    };
    encodeWaterBrushBlurPasses();
    const encodeWaterBrushJumpFloodPasses = () => {
      for (let index = 0; index < actorPass.jfaStepOffsets.length; index++) {
        const step = requireWaterValue(actorPass.jfaStepOffsets[index]);
        const targetName = opposite(sourceName);
        const targetView = targetViews[targetName];
        const parameterBuffer = resource(
          device.createBuffer({
            label: `water-brush-jump-flood-parameters-${index}`,
            size: 16,
            usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
          }),
        );
        ownedBuffers.push(parameterBuffer);
        const params = new Uint32Array([width, height, step, 0]);
        resource(device.queue.writeBuffer(parameterBuffer, 0, params));
        const group: BindGroup = resource(
          device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { kind: 'textureView', value: sourceView } },
              { binding: 1, resource: { kind: 'textureView', value: targetView } },
              {
                binding: 2,
                resource: { kind: 'buffer', value: { buffer: parameterBuffer, size: 16 } },
              },
            ],
          }),
        );
        const pass = encoder.beginComputePass({ label: `jump-flood:${step}` });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
        pass.end();
        sourceView = targetView;
        sourceName = targetName;
      }
    };
    encodeWaterBrushJumpFloodPasses();
    const finalName = sourceName;
    const submitJumpFloodReadbackCopies = () => {
      for (const name of targetNames)
        encoder.copyTextureToBuffer(
          { texture: name === 'jump-flood-a' ? a : b, mipLevel: 0 },
          {
            buffer: readbackBuffers[name],
            offset: 0,
            bytesPerRow: layoutInfo.bytesPerRow,
            rowsPerImage: layoutInfo.rowsPerImage,
          },
          [width, height, 1],
        );
      const commandBuffer = resource(encoder.finish());
      resource(device.queue.submit([commandBuffer]));
    };
    submitJumpFloodReadbackCopies();
    await device.queue.onSubmittedWorkDone();
    const readbacks = {} as Record<(typeof targetNames)[number], WaterBrushJumpFloodReadback>;
    for (const name of targetNames) {
      const mapped = resource(await readbackBuffers[name].mapAsync(BUFFER_MAP_READ));
      const range = resource(mapped.getMappedRange());
      const captureTightJumpFloodReadback = () => {
        const tightBytes = new Uint8Array(height * layoutInfo.rowBytes);
        const paddedBytes = new Uint8Array(range.slice(0));
        for (let row = 0; row < height; row++)
          tightBytes.set(
            paddedBytes.subarray(
              row * layoutInfo.bytesPerRow,
              row * layoutInfo.bytesPerRow + layoutInfo.rowBytes,
            ),
            row * layoutInfo.rowBytes,
          );
        const values = new Float32Array(
          tightBytes.buffer.slice(
            tightBytes.byteOffset,
            tightBytes.byteOffset + tightBytes.byteLength,
          ),
        );
        return { tightBytes, paddedBytes, values };
      };
      const { tightBytes, paddedBytes, values } = captureTightJumpFloodReadback();
      mapped.unmap();
      readbacks[name] = Object.freeze({
        widthPx: width,
        heightPx: height,
        format: 'rgba32float',
        bytesPerRow: layoutInfo.bytesPerRow,
        rowBytes: layoutInfo.rowBytes,
        paddedBytes,
        tightBytes,
        paddedSha256: bytesToHex(sha256(paddedBytes)),
        values,
        sha256: bytesToHex(sha256(tightBytes)),
      });
    }
    const completeJumpFloodExecutionReceipt = () => {
      const destroy = () => {
        let firstError: RhiError | undefined;
        for (const texture of ownedTextures) {
          const result = device.destroyTexture(texture);
          if (!result.ok) firstError ??= result.error;
        }
        for (const buffer of ownedBuffers) {
          const result = device.destroyBuffer(buffer);
          if (!result.ok) firstError ??= result.error;
        }
        return firstError === undefined ? ok(undefined) : err(firstError);
      };
      return ok(
        Object.freeze({
          executedBlurPassCount: blurPassCount,
          executedPassCount: actorPass.jumpFloodPassCount,
          executedStepOffsets: Object.freeze([...actorPass.jfaStepOffsets]),
          executedFinalTarget: finalName,
          cacheSelectedTarget: actorPass.jumpFloodCacheSelectedTarget,
          cacheReadback: readbacks[actorPass.jumpFloodCacheSelectedTarget],
          textures: Object.freeze({ 'jump-flood-a': a, 'jump-flood-b': b }),
          readbacksByTarget: Object.freeze(readbacks),
          readback: readbacks[finalName],
          fenceCompleted: true,
          destroy,
        }),
      );
    };
    return completeJumpFloodExecutionReceipt();
  } catch (error) {
    const disposeFailedJumpFloodExecution = () => {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const texture of ownedTextures) device.destroyTexture(texture);
      for (const buffer of ownedBuffers) device.destroyBuffer(buffer);
      return err(failure);
    };
    return disposeFailedJumpFloodExecution();
  }
}
