import type {
  Buffer,
  RhiComputePassEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { SDF_SCENE_TEXTURE_LAYOUT, SDF_SURFACE_POOL_LAYOUT } from '@forgeax/engine-shader';
import { ok, type Result } from '@forgeax/engine-types';
import type { GlobalSdfCompositionInputs } from './global-sdf';
import { prepareComputePipeline } from './prepare-pipeline';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import { SDF_INSTANCE_STRIDE } from './sdf-query';

const HEADER_WORDS = SDF_SCENE_TEXTURE_LAYOUT.headerWords;
const MAGIC = SDF_SCENE_TEXTURE_LAYOUT.magic;
const FORMAT = SDF_SCENE_TEXTURE_LAYOUT.version;
const INSTANCE_WORDS = SDF_INSTANCE_STRIDE / 4;

/** Raw sampling projection of the existing canonical instance/field buffers.
 * It is neither another geometry roster nor an eligibility certificate. */
export interface SdfSceneTexturePlan {
  readonly width: number;
  readonly height: number;
  readonly texels: number;
  readonly bytes: number;
  readonly instanceWords: number;
  readonly fieldWords: number;
  readonly rowLimit: number;
  readonly logicalWords: number;
}

/** The caller charges `maxBytes` to its existing GPU allocation budget. */
export function planSdfSceneTexture(
  instanceBytes: number,
  fieldBytes: number,
  rowLimit: number,
  limits: { readonly maxTextureDimension2D: number; readonly maxBytes: number },
): Result<SdfSceneTexturePlan, RayReferenceError> {
  if (
    ![instanceBytes, fieldBytes, rowLimit, limits.maxBytes].every(Number.isSafeInteger) ||
    instanceBytes < 0 ||
    fieldBytes < 0 ||
    instanceBytes % SDF_INSTANCE_STRIDE !== 0 ||
    fieldBytes % 4 !== 0 ||
    rowLimit < 0 ||
    rowLimit > instanceBytes / SDF_INSTANCE_STRIDE ||
    limits.maxBytes < 16
  )
    return rayReferenceFailure('invalid canonical SDF texture source spans or allocation budget');
  const maximum = limits.maxTextureDimension2D;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    return rayReferenceFailure('invalid SDF texture dimension limit');
  const logicalWords = HEADER_WORDS + instanceBytes / 4 + fieldBytes / 4;
  if (logicalWords > 0xffff_ffff)
    return rayReferenceFailure('SDF texture source address exceeds u32');
  const needed = Math.ceil(logicalWords / 4);
  const width = Math.min(maximum, 1024, needed);
  const height = Math.ceil(needed / width);
  const texels = width * height;
  const bytes = texels * 16;
  if (height > maximum || texels > 0x3fff_ffff || bytes > limits.maxBytes)
    return rayReferenceFailure(
      'SDF texture projection exceeds the existing allocation budget',
      true,
    );
  return ok({
    width,
    height,
    texels,
    bytes,
    instanceWords: instanceBytes / 4,
    fieldWords: fieldBytes / 4,
    rowLimit,
    logicalWords,
  });
}

/** Source owner supplies a fresh accepted epoch; zero is never ready. */
export function packSdfSceneTexture(
  plan: SdfSceneTexturePlan,
  epoch: number,
): Result<Uint32Array<ArrayBuffer>, RayReferenceError> {
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffff_ffff)
    return rayReferenceFailure('SDF texture projection requires an accepted nonzero source epoch');
  return ok(
    Uint32Array.from([
      plan.instanceWords,
      plan.fieldWords,
      plan.rowLimit,
      epoch,
      plan.width,
      plan.height,
      plan.logicalWords,
      0,
    ]),
  );
}

/** Invalidate before the first canonical edit. A reader must also compare the
 * independently expected source epoch; the projection never owns that clock. */
export function invalidateSdfSceneTexture(device: RhiDevice, texture: Texture, epoch: number) {
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffff_ffff)
    return rayReferenceFailure('invalid SDF texture invalidation epoch');
  return device.queue.writeTexture(
    { texture, origin: [0, 0, 0] },
    Uint32Array.from([MAGIC, FORMAT, epoch, 0]),
    { offset: 0 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
}

export const SDF_SCENE_TEXTURE_PROJECT_WGSL = `
struct SdfProjection { source:vec4u, shape:vec4u }
@group(0) @binding(0) var<storage,read> sourceInstances:array<u32>;
@group(0) @binding(1) var<storage,read> sourceFields:array<u32>;
@group(0) @binding(2) var<uniform> projection:SdfProjection;
@group(0) @binding(3) var projectedScene:texture_storage_2d<rgba32uint,write>;
fn sdfProjectionWord(word:u32)->u32 {
 let source=projection.source;let shape=projection.shape;
 if(word<${HEADER_WORDS}u){
  let header=array<vec4u,4>(vec4u(${MAGIC}u,${FORMAT}u,source.w,1u),
   vec4u(${HEADER_WORDS}u,source.x,${HEADER_WORDS}u+source.x,source.y),
   vec4u(source.z,${INSTANCE_WORDS}u,shape.x,shape.y),vec4u(shape.z,0u,0u,0u));
  return header[word>>2u][word&3u];
 }
 let relative=word-${HEADER_WORDS}u;
 if(relative<source.x){return sourceInstances[relative];}
 let field=relative-source.x;
 if(field<source.y){return sourceFields[field];}
 return 0u;
}
@compute @workgroup_size(64) fn projectSdfScene(@builtin(global_invocation_id) gid:vec3u,@builtin(num_workgroups) groups:vec3u){
 let dims=textureDimensions(projectedScene);let source=projection.source;let shape=projection.shape;
 if(source.w==0u || any(dims!=shape.xy) || shape.w!=0u){return;}
 if(source.x>arrayLength(&sourceInstances) || source.y>arrayLength(&sourceFields) || source.x%${INSTANCE_WORDS}u!=0u || source.z>source.x/${INSTANCE_WORDS}u){return;}
 if(source.x>0xffffffffu-${HEADER_WORDS}u){return;}
 let fieldsStart=${HEADER_WORDS}u+source.x;
 if(source.y>0xffffffffu-fieldsStart || shape.z!=fieldsStart+source.y){return;}
 if(dims.y==0u || dims.x>0x3fffffffu/dims.y){return;}
 let texels=dims.x*dims.y;
 if(shape.z>texels*4u){return;}
 let texel=gid.x+gid.y*groups.x*64u;
 if(texel>=texels){return;}
 let first=texel*4u;
 textureStore(projectedScene,vec2i(i32(texel%dims.x),i32(texel/dims.x)),vec4u(sdfProjectionWord(first),sdfProjectionWord(first+1u),sdfProjectionWord(first+2u),sdfProjectionWord(first+3u)));
}`;

/** This low-level recorder borrows resources and validates ranges, not source
 * contents. The Scene producer owns eligibility, epoch publication and ordering.
 * A complete projection pass must precede every reader after canonical edits. */
export async function createSdfSceneTextureKernel(device: RhiDevice, module: ShaderModule) {
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
      {
        binding: 3,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba32uint', viewDimension: '2d' },
      },
    ],
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = await prepareComputePipeline(device, {
    label: 'sdf-scene.project-raw-words',
    layout: pipelineLayout.value,
    compute: { module, entryPoint: 'projectSdfScene' },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    record(
      pass: RhiComputePassEncoder,
      input: Pick<GlobalSdfCompositionInputs, 'instances' | 'fields'>,
      params: { readonly buffer: Buffer; readonly size: number },
      output: TextureView,
      plan: SdfSceneTexturePlan,
    ): Result<void, RhiError | RayReferenceError> {
      if (
        input.instances.size !== plan.instanceWords * 4 ||
        input.fields.size !== plan.fieldWords * 4 ||
        params.size < 32
      )
        return rayReferenceFailure('SDF texture source ranges differ from the admitted projection');
      const maximum = device.limits.maxComputeWorkgroupsPerDimension;
      if (!Number.isSafeInteger(maximum) || maximum < 1)
        return rayReferenceFailure('SDF projection requires a positive dispatch limit', true);
      const groups = Math.ceil(plan.texels / 64);
      const x = Math.min(groups, maximum);
      const y = Math.ceil(groups / x);
      if (y > maximum)
        return rayReferenceFailure(
          'SDF projection exceeds the two-dimensional dispatch limit',
          true,
        );
      const group = device.createBindGroup({
        layout: layout.value,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'buffer',
              value: { ...input.instances, size: Math.max(4, input.instances.size) },
            },
          },
          {
            binding: 1,
            resource: {
              kind: 'buffer',
              value: { ...input.fields, size: Math.max(4, input.fields.size) },
            },
          },
          { binding: 2, resource: { kind: 'buffer', value: params } },
          { binding: 3, resource: { kind: 'textureView', value: output } },
        ],
      });
      if (!group.ok) return group;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      pass.dispatchWorkgroups(x, y);
      return ok(undefined);
    },
  });
}

/** Field-owned transport of one canonical allocation. The accepted SceneFieldRows
 * revision owns the epoch; neither the texture nor a completed old submit does. */
export async function createSdfSceneTextureProjection(
  device: RhiDevice,
  module: ShaderModule,
  input: Pick<GlobalSdfCompositionInputs, 'instances' | 'fields'>,
  rowLimit: number,
  epoch: number,
) {
  // Charge the actual allocation below, bounded by the existing pool protocol,
  // actual instance capacity and at most one texture row of alignment padding.
  const maximum =
    SDF_SURFACE_POOL_LAYOUT.maxBytes + input.instances.size + HEADER_WORDS * 4 + 1024 * 16;
  const base = planSdfSceneTexture(input.instances.size, input.fields.size, rowLimit, {
    maxTextureDimension2D: device.limits.maxTextureDimension2D,
    maxBytes: maximum,
  }).unwrap();
  let expected: readonly [number, number, number, number] = Object.freeze([
    base.instanceWords,
    base.fieldWords,
    rowLimit,
    epoch,
  ]);
  const initial = packSdfSceneTexture(base, epoch).unwrap();
  const descriptor = {
    label: 'irradiance-field.canonical-scene',
    size: { width: base.width, height: base.height, depthOrArrayLayers: 1 },
    dimension: '2d' as const,
    textureBindingViewDimension: '2d' as const,
    format: 'rgba32uint' as const,
    usage: 2 | 4 | 8,
  };
  const texture = device.createTexture(descriptor).unwrap();
  let params: { readonly buffer: Buffer; readonly size: number } | undefined;
  try {
    const view = device.createTextureView(texture, { dimension: '2d' }).unwrap();
    params = {
      buffer: device
        .createBuffer({ label: 'irradiance-field.canonical-params', size: 32, usage: 64 | 8 })
        .unwrap(),
      size: 32,
    };
    const parameters = params;
    const kernel = (await createSdfSceneTextureKernel(device, module)).unwrap();
    let submitted = 0;
    device.queue.writeBuffer(parameters.buffer, 0, initial).unwrap();
    invalidateSdfSceneTexture(device, texture, epoch).unwrap();
    return {
      texture,
      view,
      descriptor,
      params: parameters,
      get expected() {
        return expected;
      },
      required: () => submitted !== expected[3],
      invalidate() {
        const result = invalidateSdfSceneTexture(device, texture, expected[3]);
        if (result.ok) submitted = 0;
        return result;
      },
      adopt(nextEpoch: number, nextRowLimit: number) {
        const plan = { ...base, rowLimit: nextRowLimit };
        if (
          nextRowLimit < 0 ||
          nextRowLimit > base.instanceWords / INSTANCE_WORDS ||
          !Number.isInteger(nextRowLimit)
        )
          throw new Error('canonical projection row limit exceeds its immutable allocation');
        const packed = packSdfSceneTexture(plan, nextEpoch).unwrap();
        // Invalidate before publishing a different expected tuple. This also
        // covers source revisions with no physical placement mutation.
        invalidateSdfSceneTexture(device, texture, nextEpoch).unwrap();
        device.queue.writeBuffer(parameters.buffer, 0, packed).unwrap();
        expected = Object.freeze([base.instanceWords, base.fieldWords, nextRowLimit, nextEpoch]);
        submitted = 0;
      },
      record(pass: RhiComputePassEncoder) {
        return kernel.record(pass, input, parameters, view, { ...base, rowLimit: expected[2] });
      },
      submitted(epochAtEncoding: number) {
        if (epochAtEncoding === expected[3]) submitted = epochAtEncoding;
      },
      dispose() {
        device.destroyBuffer(parameters.buffer);
        device.destroyTexture(texture);
      },
    };
  } catch (cause) {
    if (params !== undefined) device.destroyBuffer(params.buffer);
    device.destroyTexture(texture);
    throw cause;
  }
}
