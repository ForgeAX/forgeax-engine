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
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  PipelineLayout,
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
  /** Stable-shape scene edits keep the existing pipelines and buffers. Caller fences old graphs. */
  updateScene(
    scene: RaySurfaceScene,
    edit: { readonly triangles: readonly number[]; readonly nodes: readonly number[] },
  ): Result<void, RhiError | RayReferenceError>;
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
        shader.value.paramSchema.map((parameter) => [
          parameter.name,
          'default' in parameter ? parameter.default : undefined,
        ]),
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

type RayPathBufferName = keyof RayPathTracer['buffers'];
type RayPathBufferUsage = 'storage-read' | 'storage-read-write' | 'uniform-read' | 'indirect-read';
type DirectDfgLutResource = Extract<
  ReturnType<typeof getOrCreateDirectDfgLut>,
  { readonly ok: true }
>['value'];
const RAY_PATH_KERNELS = [
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
const RAY_PATH_PRODUCERS = ['armMaterials', 'armRound'] as const;
type RayPathKernelName = (typeof RAY_PATH_KERNELS)[number];
type RayPathProducerName = (typeof RAY_PATH_PRODUCERS)[number];

interface RayPathWork {
  label: string;
  pipeline: ComputePipeline;
  bindings: readonly BindGroup[];
  buffers: readonly { buffer: Buffer; usage: RayPathBufferUsage }[];
  textures: readonly TextureView[];
  /** Direct workgroup count; with `indirect`, only the fallback without indirect dispatch. */
  workgroups: number;
  /** Byte offset of GPU-written workgroup counts in the dispatch-args buffer. */
  indirect?: number;
}

/** Each material evaluates the pixel slots or, through GPU-written counts, one round's pool. */
interface RayPathMaterialWork {
  readonly id: number;
  readonly pixel: RayPathWork;
  readonly pool: RayPathWork;
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
  const usesLut = request.materials.some((material) =>
    materialUsesDirectDfgLut(material.program.paramSchema),
  );
  const kernelSource = usesLut ? request.kernelLut : request.kernel;
  if (kernelSource === undefined)
    return rayReferenceFailure(
      'LUT material requires the cooked DIRECT_DFG_LUT_AVAILABLE path kernel',
    );
  if (!hasDistinctMaterialIds(request.materials))
    return rayReferenceFailure('expected at most 32 distinct u32 material IDs', true);
  const masked = new Set(
    request.materials
      .filter((material) => material.evaluateCoverage)
      .map((material) => material.id),
  );
  new Float32Array(settings.value.buffer)[7] = masked.size > 0 ? 1 : 0;
  new Float32Array(settings.value.buffer)[11] = request.lights.length;
  const triangles = encodeTriangleTraversal(request, masked);
  if (!triangles.ok) return triangles;
  const lutScope = usesLut ? (request.deviceScope ?? DeviceScope.create(0, 'ray-path')) : undefined;
  const assembly = new RayPathTransportAssembly(
    device,
    compile,
    request,
    masked,
    new RayPathResourceOwner(device, request.deviceScope === undefined ? lutScope : undefined),
  );
  return assembly.build(kernelSource, lutScope, triangles.value, settings.value, lights.value);
}

function hasDistinctMaterialIds(materials: readonly TransportMaterial[]): boolean {
  return (
    materials.length <= 32 &&
    new Set(materials.map((m) => m.id)).size === materials.length &&
    materials.every((m) => Number.isInteger(m.id) && m.id >= 0 && m.id <= 0xffffffff)
  );
}

/** Copy the triangle table and stamp each triangle's traversal sidedness and coverage flag. */
function encodeTriangleTraversal(
  request: RayTransportInputs & { readonly materials: readonly TransportMaterial[] },
  masked: ReadonlySet<number>,
  changed?: readonly number[],
): Result<Uint8Array, RayReferenceError> {
  const triangles =
    changed === undefined ? request.scene.triangles.slice() : new Uint8Array(changed.length * 80);
  const triangleView = new DataView(triangles.buffer);
  const materialById = new Map(request.materials.map((m) => [m.id, m]));
  for (let row = 0; row < (changed?.length ?? request.scene.triangleCount); row++) {
    const i = changed?.[row] ?? row;
    if (!Number.isInteger(i) || i < 0 || i >= request.scene.triangleCount)
      return rayReferenceFailure('scene edit references an absent triangle');
    if (changed !== undefined)
      triangles.set(request.scene.triangles.subarray(i * 80, (i + 1) * 80), row * 80);
    const material = materialById.get(triangleView.getUint32(row * 80 + 60, true));
    if (!material) return rayReferenceFailure('triangle references an absent material');
    const instance = triangleView.getUint32(row * 80 + 48, true);
    const attributes = instanceTextureFailure(request.scene, material, instance);
    if (attributes !== undefined) return attributes;
    const winding = new DataView(
      request.scene.attributes.buffer,
      request.scene.attributes.byteOffset,
    ).getFloat32(i * RAY_ATTRIBUTE_TRIANGLE_STRIDE + 108, true);
    const side = traversalSide(request.faces, material.snapshot.renderState?.cullMode ?? 'back');
    triangleView.setUint32(row * 80 + 68, winding < 0 && side !== 0 ? 3 - side : side, true);
    triangleView.setUint32(row * 80 + 72, masked.has(material.id) ? 1 : 0, true);
  }
  return ok(triangles);
}

/** Does the instance carry every UV set and tangent frame its material textures read? */
function instanceTextureFailure(
  scene: RaySurfaceScene,
  material: TransportMaterial,
  instance: number,
): Result<never, RayReferenceError> | undefined {
  const coordinates = material.snapshot.textureCoordinates;
  const attributes = scene.instanceAttributes.get(instance);
  for (const entry of material.program.paramSchema.filter((p) => p.type === 'texture2d')) {
    if (entry.name === 'normalTexture' && !attributes?.tangentFrame)
      return rayReferenceFailure(
        `instance ${instance} normal texture requires authored normals and tangents`,
      );
    const set = coordinates?.get(entry.name)?.set ?? 0;
    if (set >= (attributes?.uvCount ?? 0))
      return rayReferenceFailure(`instance ${instance} is missing material UV set ${set}`);
  }
  return undefined;
}

/** 0 = two-sided, 1 = cull back, 2 = cull front (before winding correction). */
function traversalSide(faces: RayTransportInputs['faces'], cull: string): number {
  if (faces === 'both') return 0;
  if (cull === 'back') return 1;
  return cull === 'front' ? 2 : 0;
}

/** Transport-owned buffers and the optional private device scope, released together. */
class RayPathResourceOwner {
  readonly descriptors = new Map<Buffer, { label: string; size: number; usage: number }>();

  constructor(
    private readonly device: RhiDevice,
    private readonly ownedScope: DeviceScope | undefined,
  ) {}

  make(label: string, bytes: Uint8Array, uniform = false): Result<Buffer, RhiError> {
    const usage = (uniform ? 0x40 : 0x80) | 0x0c;
    const buffer = this.device.createBuffer({
      label: `ray-path.${label}`,
      size: bytes.byteLength,
      usage,
    });
    if (!buffer.ok) return buffer;
    this.descriptors.set(buffer.value, { label, size: bytes.byteLength, usage });
    const wrote = this.device.queue.writeBuffer(buffer.value, 0, bytes);
    return wrote.ok ? buffer : wrote;
  }

  dispose(): void {
    for (const buffer of this.descriptors.keys()) this.device.destroyBuffer(buffer);
    this.descriptors.clear();
    this.ownedScope?.dispose();
  }

  /** Release everything this transport owns, then report the failure. */
  release<E>(failure: Result<never, E>): Result<never, E> {
    this.dispose();
    return failure;
  }
}

/** Build-time sizing and GPU object creation for one transport; never per frame. */
class RayPathTransportAssembly {
  private readonly pixels: number;
  private readonly pixelGroups: number;
  private readonly hasCoverage: boolean;
  // Masked coverage candidates share one pool in the tail of inputs/surfaces; the
  // pixel region rounds up so the pool range satisfies storage offset alignment.
  private readonly poolBase: number;
  private readonly poolCapacity: number;
  private readonly indirect: boolean;

  constructor(
    private readonly device: RhiDevice,
    private readonly compile: CompileShader,
    private readonly request: RayTransportInputs & {
      readonly materials: readonly TransportMaterial[];
    },
    private readonly masked: ReadonlySet<number>,
    private readonly owner: RayPathResourceOwner,
  ) {
    this.pixels = request.settings.width * request.settings.height;
    this.pixelGroups = Math.ceil(this.pixels / 64);
    this.hasCoverage = masked.size > 0;
    this.poolBase = Math.ceil(this.pixels / 8) * 8;
    this.poolCapacity = this.hasCoverage ? rayCoveragePoolCapacity(this.pixels) : 0;
    this.indirect = device.caps.indirectDrawing;
  }

  async build(
    kernelSource: string,
    lutScope: DeviceScope | undefined,
    triangles: Uint8Array,
    settings: Uint8Array,
    lights: Uint8Array,
  ): Promise<Result<RayPathTracer, Failure>> {
    const { device, owner } = this;
    const lut = lutScope === undefined ? undefined : getOrCreateDirectDfgLut(device, lutScope);
    if (lut !== undefined && !lut.ok) return owner.release(lut);
    const directDfgLut = lut?.value;
    const buffers = this.createKernelBuffers(triangles, settings, lights);
    if (!buffers.ok) return owner.release(buffers);
    const initialRays =
      this.request.settings.rays === undefined
        ? undefined
        : packInitialPathRays(this.request.settings.rays, this.request.settings.seed);
    const module = await this.compile(device, { code: kernelSource, label: 'ray-path.kernel' });
    if (!module.ok) return owner.release(module);
    const kernel = this.createKernelBindings(buffers.value, directDfgLut);
    if (!kernel.ok) return owner.release(kernel);
    const producers = this.createCoverageProducers(buffers.value.coverage);
    if (!producers.ok) return owner.release(producers);
    const pipelines = this.createPipelines(
      module.value,
      kernel.value.pipelineLayout,
      producers.value.layout,
    );
    if (!pipelines.ok) return owner.release(pipelines);
    const argsBindings = this.createProducerBindings(producers.value);
    if (!argsBindings.ok) return owner.release(argsBindings);
    const kernelWork: RayPathKernelRecording = {
      pipelines: pipelines.value,
      group: kernel.value.group,
      resources: kernel.value.resources,
      textures: directDfgLut === undefined ? [] : [directDfgLut.view],
      coverage: buffers.value.coverage,
      args: producers.value.args,
      argsBindings: argsBindings.value,
      pixelGroups: this.pixelGroups,
      indirect: this.indirect,
    };
    const generation = await this.createGenerationWork(kernelWork, buffers.value, initialRays);
    if (!generation.ok) return owner.release(generation);
    const materialWork = await this.createMaterialWorks(buffers.value, producers.value.args);
    if (!materialWork.ok) return owner.release(materialWork);
    const works = scheduleRayPathWorks(
      kernelWork,
      generation.value,
      materialWork.value,
      this.masked,
      this.request,
    );
    return ok(
      freezeRayPathTracer(
        owner,
        buffers.value,
        this.pixels,
        works,
        producers.value.args,
        directDfgLut,
        (scene, edit) => this.updateScene(buffers.value, scene, edit),
      ),
    );
  }

  private updateScene(
    buffers: Record<RayPathBufferName, Buffer>,
    scene: RaySurfaceScene,
    edit: { readonly triangles: readonly number[]; readonly nodes: readonly number[] },
  ): Result<void, RhiError | RayReferenceError> {
    if (
      scene.triangles.byteLength !== this.request.scene.triangles.byteLength ||
      scene.nodes.byteLength !== this.request.scene.nodes.byteLength ||
      scene.attributes.byteLength !== this.request.scene.attributes.byteLength
    )
      return rayReferenceFailure('scene edit changes the transport buffer shape');
    for (const node of edit.nodes)
      if (!Number.isInteger(node) || node < 0 || node * 48 >= scene.nodes.byteLength)
        return rayReferenceFailure('scene edit references an absent BVH node');
    // Material admission and all addresses are checked before any live buffer writes.
    const triangles = encodeTriangleTraversal(
      { ...this.request, scene },
      this.masked,
      edit.triangles,
    );
    if (!triangles.ok) return triangles;
    for (let row = 0; row < edit.triangles.length; row++) {
      const index = edit.triangles[row] as number;
      const triangle = this.device.queue.writeBuffer(
        buffers.triangles,
        index * 80,
        triangles.value.subarray(row * 80, (row + 1) * 80),
      );
      if (!triangle.ok) return triangle;
      const attribute = this.device.queue.writeBuffer(
        buffers.attributes,
        index * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
        scene.attributes.subarray(
          index * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
          (index + 1) * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
        ),
      );
      if (!attribute.ok) return attribute;
    }
    for (const index of edit.nodes) {
      const node = this.device.queue.writeBuffer(
        buffers.nodes,
        index * 48,
        scene.nodes.subarray(index * 48, (index + 1) * 48),
      );
      if (!node.ok) return node;
    }
    return ok(undefined);
  }

  private createKernelBuffers(
    triangles: Uint8Array,
    settings: Uint8Array,
    lights: Uint8Array,
  ): Result<Record<RayPathBufferName, Buffer>, RhiError> {
    const { pixels, hasCoverage, poolBase, poolCapacity, request } = this;
    const materialSlots = hasCoverage ? poolBase + poolCapacity : pixels;
    const coverageHeader = new Uint8Array(
      RAY_COVERAGE_HEADER + (hasCoverage ? pixels : 1) * RAY_COVERAGE_QUERY_STRIDE,
    );
    new Uint32Array(coverageHeader.buffer, 0, 8).set([0, 0, 0, 0, 0, poolCapacity, poolBase, 0]);
    const lightUniform = new Uint8Array(32 * 64);
    lightUniform.set(lights);
    const data: Record<RayPathBufferName, Uint8Array> = {
      triangles,
      nodes: request.scene.nodes,
      attributes: request.scene.attributes,
      paths: new Uint8Array(pixels * RAY_PATH_STRIDE),
      inputs: new Uint8Array(materialSlots * RAY_MATERIAL_INPUT_STRIDE),
      surfaces: new Uint8Array(materialSlots * RAY_MATERIAL_SURFACE_STRIDE),
      accumulation: new Uint8Array(pixels * RAY_ACCUMULATION_STRIDE),
      lights: lightUniform,
      settings,
      coverage: coverageHeader,
    };
    const buffers = {} as Record<RayPathBufferName, Buffer>;
    for (const key of Object.keys(data) as RayPathBufferName[]) {
      const result = this.owner.make(key, data[key], key === 'settings' || key === 'lights');
      if (!result.ok) return result;
      buffers[key] = result.value;
    }
    return ok(buffers);
  }

  private createKernelBindings(
    buffers: Record<RayPathBufferName, Buffer>,
    directDfgLut: DirectDfgLutResource | undefined,
  ) {
    const device = this.device;
    const kernelEntries = Object.keys(buffers).map((_, binding) => ({
      binding,
      visibility: 4,
      buffer: { type: kernelBufferType(binding) },
    }));
    const layout = device.createBindGroupLayout({
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
    if (!layout.ok) return layout;
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
    if (!pipelineLayout.ok) return pipelineLayout;
    const group = device.createBindGroup({
      layout: layout.value,
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
    if (!group.ok) return group;
    // Derive conservative bound-resource accesses from the same kernel binding layout.
    // RHI Debug retains shader entry points for finer per-dispatch usage inspection.
    const resources: RayPathWork['buffers'] = Object.values(buffers).map((buffer, binding) => ({
      buffer,
      usage: kernelResourceUsage(kernelEntries[binding]?.buffer.type),
    }));
    return ok({ pipelineLayout: pipelineLayout.value, group: group.value, resources });
  }

  /** Dispatch-args buffer and the layouts/bindings of its single-thread producers. */
  private createCoverageProducers(coverage: Buffer) {
    const { device, hasCoverage } = this;
    const argsUsage = 0x80 | (this.indirect ? 0x100 : 0);
    const args = hasCoverage
      ? device.createBuffer({ label: 'ray-path.dispatch-args', size: 24, usage: argsUsage })
      : undefined;
    if (args !== undefined) {
      if (!args.ok) return args;
      this.owner.descriptors.set(args.value, {
        label: 'dispatch-args',
        size: 24,
        usage: argsUsage,
      });
    }
    const argsBuffer = args?.ok ? args.value : undefined;
    const argsLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
    });
    if (!argsLayout.ok) return argsLayout;
    // Producers bind only `coverage` in group 0: the full kernel group already holds
    // the 8 storage buffers WebGPU guarantees per stage.
    const coverageLayout = device.createBindGroupLayout({
      entries: [{ binding: 9, visibility: 4, buffer: { type: 'storage' } }],
    });
    if (!coverageLayout.ok) return coverageLayout;
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [coverageLayout.value, argsLayout.value],
    });
    if (!layout.ok) return layout;
    return ok({
      args: argsBuffer,
      argsLayout: argsLayout.value,
      coverageLayout: coverageLayout.value,
      layout: layout.value,
      coverage,
    });
  }

  private createPipelines(
    module: ShaderModule,
    kernelLayout: PipelineLayout,
    producerLayout: PipelineLayout,
  ): Result<Record<RayPathKernelName | RayPathProducerName, ComputePipeline>, RhiError> {
    const pipelines = {} as Record<RayPathKernelName | RayPathProducerName, ComputePipeline>;
    for (const name of [...RAY_PATH_KERNELS, ...(this.hasCoverage ? RAY_PATH_PRODUCERS : [])]) {
      const result = this.device.createComputePipeline({
        label: `ray-path.${name}`,
        layout: (RAY_PATH_PRODUCERS as readonly string[]).includes(name)
          ? producerLayout
          : kernelLayout,
        compute: { module, entryPoint: name },
      });
      if (!result.ok) return result;
      pipelines[name] = result.value;
    }
    return ok(pipelines);
  }

  private createProducerBindings(producers: {
    readonly args: Buffer | undefined;
    readonly argsLayout: BindGroupLayout;
    readonly coverageLayout: BindGroupLayout;
    readonly coverage: Buffer;
  }): Result<readonly [BindGroup, BindGroup] | undefined, RhiError> {
    if (producers.args === undefined) return ok(undefined);
    const header = this.device.createBindGroup({
      layout: producers.coverageLayout,
      entries: [
        { binding: 9, resource: { kind: 'buffer', value: { buffer: producers.coverage } } },
      ],
    });
    if (!header.ok) return header;
    const group = this.device.createBindGroup({
      layout: producers.argsLayout,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: producers.args } } }],
    });
    if (!group.ok) return group;
    return ok([header.value, group.value]);
  }

  /** The default generate kernel, or a pass that seeds paths from supplied initial rays. */
  private async createGenerationWork(
    kernel: RayPathKernelRecording,
    buffers: Record<RayPathBufferName, Buffer>,
    initialRays: Uint8Array | undefined,
  ): Promise<Result<RayPathWork, Failure>> {
    let initialRayBuffer = this.request.settings.rayBuffer;
    if (initialRays !== undefined) {
      const seeds = this.owner.make('initial-rays', initialRays);
      if (!seeds.ok) return seeds;
      initialRayBuffer = seeds.value;
    }
    if (initialRayBuffer === undefined)
      return ok({
        pipeline: kernel.pipelines.generate,
        bindings: [kernel.group],
        label: 'ray-path.generate',
        buffers: kernel.resources,
        textures: kernel.textures,
        workgroups: kernel.pixelGroups,
      });
    return this.createInitialRayWork(initialRayBuffer, buffers);
  }

  private async createInitialRayWork(
    initialRayBuffer: Buffer,
    buffers: Record<RayPathBufferName, Buffer>,
  ): Promise<Result<RayPathWork, Failure>> {
    const device = this.device;
    const layout = device.createBindGroupLayout({
      entries: [0, 1, 2].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: binding === 0 ? ('read-only-storage' as const) : ('storage' as const) },
      })),
    });
    if (!layout.ok) return layout;
    const group = device.createBindGroup({
      layout: layout.value,
      entries: [initialRayBuffer, buffers.paths, buffers.accumulation].map((buffer, binding) => ({
        binding,
        resource: {
          kind: 'buffer' as const,
          value: { buffer, size: this.pixels * RAY_PATH_STRIDE },
        },
      })),
    });
    if (!group.ok) return group;
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
    if (!pipelineLayout.ok) return pipelineLayout;
    const shader = await this.compile(device, {
      code: INITIAL_PATH_RAYS_WGSL,
      label: 'ray-path.initial-rays',
    });
    if (!shader.ok) return shader;
    const pipeline = device.createComputePipeline({
      layout: pipelineLayout.value,
      compute: { module: shader.value, entryPoint: 'generateInitialRays' },
    });
    if (!pipeline.ok) return pipeline;
    return ok({
      pipeline: pipeline.value,
      bindings: [group.value],
      label: 'ray-path.initial-rays',
      buffers: [
        { buffer: initialRayBuffer, usage: 'storage-read' },
        { buffer: buffers.paths, usage: 'storage-read-write' },
        { buffer: buffers.accumulation, usage: 'storage-read-write' },
      ],
      textures: [],
      workgroups: this.pixelGroups,
    });
  }

  private async createMaterialWorks(
    buffers: Record<RayPathBufferName, Buffer>,
    argsBuffer: Buffer | undefined,
  ): Promise<Result<RayPathMaterialWork[], Failure>> {
    const materialLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: 4, buffer: { type: 'storage' } },
        { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
      ],
    });
    if (!materialLayout.ok) return materialLayout;
    const materialWork: RayPathMaterialWork[] = [];
    for (const material of this.request.materials) {
      const work = await this.createMaterialWork(
        material,
        materialLayout.value,
        buffers,
        argsBuffer,
      );
      if (!work.ok) return work;
      materialWork.push(work.value);
    }
    return ok(materialWork);
  }

  private async createMaterialWork(
    m: TransportMaterial,
    materialLayout: BindGroupLayout,
    buffers: Record<RayPathBufferName, Buffer>,
    argsBuffer: Buffer | undefined,
  ): Promise<Result<RayPathMaterialWork, Failure>> {
    const device = this.device;
    const materialBindings = createSurfaceMaterialBindings(
      device,
      m.program.paramSchema,
      m.snapshot,
      4,
      m.resolveTexture,
    );
    if (!materialBindings.ok) return materialBindings;
    this.owner.descriptors.set(materialBindings.value.uniform, {
      label: `material-${m.id}.uniform`,
      size: materialBindings.value.bytes,
      usage: 72,
    });
    const selector = this.owner.make(
      `material-selector-${m.id}`,
      new Uint8Array(new Uint32Array([m.id, 0, 0, 0]).buffer),
      true,
    );
    if (!selector.ok) return selector;
    const slotBindings = (first: number, count: number) =>
      device.createBindGroup({
        layout: materialLayout,
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
    const workBindings = slotBindings(0, this.pixels);
    if (!workBindings.ok) return workBindings;
    const poolBindings = this.hasCoverage
      ? slotBindings(this.poolBase, this.poolCapacity)
      : workBindings;
    if (!poolBindings.ok) return poolBindings;
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [materialLayout, materialBindings.value.layout],
    });
    if (!layout.ok) return layout;
    const shader = await this.compile(device, {
      code: m.program.source,
      label: `ray-path.material-${m.id}`,
    });
    if (!shader.ok) return shader;
    const pipeline = device.createComputePipeline({
      label: `ray-path.material-${m.id}`,
      layout: layout.value,
      compute: { module: shader.value, entryPoint: 'cs_surface' },
    });
    if (!pipeline.ok) return pipeline;
    const pixel: RayPathWork = {
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
      workgroups: this.pixelGroups,
    };
    return ok({
      id: m.id,
      pixel,
      pool: {
        ...pixel,
        label: `ray-path.pool-material-${m.id}`,
        bindings: [poolBindings.value, materialBindings.value.group],
        workgroups: Math.ceil(this.poolCapacity / 64),
        ...(argsBuffer !== undefined && this.indirect
          ? {
              indirect: 0,
              buffers: [...pixel.buffers, { buffer: argsBuffer, usage: 'indirect-read' as const }],
            }
          : {}),
      },
    });
  }
}

function kernelBufferType(binding: number): 'uniform' | 'read-only-storage' | 'storage' {
  if (binding === 8 || binding === 7) return 'uniform';
  return [0, 1, 2].includes(binding) ? 'read-only-storage' : 'storage';
}

function kernelResourceUsage(type: string | undefined): RayPathBufferUsage {
  if (type === 'uniform') return 'uniform-read';
  return type === 'read-only-storage' ? 'storage-read' : 'storage-read-write';
}

/** Frozen kernel dispatch facts shared by every scheduled bounce. */
interface RayPathKernelRecording {
  readonly pipelines: Record<RayPathKernelName | RayPathProducerName, ComputePipeline>;
  readonly group: BindGroup;
  readonly resources: RayPathWork['buffers'];
  readonly textures: readonly TextureView[];
  readonly coverage: Buffer;
  readonly args: Buffer | undefined;
  readonly argsBindings: readonly [BindGroup, BindGroup] | undefined;
  readonly pixelGroups: number;
  readonly indirect: boolean;
}

function kernelWork(
  kernel: RayPathKernelRecording,
  name: RayPathKernelName,
  bounce: number,
  round = 0,
): RayPathWork {
  return {
    label: `ray-path.${name}-${bounce}${round > 0 ? `-round-${round}` : ''}`,
    pipeline: kernel.pipelines[name],
    bindings: [kernel.group],
    buffers: kernel.resources,
    textures: kernel.textures,
    workgroups: kernel.pixelGroups,
  };
}

/** Later coverage rounds dispatch only the GPU-counted rays the full pool deferred. */
function deferredWork(kernel: RayPathKernelRecording, work: RayPathWork): RayPathWork {
  return kernel.args !== undefined && kernel.indirect
    ? {
        ...work,
        workgroups: kernel.pixelGroups,
        indirect: 12,
        buffers: [...work.buffers, { buffer: kernel.args, usage: 'indirect-read' }],
      }
    : { ...work, workgroups: kernel.pixelGroups };
}

function producerWork(
  kernel: RayPathKernelRecording,
  name: RayPathProducerName,
  bounce: number,
): RayPathWork {
  if (kernel.args === undefined || kernel.argsBindings === undefined)
    return rayReferenceFailure('coverage rounds require dispatch args').unwrap();
  return {
    label: `ray-path.${name}-${bounce}`,
    pipeline: kernel.pipelines[name],
    bindings: kernel.argsBindings,
    buffers: [
      { buffer: kernel.coverage, usage: 'storage-read-write' },
      { buffer: kernel.args, usage: 'storage-read-write' },
    ],
    textures: [],
    workgroups: 1,
  };
}

/** The complete ordered dispatch list of one sample. */
function scheduleRayPathWorks(
  kernel: RayPathKernelRecording,
  generation: RayPathWork,
  materialWork: readonly RayPathMaterialWork[],
  masked: ReadonlySet<number>,
  request: Pick<RayTransportInputs, 'settings' | 'lights'>,
): RayPathWork[] {
  const works: RayPathWork[] = [generation];
  for (let bounce = 0; bounce < request.settings.maxBounces; bounce++) {
    if (masked.size === 0) {
      works.push(
        kernelWork(kernel, 'trace', bounce),
        ...materialWork.map((m) => m.pixel),
        kernelWork(kernel, 'shade', bounce),
      );
      continue;
    }
    works.push(kernelWork(kernel, 'beginCoverage', bounce));
    pushCoverageRounds(works, kernel, materialWork, masked, bounce, 'gather', 'resolve');
    // Opaque hits need one Surface evaluation after candidate resolution,
    // rather than once per rejected alpha layer.
    for (const m of materialWork) if (!masked.has(m.id)) works.push(m.pixel);
    works.push(kernelWork(kernel, 'sealCoverage', bounce));
    // Analytic lights and one environment NEE ray reuse the same bounded query storage.
    for (let light = 0; light <= request.lights.length; light++) {
      works.push(kernelWork(kernel, 'beginShadow', bounce));
      pushCoverageRounds(
        works,
        kernel,
        materialWork,
        masked,
        bounce,
        'gatherShadow',
        'resolveShadow',
      );
      works.push(kernelWork(kernel, 'endShadow', bounce));
    }
    works.push(kernelWork(kernel, 'shade', bounce));
  }
  works.push({
    label: 'ray-path.accumulate',
    pipeline: kernel.pipelines.accumulate,
    bindings: [kernel.group],
    buffers: kernel.resources,
    textures: kernel.textures,
    workgroups: kernel.pixelGroups,
  });
  return works;
}

// Every pixel gathers in round 0; later rounds see only the rays the full pool
// deferred. Dispatch count is independent of candidate depth.
function pushCoverageRounds(
  works: RayPathWork[],
  kernel: RayPathKernelRecording,
  materialWork: readonly RayPathMaterialWork[],
  masked: ReadonlySet<number>,
  bounce: number,
  gather: 'gather' | 'gatherShadow',
  resolve: 'resolve' | 'resolveShadow',
): void {
  for (let round = 0; round < RAY_COVERAGE_ROUNDS; round++) {
    const sized = (name: typeof gather | typeof resolve) =>
      round === 0
        ? kernelWork(kernel, name, bounce)
        : deferredWork(kernel, kernelWork(kernel, name, bounce, round));
    works.push(sized(gather), producerWork(kernel, 'armMaterials', bounce));
    for (const m of materialWork) if (masked.has(m.id)) works.push(m.pool);
    works.push(sized(resolve));
    if (round + 1 < RAY_COVERAGE_ROUNDS) works.push(producerWork(kernel, 'armRound', bounce));
  }
}

/** A dispatch batch sharing one compute pass and its merged buffer usage scope. */
interface RayPathBatch {
  readonly works: RayPathWork[];
  usages: Map<Buffer, RayPathBufferUsage>;
}

// WebGPU orders storage writes between dispatches of one compute pass, so
// consecutive works share one compute pass whenever their declared usages
// merge into one compatible usage scope (reads upgrade to read-write).
function batchRayPathWorks(works: readonly RayPathWork[]): RayPathBatch[] {
  const batches: RayPathBatch[] = [];
  for (const work of works) {
    const last = batches[batches.length - 1];
    const merged = last === undefined ? undefined : mergeWorkUsages(last.usages, work);
    if (last !== undefined && merged !== undefined) {
      last.works.push(work);
      last.usages = merged;
    } else
      batches.push({
        works: [work],
        usages: new Map(work.buffers.map(({ buffer, usage }) => [buffer, usage])),
      });
  }
  return batches;
}

/** The merged usage scope, or undefined when the work cannot join this pass. */
function mergeWorkUsages(
  usages: ReadonlyMap<Buffer, RayPathBufferUsage>,
  work: RayPathWork,
): Map<Buffer, RayPathBufferUsage> | undefined {
  const merged = new Map(usages);
  for (const { buffer, usage } of work.buffers) {
    const prior = merged.get(buffer);
    if (prior === undefined || prior === usage) {
      merged.set(buffer, usage);
      continue;
    }
    // Indirect arguments and uniforms never share a usage scope with storage.
    if ([prior, usage].some((u) => u === 'uniform-read' || u === 'indirect-read')) return undefined;
    merged.set(buffer, 'storage-read-write');
  }
  return merged;
}

function freezeRayPathTracer(
  owner: RayPathResourceOwner,
  buffers: Record<RayPathBufferName, Buffer>,
  pixels: number,
  works: readonly RayPathWork[],
  argsBuffer: Buffer | undefined,
  directDfgLut: DirectDfgLutResource | undefined,
  updateScene: RayPathTracer['updateScene'],
): RayPathTracer {
  let disposed = false;
  const batches = batchRayPathWorks(works);
  const record = (pass: RhiComputePassEncoder, work: RayPathWork) => {
    if (disposed) rayReferenceFailure('path tracer is disposed').unwrap();
    pass.setPipeline(work.pipeline);
    work.bindings.forEach((group, index) => {
      pass.setBindGroup(index, group);
    });
    if (work.indirect !== undefined && argsBuffer !== undefined)
      pass.dispatchWorkgroupsIndirect(argsBuffer, work.indirect);
    else pass.dispatchWorkgroups(work.workgroups, 1, 1);
  };
  return {
    buffers,
    pixelCount: pixels,
    dispatchCount: works.length,
    updateScene(scene, edit) {
      if (disposed) return rayReferenceFailure('path tracer is disposed');
      return updateScene(scene, edit);
    },
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
          if (!owner.descriptors.has(buffer) && !graphBuffers.has(buffer))
            return rayReferenceFailure('borrowed ray buffer has no producer graph resource');
        }
        for (const view of work.textures) {
          if (!graphTextures.has(view))
            return rayReferenceFailure('material texture has no producer graph resource');
        }
      }
      for (const [buffer, descriptor] of owner.descriptors) {
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
        owner.dispose();
      }
    },
  };
}
