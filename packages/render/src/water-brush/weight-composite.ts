import {
  type BindGroup,
  type Buffer,
  type RenderPipeline,
  type RhiDevice,
  type RhiError,
  type Texture,
  textureReadbackLayout,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { WaterBrushTerrainManifest } from '@forgeax/engine-water';
import { requireWaterValue } from '@forgeax/engine-water/internal';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { WaterBrushShaderModuleFactory } from './jump-flood.js';

export const WATER_BRUSH_WEIGHT_COMPOSITE_WGSL = /* wgsl */ `
struct Parameters { opacity: f32, _pad0: f32, _pad1: f32, _pad2: f32 }
@group(0) @binding(0) var currentWeight: texture_2d<f32>;
@group(0) @binding(1) var actorContribution: texture_2d<f32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

@vertex fn compose_weight_vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}

@fragment fn compose_weight_fs(@builtin(position) position: vec4<f32>) -> @location(0) f32 {
  let pixel = vec2<i32>(position.xy);
  let current = textureLoad(currentWeight, pixel, 0).r;
  let contribution = saturate(textureLoad(actorContribution, pixel, 0).r);
  return current + contribution * parameters.opacity;
}
`;

export type WaterBrushWeightTextureInput = Readonly<{
  texture: Texture;
  widthPx: number;
  heightPx: number;
  format: 'r8unorm' | 'r32float';
}>;

export type WaterBrushActorWeightInputs = Readonly<{
  contribution: WaterBrushWeightTextureInput;
  opacity: number;
}>;

export type WaterBrushWeightReadback = Readonly<{
  layerName: string;
  widthPx: number;
  heightPx: number;
  format: 'r8unorm';
  bytesPerRow: number;
  rowBytes: number;
  paddedSha256: string;
  sha256: string;
  paddedBytes: Uint8Array;
  bytes: Uint8Array;
}>;

export type WaterBrushWeightCompositeExecution = Readonly<{
  passCount: number;
  readbacksByLayer: Readonly<Record<string, WaterBrushWeightReadback>>;
  fenceCompleted: true;
  destroy(): Result<void, RhiError>;
}>;

const TEXTURE_USAGE = 0x01 | 0x02 | 0x04 | 0x10;
const BUFFER_COPY_DST = 0x08;
const BUFFER_MAP_READ = 0x01;
const BUFFER_UNIFORM = 0x40;
const BINDING_ENTRIES = [
  { binding: 0, visibility: 2, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
  { binding: 1, visibility: 2, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
  { binding: 2, visibility: 2, buffer: { type: 'uniform' } },
] as const;

function resource<T>(result: Result<T, RhiError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function validateInput(
  input: WaterBrushWeightTextureInput | undefined,
  width: number,
  height: number,
  format: WaterBrushWeightTextureInput['format'],
): boolean {
  return (
    input !== undefined &&
    input.widthPx === width &&
    input.heightPx === height &&
    input.format === format
  );
}

/** Execute actor weight additions in manifest order with independent R8 layer ping-pong. */
export async function executeWaterBrushWeightComposite(
  device: RhiDevice,
  createModule: WaterBrushShaderModuleFactory,
  manifest: WaterBrushTerrainManifest,
  baseByLayer: Readonly<Record<string, WaterBrushWeightTextureInput>>,
  actorInputs: Readonly<Record<string, Readonly<Record<string, WaterBrushActorWeightInputs>>>>,
): Promise<Result<WaterBrushWeightCompositeExecution, RhiError | Error>> {
  const capture = manifest.terrainCapture;
  const [width, height] = capture.resolutionPx;
  const layerNames = Object.keys(capture.layerNameToIndex).sort();
  const readbackLayerNames = Object.keys(
    manifest.terrainReadbackLayout.weightTexturesByLayer,
  ).sort();
  if (
    layerNames.length !== readbackLayerNames.length ||
    layerNames.some((layer, index) => layer !== readbackLayerNames[index])
  )
    return err(
      new Error(
        'Water Brush manifest readback layers do not match the frozen Terrain layer-name mapping',
      ),
    );
  const validateWeightInputs = () => {
    for (const layer of layerNames) {
      if (!validateInput(baseByLayer[layer], width, height, 'r8unorm'))
        return err(
          new Error(
            `Water Brush base weight texture does not match R8 manifest layout for ${layer}`,
          ),
        );
      const ping = manifest.textures.find((item) => item.name === `weight:${layer}:ping`);
      const pong = manifest.textures.find((item) => item.name === `weight:${layer}:pong`);
      if (
        ping?.format !== 'r8unorm' ||
        pong?.format !== 'r8unorm' ||
        ping.widthPx !== width ||
        ping.heightPx !== height ||
        pong.widthPx !== width ||
        pong.heightPx !== height
      ) {
        return err(
          new Error(`Water Brush manifest has inconsistent R8 ping-pong textures for ${layer}`),
        );
      }
    }
    for (const actorPass of manifest.actorPassPlan)
      for (const weightPass of actorPass.weightPasses) {
        if (!layerNames.includes(weightPass.layerName))
          return err(
            new Error(
              `Water Brush actor pass references undeclared weight layer: ${actorPass.actorId}/${weightPass.layerName}`,
            ),
          );
        const inputs = actorInputs[actorPass.actorId]?.[weightPass.layerName];
        if (
          !validateInput(inputs?.contribution, width, height, 'r32float') ||
          !Number.isFinite(inputs?.opacity)
        ) {
          return err(
            new Error(
              `Water Brush actor weight contribution or opacity is invalid: ${actorPass.actorId}/${weightPass.layerName}`,
            ),
          );
        }
      }
    return undefined;
  };
  const inputFailure = validateWeightInputs();
  if (inputFailure !== undefined) return inputFailure;
  const plannedSources = new Map(layerNames.map((layer) => [layer, 'ping' as 'ping' | 'pong']));
  const validateWeightPingPong = () => {
    for (const actorPass of manifest.actorPassPlan)
      for (const weightPass of actorPass.weightPasses) {
        const current = requireWaterValue(plannedSources.get(weightPass.layerName));
        const next = current === 'ping' ? 'pong' : 'ping';
        if (
          weightPass.read !== `weight:${weightPass.layerName}:${current}` ||
          weightPass.write !== `weight:${weightPass.layerName}:${next}`
        )
          return err(
            new Error(
              `Water Brush weight ping-pong plan is inconsistent for ${actorPass.actorId}/${weightPass.layerName}`,
            ),
          );
        plannedSources.set(weightPass.layerName, next);
      }
    for (const layer of layerNames) {
      if (
        manifest.terrainReadbackLayout.weightTexturesByLayer[layer] !==
        `weight:${layer}:${plannedSources.get(layer)}`
      )
        return err(
          new Error(
            `Water Brush readback target does not match final ping-pong output for layer ${layer}`,
          ),
        );
    }
    return undefined;
  };
  const planFailure = validateWeightPingPong();
  if (planFailure !== undefined) return planFailure;
  if (layerNames.length === 0)
    return ok(
      Object.freeze({
        passCount: 0,
        readbacksByLayer: Object.freeze({}),
        fenceCompleted: true,
        destroy: () => ok(undefined),
      }),
    );
  const ownedTextures: Texture[] = [];
  const ownedBuffers: Buffer[] = [];
  try {
    const targets = Object.fromEntries(
      layerNames.map((layer) => {
        const ping = resource(
          device.createTexture({
            label: `water-brush:weight:${layer}:ping`,
            size: [width, height, 1],
            format: 'r8unorm',
            usage: TEXTURE_USAGE,
            textureBindingViewDimension: '2d',
          }),
        );
        const pong = resource(
          device.createTexture({
            label: `water-brush:weight:${layer}:pong`,
            size: [width, height, 1],
            format: 'r8unorm',
            usage: TEXTURE_USAGE,
            textureBindingViewDimension: '2d',
          }),
        );
        ownedTextures.push(ping, pong);
        return [layer, { ping, pong }];
      }),
    ) as Record<string, { ping: Texture; pong: Texture }>;
    const readbackLayout = textureReadbackLayout(width, height, {
      blockWidth: 1,
      blockHeight: 1,
      bytesPerBlock: 1,
    });
    const readbackBuffers = Object.fromEntries(
      layerNames.map((layer) => {
        const buffer = resource(
          device.createBuffer({
            label: `water-brush:weight:${layer}:readback`,
            size: readbackLayout.byteLength,
            usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
          }),
        );
        ownedBuffers.push(buffer);
        return [layer, buffer];
      }),
    ) as Record<string, Buffer>;
    const bindGroupLayout = resource(device.createBindGroupLayout({ entries: BINDING_ENTRIES }));
    const pipelineLayout = resource(
      device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    );
    const module = resource(
      await createModule(WATER_BRUSH_WEIGHT_COMPOSITE_WGSL, 'water-brush-weight-composite-v1'),
    );
    const pipeline: RenderPipeline = resource(
      device.createRenderPipeline({
        label: 'water-brush-weight-composite-r8',
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'compose_weight_vs', buffers: [] },
        fragment: { module, entryPoint: 'compose_weight_fs', targets: [{ format: 'r8unorm' }] },
        primitive: { topology: 'triangle-list' },
      }),
    );
    const encoder = resource(
      device.createCommandEncoder({ label: 'water-brush:weight-composition' }),
    );
    const sourceNames = new Map(layerNames.map((layer) => [layer, 'ping' as 'ping' | 'pong']));
    for (const layer of layerNames)
      encoder.copyTextureToTexture(
        { texture: requireWaterValue(baseByLayer[layer]).texture, mipLevel: 0 },
        { texture: requireWaterValue(targets[layer]).ping, mipLevel: 0 },
        [width, height, 1],
      );
    let passCount = 0;
    for (const actorPass of manifest.actorPassPlan)
      for (const weightPass of actorPass.weightPasses) {
        const layer = weightPass.layerName;
        const currentName = requireWaterValue(sourceNames.get(layer));
        const writeName = currentName === 'ping' ? 'pong' : 'ping';
        if (
          weightPass.read !== `weight:${layer}:${currentName}` ||
          weightPass.write !== `weight:${layer}:${writeName}`
        ) {
          throw new Error(
            `Water Brush weight ping-pong plan is inconsistent for ${actorPass.actorId}/${layer}`,
          );
        }
        const currentTexture = requireWaterValue(targets[layer])[currentName];
        const writeTexture = requireWaterValue(targets[layer])[writeName];
        const currentView = resource(device.createTextureView(currentTexture, { dimension: '2d' }));
        const writeView = resource(device.createTextureView(writeTexture, { dimension: '2d' }));
        const contributionView = resource(
          device.createTextureView(
            requireWaterValue(requireWaterValue(actorInputs[actorPass.actorId])[layer]).contribution
              .texture,
            {
              dimension: '2d',
            },
          ),
        );
        const opacity = requireWaterValue(
          requireWaterValue(actorInputs[actorPass.actorId])[layer],
        ).opacity;
        const parameters = resource(
          device.createBuffer({
            label: `water-brush-weight-parameters-${passCount}`,
            size: 16,
            usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
          }),
        );
        ownedBuffers.push(parameters);
        resource(device.queue.writeBuffer(parameters, 0, new Float32Array([opacity, 0, 0, 0])));
        const group: BindGroup = resource(
          device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
              { binding: 0, resource: { kind: 'textureView', value: currentView } },
              { binding: 1, resource: { kind: 'textureView', value: contributionView } },
              { binding: 2, resource: { kind: 'buffer', value: { buffer: parameters, size: 16 } } },
            ],
          }),
        );
        const pass = encoder.beginRenderPass({
          label: `weight:${layer}:${actorPass.actorId}`,
          colorAttachments: [
            {
              view: writeView,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
        sourceNames.set(layer, writeName);
        passCount++;
      }
    for (const layer of layerNames)
      encoder.copyTextureToBuffer(
        {
          texture: requireWaterValue(targets[layer])[requireWaterValue(sourceNames.get(layer))],
          mipLevel: 0,
        },
        {
          buffer: requireWaterValue(readbackBuffers[layer]),
          offset: 0,
          bytesPerRow: readbackLayout.bytesPerRow,
          rowsPerImage: readbackLayout.rowsPerImage,
        },
        [width, height, 1],
      );
    resource(device.queue.submit([resource(encoder.finish())]));
    await device.queue.onSubmittedWorkDone();

    const readbacks: Record<string, WaterBrushWeightReadback> = {};
    for (const layer of layerNames) {
      const mapped = resource(
        await requireWaterValue(readbackBuffers[layer]).mapAsync(BUFFER_MAP_READ),
      );
      const range = resource(mapped.getMappedRange());
      const paddedBytes = new Uint8Array(range.slice(0));
      const bytes = new Uint8Array(height * readbackLayout.rowBytes);
      for (let row = 0; row < height; row++)
        bytes.set(
          paddedBytes.subarray(
            row * readbackLayout.bytesPerRow,
            row * readbackLayout.bytesPerRow + readbackLayout.rowBytes,
          ),
          row * readbackLayout.rowBytes,
        );
      mapped.unmap();
      readbacks[layer] = Object.freeze({
        layerName: layer,
        widthPx: width,
        heightPx: height,
        format: 'r8unorm',
        bytesPerRow: readbackLayout.bytesPerRow,
        rowBytes: readbackLayout.rowBytes,
        paddedSha256: bytesToHex(sha256(paddedBytes)),
        sha256: bytesToHex(sha256(bytes)),
        paddedBytes,
        bytes,
      });
    }
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
        passCount,
        readbacksByLayer: Object.freeze(readbacks),
        fenceCompleted: true,
        destroy,
      }),
    );
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const texture of ownedTextures) device.destroyTexture(texture);
    for (const buffer of ownedBuffers) device.destroyBuffer(buffer);
    return err(failure);
  }
}
