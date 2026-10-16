import {
  createSurfaceMaterialBindings,
  type ResolveSurfaceTexture,
  referenceSurfaceMaterialSnapshot,
} from './material-bindings';
import { packLights, packSettings, type RayPathSettings } from './path-input';
import { INITIAL_PATH_RAYS_WGSL, packInitialPathRays } from './path-source';

export type { RayPathCamera, RayPathInitialRay, RayPathSettings } from './path-input';

import type {
  GraphAccess,
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  Buffer,
  ComputePipeline,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import {
  admitRayMaterial,
  admitRayMaterialValues,
  type MaterialShaderEntry,
  type RayMaterialError,
  type RaySurfaceProgram,
  rayMaterialContract,
  rayMaterialNeedsCoverage,
  type ShaderError,
  type ShaderRegistry,
} from '@forgeax/engine-shader';
import { err, type MaterialAsset, ok, type Result } from '@forgeax/engine-types';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import { DeviceScope } from '../device/device-scope';
import {
  DIRECT_DFG_LUT_DESCRIPTOR,
  getOrCreateDirectDfgLut,
  materialUsesDirectDfgLut,
} from '../device/direct-dfg-lut';
import {
  type LightSnapshot,
  type MaterialSnapshot,
  materialTextureValue,
} from '../render-system-extract';
import {
  RAY_ATTRIBUTE_TRIANGLE_STRIDE,
  RAY_MATERIAL_INPUT_STRIDE,
  RAY_MATERIAL_SURFACE_STRIDE,
  type RaySurfaceScene,
} from './attributes';
import { type RayReferenceError, rayReferenceFailure } from './scene';

export interface RayPathMaterial {
  readonly id: number;
  readonly program: RaySurfaceProgram;
  /** Resolved snapshot produced by cookRayMaterial from the authored MaterialAsset. */
  readonly asset: MaterialAsset;
}
export interface RayPathTracer {
  readonly buffers: Readonly<
    Record<
      | 'triangles'
      | 'nodes'
      | 'attributes'
      | 'paths'
      | 'inputs'
      | 'surfaces'
      | 'accumulation'
      | 'lights'
      | 'settings'
      | 'coverage',
      Buffer
    >
  >;
  readonly pixelCount: number;
  /** Dispatches per sample; direct and Graph recording share compatible compute batches. */
  readonly dispatchCount: number;
  /** One generate, per-bounce trace/material/shade, then one raw HDR accumulation. Caller submits. */
  recordSample(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  /** The same sample stages, with graph-owned passes and explicit borrowed inputs.
   * The caller retires the compiled graph before disposing this frozen transport. */
  addSampleToGraph<Frame extends RenderGraphFrame>(
    graph: RenderGraphBuilder<Frame>,
    input: {
      readonly label: string;
      readonly buffers: ReadonlyMap<Buffer, GraphBuffer>;
      readonly textures: ReadonlyMap<TextureView, GraphTextureView>;
      readonly reset: boolean;
    },
  ): Result<GraphBuffer, RenderGraphError | RayReferenceError>;
  /** Ordered GPU reset; no host write can overtake already encoded samples. */
  reset(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  dispose(): void;
}
export const RAY_COVERAGE_CANDIDATES = 64;
/** Encoded candidate rounds per coverage query; GPU-written counts size each round. */
export const RAY_COVERAGE_ROUNDS = 3;
/** Header of the coverage buffer; `overflow` (u32 at byte 12) counts queries the rounds left unresolved. */
export const RAY_COVERAGE_HEADER = 32;
export const RAY_COVERAGE_QUERY_STRIDE = 80;
/**
 * Masked candidates one round can pool. Rays the full pool turns away retry next
 * round; a ray still unresolved after the last round is an invalid sample counted
 * in the coverage header `overflow`.
 */
export function rayCoveragePoolCapacity(pixels: number): number {
  return Math.max(1024, Math.ceil(pixels / 2));
}
export const RAY_PATH_STRIDE = 80;
export const RAY_ACCUMULATION_STRIDE = 80;
type Failure = RhiError | RayReferenceError | RayMaterialError | ShaderError;
type CompileShader = (
  device: RhiDevice,
  desc: { code: string; label?: string },
) => Promise<Result<ShaderModule, RhiError>>;

interface RayTransportInputs {
  readonly kernel: string;
  /** Build-time DIRECT_DFG_LUT_AVAILABLE variant; required only by LUT material roots. */
  readonly kernelLut?: string;
  /** The existing Renderer/bake lifetime; standalone transport owns a private scope. */
  readonly deviceScope?: DeviceScope;
  readonly scene: RaySurfaceScene;
  readonly lights: readonly LightSnapshot[];
  readonly settings: RayPathSettings;
  /** `'both'` traverses every triangle two-sided regardless of material culling
   * (first-hit visibility probes); `'material'` (default) honours each cullMode. */
  readonly faces?: 'material' | 'both';
}
interface TransportMaterial {
  readonly id: number;
  readonly program: MaterialShaderEntry;
  readonly snapshot: MaterialSnapshot;
  readonly evaluateCoverage: boolean;
  readonly resolveTexture?: (parameter: string) => ReturnType<ResolveSurfaceTexture>;
}

/** Frozen source/reference transport; materials cross the linear snapshot boundary once. */
export async function createRayPathTracer(
  device: RhiDevice,
  compile: CompileShader,
  request: RayTransportInputs & {
    readonly materials: readonly RayPathMaterial[];
    readonly resolveTexture?: ResolveSurfaceTexture;
  },
): Promise<Result<RayPathTracer, Failure>> {
  const materials: TransportMaterial[] = [];
  for (const material of request.materials) {
    if (material.program.context !== 'ray-hit')
      return rayReferenceFailure('path tracing requires a ray-hit material context');
    const admitted = admitRayMaterial(material.asset, String(material.id));
    if (!admitted.ok) return admitted;
    if (rayMaterialContract(material.asset) !== material.program.contract)
      return rayReferenceFailure('material contract changed; recook its ray program');
    materials.push({
      id: material.id,
      program: { source: material.program.wgsl, paramSchema: material.program.paramSchema },
      snapshot: referenceSurfaceMaterialSnapshot(material),
      evaluateCoverage: rayMaterialNeedsCoverage(material.asset),
      resolveTexture: (parameter) => {
        const value = materialTextureValue(material.asset.values?.[parameter]);
        return value && request.resolveTexture
          ? request.resolveTexture(value)
          : rayReferenceFailure(`missing texture binding ${parameter}`);
      },
    });
  }
  return createRayPathTransport(device, compile, { ...request, materials });
}

/** Accepted Renderer materials use the same transport without reconstructing author assets. */
export async function createSubmittedRayPathTracer(
  device: RhiDevice,
  compile: CompileShader,
  request: RayTransportInputs & {
    /** The candidate owner's existing scene/material/device fence, also checked at frame submission. */
    readonly generationFence: RendererGenerationFence;
    readonly materials: readonly { readonly id: number; readonly snapshot: MaterialSnapshot }[];
    readonly shaders: ShaderRegistry;
    readonly resolveTexture?: (
      materialId: number,
      parameter: string,
    ) => ReturnType<ResolveSurfaceTexture>;
  },
): Promise<Result<RayPathTracer, Failure>> {
  const current = () =>
    request.generationFence.currentGeneration() === request.generationFence.capturedGeneration;
  const stale = (): Result<never, RayReferenceError> =>
    err({
      code: 'ray-reference-stale',
      expected: 'the accepted scene, material and device generation still owns this preparation',
      hint: 'Release borrowed texture leases and prepare the current accepted snapshot; do not submit this candidate.',
      detail: { cause: 'the candidate owner changed while preparing submitted ray transport' },
    });
  if (!current()) return stale();
  const materials: TransportMaterial[] = [];
  for (const { id, snapshot } of request.materials) {
    const ray = snapshot.materialSurfacePrograms?.['ray-hit'];
    if (ray === undefined) return rayReferenceFailure(`material ${id} has no accepted ray program`);
    const shader = request.shaders.findMaterialArtifact(ray.programKey);
    if (!shader.ok) return shader;
    const values = {
      ...Object.fromEntries(
        shader.value.paramSchema.map((parameter) => [parameter.name, parameter.default]),
      ),
      ...snapshot.paramSnapshot,
    };
    const admitted = admitRayMaterialValues(values, String(id), ray.programKey);
    if (!admitted.ok) return admitted;
    if (
      snapshot.renderState?.blend !== undefined ||
      snapshot.surfaceModel === 'single-layer-medium'
    )
      return rayReferenceFailure(`material ${id} requires unsupported scattering`);
    materials.push({
      id,
      program: shader.value,
      snapshot,
      evaluateCoverage: ray.evaluateCoverage,
      resolveTexture: (parameter) =>
        request.resolveTexture
          ? request.resolveTexture(id, parameter)
          : rayReferenceFailure(`missing texture binding ${parameter}`),
    });
  }
  const prepared = await createRayPathTransport(device, compile, { ...request, materials });
  if (!prepared.ok) return prepared;
  if (!current()) {
    prepared.value.dispose();
    return stale();
  }
  return prepared;
}

/** One frozen GPU transport; textures and optional GPU initial rays remain borrowed. */
async function createRayPathTransport(
  device: RhiDevice,
  compile: CompileShader,
  request: RayTransportInputs & { readonly materials: readonly TransportMaterial[] },
): Promise<Result<RayPathTracer, Failure>> {
  const settings = packSettings(request.settings);
  if (!settings.ok) return settings;
  const lights = packLights(request.lights);
  if (!lights.ok) return lights;
  const pixels = request.settings.width * request.settings.height;
  const usesLut = request.materials.some((material) =>
    materialUsesDirectDfgLut(material.program.paramSchema),
  );
  const kernelSource = usesLut ? request.kernelLut : request.kernel;
  if (kernelSource === undefined)
    return rayReferenceFailure(
      'LUT material requires the cooked DIRECT_DFG_LUT_AVAILABLE path kernel',
    );
  const maxBounces = request.settings.maxBounces;
  if (
    request.materials.length > 32 ||
    new Set(request.materials.map((m) => m.id)).size !== request.materials.length ||
    request.materials.some((m) => !Number.isInteger(m.id) || m.id < 0 || m.id > 0xffffffff)
  )
    return rayReferenceFailure('expected at most 32 distinct u32 material IDs', true);
  const masked = new Set(
    request.materials
      .filter((material) => material.evaluateCoverage)
      .map((material) => material.id),
  );
  const hasCoverage = masked.size > 0;
  new Float32Array(settings.value.buffer)[7] = hasCoverage ? 1 : 0;
  new Float32Array(settings.value.buffer)[11] = request.lights.length;
  const triangles = request.scene.triangles.slice();
  const triangleView = new DataView(triangles.buffer);
  const materialById = new Map(request.materials.map((m) => [m.id, m]));
  for (let i = 0; i < request.scene.triangleCount; i++) {
    const material = materialById.get(triangleView.getUint32(i * 80 + 60, true));
    if (!material) return rayReferenceFailure('triangle references an absent material');
    const instance = triangleView.getUint32(i * 80 + 48, true);
    const coordinates = material.snapshot.textureCoordinates;
    for (const entry of material.program.paramSchema.filter((p) => p.type === 'texture2d')) {
      if (
        entry.name === 'normalTexture' &&
        !request.scene.instanceAttributes.get(instance)?.tangentFrame
      )
        return rayReferenceFailure(
          `instance ${instance} normal texture requires authored normals and tangents`,
        );
      const set = coordinates?.get(entry.name)?.set ?? 0;
      if (set >= (request.scene.instanceAttributes.get(instance)?.uvCount ?? 0))
        return rayReferenceFailure(`instance ${instance} is missing material UV set ${set}`);
    }
    const cull = material.snapshot.renderState?.cullMode ?? 'back';
    const winding = new DataView(
      request.scene.attributes.buffer,
      request.scene.attributes.byteOffset,
    ).getFloat32(i * RAY_ATTRIBUTE_TRIANGLE_STRIDE + 108, true);
    const side = request.faces === 'both' ? 0 : cull === 'back' ? 1 : cull === 'front' ? 2 : 0;
    triangleView.setUint32(i * 80 + 68, winding < 0 && side !== 0 ? 3 - side : side, true);
    triangleView.setUint32(i * 80 + 72, masked.has(material.id) ? 1 : 0, true);
  }
  const descriptors = new Map<Buffer, { label: string; size: number; usage: number }>();
  const lutScope = usesLut ? (request.deviceScope ?? DeviceScope.create(0, 'ray-path')) : undefined;
  const ownedScope = request.deviceScope === undefined ? lutScope : undefined;
  const dispose = () => {
    for (const buffer of descriptors.keys()) device.destroyBuffer(buffer);
    descriptors.clear();
    ownedScope?.dispose();
  };
  const lut = lutScope === undefined ? undefined : getOrCreateDirectDfgLut(device, lutScope);
  if (lut !== undefined && !lut.ok) {
    dispose();
    return lut;
  }
  const directDfgLut = lut?.value;
  const make = (label: string, bytes: Uint8Array, uniform = false): Result<Buffer, RhiError> => {
    const buffer = device.createBuffer({
      label: `ray-path.${label}`,
      size: bytes.byteLength,
      usage: (uniform ? 0x40 : 0x80) | 0x0c,
    });
    if (!buffer.ok) return buffer;
    descriptors.set(buffer.value, {
      label,
      size: bytes.byteLength,
      usage: (uniform ? 0x40 : 0x80) | 0x0c,
    });
    const wrote = device.queue.writeBuffer(buffer.value, 0, bytes);
    return wrote.ok ? buffer : wrote;
  };
  // Masked coverage candidates share one pool in the tail of inputs/surfaces; the
  // pixel region rounds up so the pool range satisfies storage offset alignment.
  const poolBase = Math.ceil(pixels / 8) * 8;
  const poolCapacity = hasCoverage ? rayCoveragePoolCapacity(pixels) : 0;
  const materialSlots = hasCoverage ? poolBase + poolCapacity : pixels;
  const coverageHeader = new Uint8Array(
    RAY_COVERAGE_HEADER + (hasCoverage ? pixels : 1) * RAY_COVERAGE_QUERY_STRIDE,
  );
  new Uint32Array(coverageHeader.buffer, 0, 8).set([0, 0, 0, 0, 0, poolCapacity, poolBase, 0]);
  const lightUniform = new Uint8Array(32 * 64);
  lightUniform.set(lights.value);
  const data = {
    triangles,
    nodes: request.scene.nodes,
    attributes: request.scene.attributes,
    paths: new Uint8Array(pixels * RAY_PATH_STRIDE),
    inputs: new Uint8Array(materialSlots * RAY_MATERIAL_INPUT_STRIDE),
    surfaces: new Uint8Array(materialSlots * RAY_MATERIAL_SURFACE_STRIDE),
    accumulation: new Uint8Array(pixels * RAY_ACCUMULATION_STRIDE),
    lights: lightUniform,
    settings: settings.value,
    coverage: coverageHeader,
  };
  const buffers = {} as Record<keyof typeof data, Buffer>;
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    const result = make(key, data[key], key === 'settings' || key === 'lights');
    if (!result.ok) {
      dispose();
      return result;
    }
    buffers[key] = result.value;
  }
  const initialRays =
    request.settings.rays === undefined
      ? undefined
      : packInitialPathRays(request.settings.rays, request.settings.seed);
  let initialRayBuffer = request.settings.rayBuffer;
  const module = await compile(device, { code: kernelSource, label: 'ray-path.kernel' });
  if (!module.ok) {
    dispose();
    return module;
  }
  const kernelEntries = Object.keys(data).map((_, binding) => ({
    binding,
    visibility: 4,
    buffer: {
      type:
        binding === 8 || binding === 7
          ? ('uniform' as const)
          : [0, 1, 2].includes(binding)
            ? ('read-only-storage' as const)
            : ('storage' as const),
    },
  }));
  const kernelLayout = device.createBindGroupLayout({
    entries: [
      ...kernelEntries,
      ...(directDfgLut === undefined
        ? []
        : [
            {
              binding: 10,
              visibility: 4,
              texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
            },
            { binding: 11, visibility: 4, sampler: { type: 'filtering' as const } },
          ]),
    ],
  });
  if (!kernelLayout.ok) {
    dispose();
    return kernelLayout;
  }
  const kernelPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [kernelLayout.value],
  });
  if (!kernelPipelineLayout.ok) {
    dispose();
    return kernelPipelineLayout;
  }
  const kernelBindings = device.createBindGroup({
    layout: kernelLayout.value,
    entries: [
      ...Object.values(buffers).map((buffer, binding) => ({
        binding,
        resource: { kind: 'buffer' as const, value: { buffer } },
      })),
      ...(directDfgLut === undefined
        ? []
        : [
            { binding: 10, resource: { kind: 'textureView' as const, value: directDfgLut.view } },
            { binding: 11, resource: { kind: 'sampler' as const, value: directDfgLut.sampler } },
          ]),
    ],
  });
  if (!kernelBindings.ok) {
    dispose();
    return kernelBindings;
  }
  const names = [
    'generate',
    'trace',
    'shade',
    'accumulate',
    'beginCoverage',
    'gather',
    'resolve',
    'sealCoverage',
    'beginShadow',
    'gatherShadow',
    'resolveShadow',
    'endShadow',
  ] as const;
  // Single-thread producers of GPU-written workgroup counts (WGSL group 1).
  const producers = ['armMaterials', 'armRound'] as const;
  const indirect = device.caps.indirectDrawing;
  const argsUsage = 0x80 | (indirect ? 0x100 : 0);
  const args = hasCoverage
    ? device.createBuffer({ label: 'ray-path.dispatch-args', size: 24, usage: argsUsage })
    : undefined;
  if (args !== undefined) {
    if (!args.ok) {
      dispose();
      return args;
    }
    descriptors.set(args.value, { label: 'dispatch-args', size: 24, usage: argsUsage });
  }
  const argsBuffer = args?.ok ? args.value : undefined;
  const argsLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
  });
  if (!argsLayout.ok) {
    dispose();
    return argsLayout;
  }
  // Producers bind only `coverage` in group 0: the full kernel group already holds
  // the 8 storage buffers WebGPU guarantees per stage.
  const coverageLayout = device.createBindGroupLayout({
    entries: [{ binding: 9, visibility: 4, buffer: { type: 'storage' } }],
  });
  if (!coverageLayout.ok) {
    dispose();
    return coverageLayout;
  }
  const producerLayout = device.createPipelineLayout({
    bindGroupLayouts: [coverageLayout.value, argsLayout.value],
  });
  if (!producerLayout.ok) {
    dispose();
    return producerLayout;
  }
  const pipelines = {} as Record<
    (typeof names)[number] | (typeof producers)[number],
    ComputePipeline
  >;
  for (const name of [...names, ...(hasCoverage ? producers : [])]) {
    const result = device.createComputePipeline({
      label: `ray-path.${name}`,
      layout: (producers as readonly string[]).includes(name)
        ? producerLayout.value
        : kernelPipelineLayout.value,
      compute: { module: module.value, entryPoint: name },
    });
    if (!result.ok) {
      dispose();
      return result;
    }
    pipelines[name] = result.value;
  }
  let argsBindings: readonly [BindGroup, BindGroup] | undefined;
  if (argsBuffer !== undefined) {
    const header = device.createBindGroup({
      layout: coverageLayout.value,
      entries: [{ binding: 9, resource: { kind: 'buffer', value: { buffer: buffers.coverage } } }],
    });
    if (!header.ok) {
      dispose();
      return header;
    }
    const group = device.createBindGroup({
      layout: argsLayout.value,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: argsBuffer } } }],
    });
    if (!group.ok) {
      dispose();
      return group;
    }
    argsBindings = [header.value, group.value];
  }
  type Work = {
    label: string;
    pipeline: ComputePipeline;
    bindings: readonly BindGroup[];
    buffers: readonly {
      buffer: Buffer;
      usage: 'storage-read' | 'storage-read-write' | 'uniform-read' | 'indirect-read';
    }[];
    textures: readonly TextureView[];
    /** Direct workgroup count; with `indirect`, only the fallback without indirect dispatch. */
    workgroups: number;
    /** Byte offset of GPU-written workgroup counts in the dispatch-args buffer. */
    indirect?: number;
  };
  const pixelGroups = Math.ceil(pixels / 64);
  // Derive conservative bound-resource accesses from the same kernel binding layout.
  // RHI Debug retains shader entry points for finer per-dispatch usage inspection.
  const kernelResources: Work['buffers'] = Object.values(buffers).map((buffer, binding) => ({
    buffer,
    usage:
      kernelEntries[binding]?.buffer.type === 'uniform'
        ? 'uniform-read'
        : kernelEntries[binding]?.buffer.type === 'read-only-storage'
          ? 'storage-read'
          : 'storage-read-write',
  }));
  let generation: Work = {
    pipeline: pipelines.generate,
    bindings: [kernelBindings.value],
    label: 'ray-path.generate',
    buffers: kernelResources,
    textures: directDfgLut === undefined ? [] : [directDfgLut.view],
    workgroups: pixelGroups,
  };
  if (initialRays !== undefined) {
    const seeds = make('initial-rays', initialRays);
    if (!seeds.ok) {
      dispose();
      return seeds;
    }
    initialRayBuffer = seeds.value;
  }
  if (initialRayBuffer !== undefined) {
    const layout = device.createBindGroupLayout({
      entries: [0, 1, 2].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: binding === 0 ? ('read-only-storage' as const) : ('storage' as const) },
      })),
    });
    if (!layout.ok) {
      dispose();
      return layout;
    }
    const group = device.createBindGroup({
      layout: layout.value,
      entries: [initialRayBuffer, buffers.paths, buffers.accumulation].map((buffer, binding) => ({
        binding,
        resource: { kind: 'buffer' as const, value: { buffer, size: pixels * RAY_PATH_STRIDE } },
      })),
    });
    if (!group.ok) {
      dispose();
      return group;
    }
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
    if (!pipelineLayout.ok) {
      dispose();
      return pipelineLayout;
    }
    const shader = await compile(device, {
      code: INITIAL_PATH_RAYS_WGSL,
      label: 'ray-path.initial-rays',
    });
    if (!shader.ok) {
      dispose();
      return shader;
    }
    const pipeline = device.createComputePipeline({
      layout: pipelineLayout.value,
      compute: { module: shader.value, entryPoint: 'generateInitialRays' },
    });
    if (!pipeline.ok) {
      dispose();
      return pipeline;
    }
    generation = {
      pipeline: pipeline.value,
      bindings: [group.value],
      label: 'ray-path.initial-rays',
      buffers: [
        { buffer: initialRayBuffer, usage: 'storage-read' },
        { buffer: buffers.paths, usage: 'storage-read-write' },
        { buffer: buffers.accumulation, usage: 'storage-read-write' },
      ],
      textures: [],
      workgroups: pixelGroups,
    };
  }
  const materialLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 4, buffer: { type: 'storage' } },
      { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
    ],
  });
  if (!materialLayout.ok) {
    dispose();
    return materialLayout;
  }
  // Each material evaluates either the pixel slots or, through GPU-written counts,
  // the pooled coverage candidates of one round.
  const materialWork: { id: number; pixel: Work; pool: Work }[] = [];
  for (const m of request.materials) {
    const materialBindings = createSurfaceMaterialBindings(
      device,
      m.program.paramSchema,
      m.snapshot,
      4,
      m.resolveTexture,
    );
    if (!materialBindings.ok) {
      dispose();
      return materialBindings;
    }
    descriptors.set(materialBindings.value.uniform, {
      label: `material-${m.id}.uniform`,
      size: materialBindings.value.bytes,
      usage: 72,
    });
    const selector = make(
      `material-selector-${m.id}`,
      new Uint8Array(new Uint32Array([m.id, 0, 0, 0]).buffer),
      true,
    );
    if (!selector.ok) {
      dispose();
      return selector;
    }
    const slotBindings = (first: number, count: number) =>
      device.createBindGroup({
        layout: materialLayout.value,
        entries: [
          { buffer: buffers.inputs, stride: RAY_MATERIAL_INPUT_STRIDE },
          { buffer: buffers.surfaces, stride: RAY_MATERIAL_SURFACE_STRIDE },
          { buffer: selector.value, stride: 0 },
        ].map(({ buffer, stride }, binding) => ({
          binding,
          resource: {
            kind: 'buffer' as const,
            value:
              stride === 0 ? { buffer } : { buffer, offset: first * stride, size: count * stride },
          },
        })),
      });
    const workBindings = slotBindings(0, pixels);
    if (!workBindings.ok) {
      dispose();
      return workBindings;
    }
    const poolBindings = hasCoverage ? slotBindings(poolBase, poolCapacity) : workBindings;
    if (!poolBindings.ok) {
      dispose();
      return poolBindings;
    }
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [materialLayout.value, materialBindings.value.layout],
    });
    if (!layout.ok) {
      dispose();
      return layout;
    }
    const shader = await compile(device, {
      code: m.program.source,
      label: `ray-path.material-${m.id}`,
    });
    if (!shader.ok) {
      dispose();
      return shader;
    }
    const pipeline = device.createComputePipeline({
      label: `ray-path.material-${m.id}`,
      layout: layout.value,
      compute: { module: shader.value, entryPoint: 'cs_surface' },
    });
    if (!pipeline.ok) {
      dispose();
      return pipeline;
    }
    const pixel: Work = {
      label: `ray-path.material-${m.id}`,
      pipeline: pipeline.value,
      buffers: [
        { buffer: buffers.inputs, usage: 'storage-read' },
        { buffer: buffers.surfaces, usage: 'storage-read-write' },
        { buffer: selector.value, usage: 'uniform-read' },
        { buffer: materialBindings.value.uniform, usage: 'uniform-read' },
      ],
      textures: materialBindings.value.textureViews,
      bindings: [workBindings.value, materialBindings.value.group],
      workgroups: pixelGroups,
    };
    materialWork.push({
      id: m.id,
      pixel,
      pool: {
        ...pixel,
        label: `ray-path.pool-material-${m.id}`,
        bindings: [poolBindings.value, materialBindings.value.group],
        workgroups: Math.ceil(poolCapacity / 64),
        ...(argsBuffer !== undefined && indirect
          ? {
              indirect: 0,
              buffers: [...pixel.buffers, { buffer: argsBuffer, usage: 'indirect-read' as const }],
            }
          : {}),
      },
    });
  }
  let disposed = false;
  const works: Work[] = [];
  works.push(generation);
  const deferred = (work: Omit<Work, 'workgroups' | 'indirect'>): Work =>
    argsBuffer !== undefined && indirect
      ? {
          ...work,
          workgroups: pixelGroups,
          indirect: 12,
          buffers: [...work.buffers, { buffer: argsBuffer, usage: 'indirect-read' }],
        }
      : { ...work, workgroups: pixelGroups };
  for (let bounce = 0; bounce < maxBounces; bounce++) {
    const kernel = (name: (typeof names)[number], round = 0): Work => ({
      label: `ray-path.${name}-${bounce}${round > 0 ? `-round-${round}` : ''}`,
      pipeline: pipelines[name],
      bindings: [kernelBindings.value],
      buffers: kernelResources,
      textures: directDfgLut === undefined ? [] : [directDfgLut.view],
      workgroups: pixelGroups,
    });
    const produce = (name: (typeof producers)[number]): Work => {
      if (argsBuffer === undefined || argsBindings === undefined)
        return rayReferenceFailure('coverage rounds require dispatch args').unwrap();
      return {
        label: `ray-path.${name}-${bounce}`,
        pipeline: pipelines[name],
        bindings: argsBindings,
        buffers: [
          { buffer: buffers.coverage, usage: 'storage-read-write' },
          { buffer: argsBuffer, usage: 'storage-read-write' },
        ],
        textures: [],
        workgroups: 1,
      };
    };
    // Every pixel gathers in round 0; later rounds see only the rays the full pool
    // deferred. Dispatch count is independent of candidate depth.
    const rounds = (gather: 'gather' | 'gatherShadow', resolve: 'resolve' | 'resolveShadow') => {
      for (let round = 0; round < RAY_COVERAGE_ROUNDS; round++) {
        const sized = (name: typeof gather | typeof resolve) =>
          round === 0 ? kernel(name) : deferred(kernel(name, round));
        works.push(sized(gather), produce('armMaterials'));
        for (const m of materialWork) if (masked.has(m.id)) works.push(m.pool);
        works.push(sized(resolve));
        if (round + 1 < RAY_COVERAGE_ROUNDS) works.push(produce('armRound'));
      }
    };
    if (!hasCoverage) {
      works.push(kernel('trace'), ...materialWork.map((m) => m.pixel), kernel('shade'));
      continue;
    }
    works.push(kernel('beginCoverage'));
    rounds('gather', 'resolve');
    // Opaque hits need one Surface evaluation after candidate resolution,
    // rather than once per rejected alpha layer.
    for (const m of materialWork) if (!masked.has(m.id)) works.push(m.pixel);
    works.push(kernel('sealCoverage'));
    // Analytic lights and one environment NEE ray reuse the same bounded query storage.
    for (let light = 0; light <= request.lights.length; light++) {
      works.push(kernel('beginShadow'));
      rounds('gatherShadow', 'resolveShadow');
      works.push(kernel('endShadow'));
    }
    works.push(kernel('shade'));
  }
  works.push({
    label: 'ray-path.accumulate',
    pipeline: pipelines.accumulate,
    bindings: [kernelBindings.value],
    buffers: kernelResources,
    textures: directDfgLut === undefined ? [] : [directDfgLut.view],
    workgroups: pixelGroups,
  });

  // WebGPU orders storage writes between dispatches of one compute pass, so
  // consecutive works share one compute pass whenever their declared usages
  // merge into one compatible usage scope (reads upgrade to read-write).
  const batches: { works: Work[]; usages: Map<Buffer, Work['buffers'][number]['usage']> }[] = [];
  for (const work of works) {
    const last = batches[batches.length - 1];
    const merged = new Map(last?.usages);
    const compatible =
      last !== undefined &&
      work.buffers.every(({ buffer, usage }) => {
        const prior = merged.get(buffer);
        if (prior === undefined || prior === usage) {
          merged.set(buffer, usage);
          return true;
        }
        // Indirect arguments and uniforms never share a usage scope with storage.
        if ([prior, usage].some((u) => u === 'uniform-read' || u === 'indirect-read')) return false;
        merged.set(buffer, 'storage-read-write');
        return true;
      });
    if (compatible) {
      last.works.push(work);
      last.usages = merged;
    } else
      batches.push({
        works: [work],
        usages: new Map(work.buffers.map(({ buffer, usage }) => [buffer, usage])),
      });
  }

  const record = (pass: RhiComputePassEncoder, work: Work) => {
    if (disposed) rayReferenceFailure('path tracer is disposed').unwrap();
    pass.setPipeline(work.pipeline);
    work.bindings.forEach((group, index) => {
      pass.setBindGroup(index, group);
    });
    if (work.indirect !== undefined && argsBuffer !== undefined)
      pass.dispatchWorkgroupsIndirect(argsBuffer, work.indirect);
    else pass.dispatchWorkgroups(work.workgroups, 1, 1);
  };
  return ok({
    buffers,
    pixelCount: pixels,
    dispatchCount: works.length,
    recordSample(encoder) {
      if (disposed) return rayReferenceFailure('path tracer is disposed');
      for (const [index, batch] of batches.entries()) {
        const pass = encoder.beginComputePass({ label: `ray-path.${index}.batch` });
        for (const work of batch.works) record(pass, work);
        pass.end();
      }
      return ok(undefined);
    },
    addSampleToGraph(graph, input) {
      if (disposed) return rayReferenceFailure('path tracer is disposed');
      // Borrowed resources must reuse their producer's graph address. Silently
      // importing an alias would hide the producer -> transport dependency.
      const graphBuffers = new Map(input.buffers);
      const graphTextures = new Map(input.textures);
      // Immutable upload has no graph writer. Import its existing view once so
      // each sampled-read retains the same resource identity as the bind group.
      if (directDfgLut !== undefined && !graphTextures.has(directDfgLut.view)) {
        const texture = graph.importTexture(
          `${input.label}.direct-dfg`,
          DIRECT_DFG_LUT_DESCRIPTOR,
          () => directDfgLut.texture,
        );
        if (!texture.ok) return texture;
        const view = graph.importView(texture.value, { dimension: '2d' }, () => directDfgLut.view);
        if (!view.ok) return view;
        graphTextures.set(directDfgLut.view, view.value);
      }
      const required = <K, V>(map: ReadonlyMap<K, V>, key: K): V => {
        const value = map.get(key);
        if (value === undefined)
          return rayReferenceFailure('transport graph resource was not admitted').unwrap();
        return value;
      };
      for (const work of works) {
        for (const { buffer } of work.buffers) {
          if (!descriptors.has(buffer) && !graphBuffers.has(buffer))
            return rayReferenceFailure('borrowed ray buffer has no producer graph resource');
        }
        for (const view of work.textures) {
          if (!graphTextures.has(view))
            return rayReferenceFailure('material texture has no producer graph resource');
        }
      }
      for (const [buffer, descriptor] of descriptors) {
        if (graphBuffers.has(buffer)) continue;
        const imported = graph.importBuffer(
          `${input.label}.${descriptor.label}`,
          descriptor,
          () => buffer,
        );
        if (!imported.ok) return imported;
        graphBuffers.set(buffer, imported.value);
      }
      const accumulation = required(graphBuffers, buffers.accumulation);
      if (input.reset) {
        const reset = graph.addCopyPass(`${input.label}.reset`, {
          accesses: [{ resource: accumulation, usage: 'copy-dst' }],
          encode: ({ encoder, resources }) => {
            if (disposed) rayReferenceFailure('path tracer is disposed').unwrap();
            const resolved = resources.buffer(accumulation).unwrap();
            if (resolved !== buffers.accumulation)
              rayReferenceFailure('transport buffer generation changed').unwrap();
            encoder.clearBuffer(resolved);
          },
        });
        if (!reset.ok) return reset;
      }
      for (const [index, batch] of batches.entries()) {
        const textures = new Set(batch.works.flatMap((work) => work.textures));
        const accesses: GraphAccess[] = [
          ...[...batch.usages].map(([buffer, usage]) => ({
            resource: required(graphBuffers, buffer),
            usage,
          })),
          ...[...textures].map((view) => ({
            resource: required(graphTextures, view),
            usage: 'sampled-read' as const,
          })),
        ];
        const added = graph.addComputePass(`${input.label}.${index}.ray-path.batch`, {
          accesses,
          encode: ({ pass, resources }) => {
            // Frozen bind groups may not sample a different generation from the
            // one declared by the frame graph.
            for (const buffer of batch.usages.keys())
              if (resources.buffer(required(graphBuffers, buffer)).unwrap() !== buffer)
                rayReferenceFailure('transport buffer generation changed').unwrap();
            for (const view of textures)
              if (resources.textureView(required(graphTextures, view)).unwrap() !== view)
                rayReferenceFailure('transport texture generation changed').unwrap();
            for (const work of batch.works) record(pass, work);
          },
        });
        if (!added.ok) return added;
      }
      return ok(accumulation);
    },
    reset(encoder) {
      if (disposed) return rayReferenceFailure('path tracer is disposed');
      encoder.clearBuffer(buffers.accumulation);
      return ok(undefined);
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        dispose();
      }
    },
  });
}
