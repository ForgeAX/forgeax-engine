import {
  distanceFieldMeshDigest,
  type MeshCardLayout,
  type MeshCardProjection,
  meshCardSidednessDigest,
  validateMeshCardLayout,
} from '@forgeax/engine-geometry';
import type {
  Buffer,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  RhiRenderPassEncoder,
  ShaderModule,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import {
  admitRayMaterial,
  admitRayMaterialValues,
  type RayMaterialError,
  rayMaterialContract,
} from '@forgeax/engine-shader';
import { ok, type ParamSchemaEntry, type Result } from '@forgeax/engine-types';
import { type MaterialSnapshot, materialTextureValue } from '../render-system-extract';
import { buildRaySurfaceScene, type RaySurfaceInstance } from './attributes';
import {
  captureViewProjection,
  type SurfaceViewProjection,
  transformCardProjection,
} from './capture-view';
import { createIndexAllocator } from './index-allocator';
import {
  createSurfaceMaterialBindings,
  type ResolveSurfaceTexture,
  referenceSurfaceMaterialSnapshot,
} from './material-bindings';
import type { RayPathMaterial } from './path-tracer';
import { type RayReferenceError, rayGeometryKey, rayReferenceFailure } from './scene';

export interface SurfaceCardSource {
  /** Whole geometry identity; material sections are draws within this instance. */
  readonly instance: Omit<RaySurfaceInstance, 'materialId'>;
  readonly layout: MeshCardLayout;
  /** Ordered, contiguous triangle ranges covering the whole index buffer. */
  readonly sections: readonly {
    readonly indexOffset: number;
    readonly indexCount: number;
    readonly material: RayPathMaterial;
    /** Producer revision for borrowed textures, required when this section uses them. */
    readonly textureContentKey?: string;
  }[];
}
/** Both accepted Renderer materials and explicit reference lowering use this capture input. */
export interface SurfaceCaptureSource {
  readonly instance: SurfaceCardSource['instance'];
  readonly layout: MeshCardLayout;
  readonly captureKey: string;
  readonly sections: readonly {
    readonly indexOffset: number;
    readonly indexCount: number;
    readonly material: {
      readonly id: number;
      readonly program: {
        readonly source: string;
        readonly paramSchema: readonly ParamSchemaEntry[];
      };
      readonly snapshot: MaterialSnapshot;
      readonly resolveTexture?: (parameter: string) => ReturnType<ResolveSurfaceTexture>;
    };
  }[];
}
export type SurfaceCaptureRequest =
  | { readonly kind: 'cards'; readonly resolution: number }
  | {
      readonly kind: 'view';
      readonly resolution: number;
      readonly projection: SurfaceViewProjection;
    };
export type SurfaceCardProjection = MeshCardProjection;
export const CARD_PLANES = [
  'albedoRoughness',
  'normals',
  'emissionMetallic',
  'f0Validity',
] as const;
export const CARD_TEXTURES = [...CARD_PLANES, 'depth'] as const;
export interface SurfaceCapture {
  readonly kind: 'cards' | 'view';
  readonly width: number;
  readonly bytes: number;
  readonly resolution: number;
  readonly height: number;
  readonly textures: Readonly<Record<(typeof CARD_TEXTURES)[number], Texture>>;
  readonly entries: readonly {
    readonly instanceId: number;
    readonly geometryKey: string;
    readonly captureKey: string;
    readonly projections: readonly SurfaceCardProjection[];
  }[];
  readonly views: Readonly<Record<(typeof CARD_TEXTURES)[number], TextureView>>;
  readonly bufferReads: readonly {
    readonly buffer: Buffer;
    readonly size: number;
    readonly usage: 'uniform-read' | 'storage-read';
  }[];
  readonly textureReads: readonly TextureView[];
  /** Advances whenever installs or removals change `bufferReads`. */
  readonly revision: number;
  /**
   * Residency mode: preparation installed a priority prefix of its sources that fits the
   * byte, tile, draw and instance ceilings instead of failing; `add` and `remove` stream
   * the rest. Absent outside residency mode.
   */
  readonly residency?: { readonly maxTexels: number };
  /** Whether `instanceId` has live Cards in this capture. */
  has(instanceId: number): boolean;
  /** Buffers retired by removals are destroyed after the next tracked completion. */
  track(completed: Promise<unknown>): void;
  /** Record only draws; the Graph or reference wrapper owns pass boundaries.
   * `tiles` limits the draws to one contiguous atlas tile slice. */
  recordPass(
    pass: RhiRenderPassEncoder,
    tiles?: { readonly first: number; readonly count: number },
  ): Result<void, RayReferenceError>;
  /** One coherent unlit capture: all material planes and depth share each raster work. */
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  /** Clears a tile slice (zero planes, far depth) inside a loading pass before recapture. */
  clearTiles(
    pass: RhiRenderPassEncoder,
    tiles: { readonly first: number; readonly count: number },
  ): Result<void, RayReferenceError>;
  /**
   * Moves one captured instance in place: rewrites its world-space triangles and Card
   * projections and returns its unchanged tile run. A winding flip or a removed
   * instance fails; the caller then rebuilds the capture.
   */
  retransform(
    instanceId: number,
    transform: ArrayLike<number>,
  ): Result<{ readonly first: number; readonly count: number }, RayReferenceError>;
  /** Atlas tile slots; `allocatedTiles` is the high-water mark that bounds Card loops. */
  readonly capacity: number;
  readonly allocatedTiles: number;
  /** Whether `add`/`rematerialize` can install this source synchronously. */
  admitted(source: SurfaceCaptureSource): boolean;
  /** Resolves the asynchronous digests and shader modules an in-place install needs. */
  admit(
    source: SurfaceCaptureSource,
  ): Promise<Result<void, RayReferenceError | RayMaterialError | RhiError>>;
  /**
   * Installs one admitted instance into free atlas tiles and returns its tile run.
   * A full atlas or byte budget fails with `limit`; the caller then rebuilds.
   */
  add(
    source: SurfaceCaptureSource,
  ): Result<
    { readonly first: number; readonly count: number },
    RayReferenceError | RayMaterialError | RhiError
  >;
  /** Replaces one instance's material draws in place, keeping geometry and tile run. */
  rematerialize(
    instanceId: number,
    source: SurfaceCaptureSource,
  ): Result<
    { readonly first: number; readonly count: number },
    RayReferenceError | RayMaterialError | RhiError
  >;
  /** Drops one instance's draws and frees its tile run, a hole the caller clears. */
  remove(
    instanceId: number,
  ): Result<{ readonly first: number; readonly count: number }, RayReferenceError>;
  dispose(): void;
}
const CARD_TILE_CLEAR_WGSL = `
struct ClearOut { @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f, @location(3) d: vec4f }
@vertex fn vs_clear(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
 let p=vec2f(f32((i<<1u)&2u),f32(i&2u));return vec4f(p*2.0-vec2f(1.0),1.0,1.0);
}
@fragment fn fs_clear() -> ClearOut { return ClearOut(vec4f(0),vec4f(0),vec4f(0),vec4f(0)); }
`;

export function surfaceCardKey(source: SurfaceCardSource): string {
  return JSON.stringify([
    rayGeometryKey(source.instance, source.layout.meshDigest),
    source.layout,
    source.instance.uvSets?.map((v) => Array.from(v)),
    source.instance.colors === undefined ? null : Array.from(source.instance.colors),
    source.instance.normals === undefined ? null : Array.from(source.instance.normals),
    source.instance.tangents === undefined ? null : Array.from(source.instance.tangents),
    source.sections.map((section) => [
      section.indexOffset,
      section.indexCount,
      section.material.id,
      section.material.program.contract,
      section.material.program.sourceClosureDigest,
      section.material.asset.values,
      section.textureContentKey,
    ]),
  ]);
}
export function packCardProjection(p: SurfaceCardProjection, winding = 1): Uint8Array {
  return new Uint8Array(
    new Float32Array([...p.origin, winding, ...p.u, p.width, ...p.v, p.height, ...p.n, p.depth])
      .buffer,
  );
}

/** Frozen real-mesh raster capture. The caller owns submit/completion and borrowed textures. */
export async function createSurfaceCapture(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  sources: readonly SurfaceCardSource[],
  request: SurfaceCaptureRequest = { kind: 'cards', resolution: 16 },
  resolveTexture?: ResolveSurfaceTexture,
): Promise<Result<SurfaceCapture, RayReferenceError | RayMaterialError | RhiError>> {
  const lowered: SurfaceCaptureSource[] = [];
  for (const source of sources) {
    const sections: SurfaceCaptureSource['sections'][number][] = [];
    for (const section of source.sections) {
      const { material } = section;
      if (
        material.program.context !== 'card-capture' ||
        material.program.contract !== rayMaterialContract(material.asset)
      )
        return rayReferenceFailure('card material identity/context is stale or mismatched');
      const admitted = admitRayMaterial(material.asset, String(material.id));
      if (!admitted.ok) return admitted;
      if (
        material.program.paramSchema.some((p) => p.type === 'texture2d') &&
        !section.textureContentKey
      )
        return rayReferenceFailure('textured cards require a producer textureContentKey');
      sections.push({
        ...section,
        material: {
          id: material.id,
          program: { source: material.program.wgsl, paramSchema: material.program.paramSchema },
          snapshot: referenceSurfaceMaterialSnapshot(material),
          resolveTexture: (parameter) => {
            const value = materialTextureValue(material.asset.values?.[parameter]);
            return value && resolveTexture
              ? resolveTexture(value)
              : rayReferenceFailure(`missing texture binding ${parameter}`);
          },
        },
      });
    }
    lowered.push({
      instance: source.instance,
      layout: source.layout,
      captureKey: surfaceCardKey(source),
      sections,
    });
  }
  return prepareSurfaceCapture(device, compile, lowered, request);
}

/** One capture implementation. Programs and snapshots have already crossed their producer boundary.
 * `reserve` asks for extra atlas tiles that `add` can allocate later; headroom never
 * takes more than half the byte budget, 4096 tiles or the 8192-texel extent.
 * `residency` selects residency mode: `sources` arrive in priority order, and a scene
 * whose Cards exceed the byte, tile, draw or instance ceilings installs the longest
 * prefix that fits (the atlas also stays within `maxTexels`) instead of failing. */
export async function prepareSurfaceCapture(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  sources: readonly SurfaceCaptureSource[],
  request: SurfaceCaptureRequest = { kind: 'cards', resolution: 16 },
  maxBytes = 256 * 1024 * 1024,
  reserve = 0,
  residency?: { readonly maxTexels: number },
): Promise<Result<SurfaceCapture, RayReferenceError | RayMaterialError | RhiError>> {
  const { resolution } = request;
  if (
    residency !== undefined &&
    (request.kind !== 'cards' ||
      !Number.isSafeInteger(residency.maxTexels) ||
      residency.maxTexels < resolution * resolution)
  )
    return rayReferenceFailure('Card residency requires a Card atlas of at least one tile');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024)
    return rayReferenceFailure('capture requires an explicit byte budget within 256 MiB', true);
  if (!Number.isSafeInteger(reserve) || reserve < 0)
    return rayReferenceFailure('capture tile reserve must be a nonnegative integer');
  if (request.kind === 'view') {
    const projection = captureViewProjection(request.projection);
    if (!projection.ok) return projection;
  }
  if (
    !Number.isInteger(resolution) ||
    resolution < 8 ||
    resolution > 512 ||
    sources.length < 1 ||
    (residency === undefined && sources.length > 1024)
  )
    return rayReferenceFailure('capture requires 1..1024 instances and 8..512 pixels', true);
  if (!device.caps.rgba16floatRenderable || device.caps.maxColorAttachments < 4)
    return rayReferenceFailure('card capture requires four rgba16float attachments');
  if (new Set(sources.map((s) => s.instance.instanceId)).size !== sources.length)
    return rayReferenceFailure('duplicate card instance');
  for (const source of sources) {
    const valid = validateMeshCardLayout(source.layout);
    if (!valid.ok) return rayReferenceFailure('invalid cooked card layout');
  }
  const cardCount = sources.reduce((sum, source) => sum + source.layout.cards.length, 0);
  if (cardCount > 4096 && residency === undefined)
    return rayReferenceFailure('capture exceeds 4096 card budget', true);
  const workCount = sources.reduce(
    (sum, source) =>
      sum + source.sections.length * (request.kind === 'cards' ? source.layout.cards.length : 1),
    0,
  );
  if (workCount > 65_536 && residency === undefined)
    return rayReferenceFailure('capture exceeds 65536 material-card draw budget', true);
  const shape = (tiles: number) => {
    const columns = request.kind === 'cards' ? Math.max(1, Math.ceil(Math.sqrt(tiles))) : 1;
    const rows = request.kind === 'cards' ? Math.max(1, Math.ceil(tiles / columns)) : 1;
    return { columns, rows, width: resolution * columns, height: resolution * rows };
  };
  const fits = (s: ReturnType<typeof shape>, bytes: number) =>
    s.width <= 8192 &&
    s.height <= 8192 &&
    s.width * s.height * 36 <= bytes &&
    (residency === undefined || s.width * s.height <= residency.maxTexels);
  let target = request.kind === 'cards' ? Math.min(4096, cardCount + reserve) : cardCount;
  // Residency keeps every source's tiles only when they fit; otherwise the atlas
  // shrinks to the byte headroom and holds the highest-priority prefix.
  const floor =
    residency !== undefined && !fits(shape(Math.min(4096, cardCount)), maxBytes)
      ? 1
      : Math.min(cardCount, target);
  while (target > floor && !fits(shape(target), maxBytes / 2))
    target = Math.max(floor, Math.floor(target * 0.75));
  const { columns, width, height, rows: atlasRows } = shape(target);
  if (!fits({ columns, rows: atlasRows, width, height }, maxBytes))
    return rayReferenceFailure('capture exceeds texture extent or attachment byte budget', true);
  const tiles = createIndexAllocator(
    request.kind === 'cards' ? Math.min(4096, columns * atlasRows) : 0,
  );
  let allocatedBytes = 0;
  const bufferReads: { buffer: Buffer; size: number; usage: 'uniform-read' | 'storage-read' }[] =
    [];
  const textureReads: TextureView[] = [];
  const ownedBuffers: Buffer[] = [],
    ownedTextures: Texture[] = [];
  // Buffers of removed instances: `retired` until a completion is tracked, then in flight.
  const retired: Buffer[] = [];
  const retiring = new Set<Buffer[]>();
  let revision = 0;
  const dispose = () => {
    for (const b of ownedBuffers) device.destroyBuffer(b);
    for (const b of retired) device.destroyBuffer(b);
    for (const group of retiring) for (const b of group) device.destroyBuffer(b);
    for (const t of ownedTextures) device.destroyTexture(t);
    ownedBuffers.length = 0;
    retired.length = 0;
    retiring.clear();
    ownedTextures.length = 0;
  };
  /** Drops buffers from every read list and the byte total; destruction waits for `track`. */
  const retire = (buffers: readonly Buffer[]) => {
    if (buffers.length === 0) return;
    const set = new Set(buffers);
    for (let i = bufferReads.length - 1; i >= 0; i--) {
      const read = bufferReads[i];
      if (read === undefined || !set.has(read.buffer)) continue;
      allocatedBytes -= read.size;
      bufferReads.splice(i, 1);
    }
    for (let i = ownedBuffers.length - 1; i >= 0; i--) {
      const owned = ownedBuffers[i];
      if (owned !== undefined && set.has(owned)) ownedBuffers.splice(i, 1);
    }
    retired.push(...buffers);
    revision++;
  };
  const fail = <E>(r: Result<never, E>) => {
    dispose();
    return r;
  };
  const make = (
    label: string,
    bytes: Uint8Array,
    uniform = false,
  ): Result<Buffer, RhiError | RayReferenceError> => {
    if (allocatedBytes + bytes.byteLength > maxBytes)
      return rayReferenceFailure('capture exceeds its complete resource byte budget', true);
    const b = device.createBuffer({
      label,
      size: bytes.byteLength,
      usage: (uniform ? 64 : 128) | 12,
    });
    if (!b.ok) return b;
    ownedBuffers.push(b.value);
    bufferReads.push({
      buffer: b.value,
      size: bytes.byteLength,
      usage: uniform ? 'uniform-read' : 'storage-read',
    });
    allocatedBytes += bytes.byteLength;
    const write = device.queue.writeBuffer(b.value, 0, bytes);
    return write.ok ? b : write;
  };
  allocatedBytes += width * height * 36;
  const textures = {} as Record<(typeof CARD_TEXTURES)[number], Texture>;
  const views: TextureView[] = [];
  for (const name of CARD_PLANES) {
    const texture = device.createTexture({
      label: `cards.${name}`,
      size: { width, height },
      format: 'rgba16float',
      textureBindingViewDimension: '2d',
      usage: 21,
    });
    if (!texture.ok) return fail(texture);
    ownedTextures.push(texture.value);
    textures[name] = texture.value;
    const view = device.createTextureView(texture.value, {});
    if (!view.ok) return fail(view);
    views.push(view.value);
  }
  const depth = device.createTexture({
    label: 'cards.depth',
    size: { width, height },
    format: 'depth32float',
    textureBindingViewDimension: '2d',
    usage: 21,
  });
  if (!depth.ok) return fail(depth);
  ownedTextures.push(depth.value);
  textures.depth = depth.value;
  const depthView = device.createTextureView(depth.value, {});
  if (!depthView.ok) return fail(depthView);
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 1, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 3, buffer: { type: 'uniform' } },
    ],
  });
  if (!layout.ok) return fail(layout);
  const entries: SurfaceCapture['entries'][number][] = [];
  let draws: {
    pipeline: import('@forgeax/engine-rhi').RenderPipeline;
    material: import('@forgeax/engine-rhi').BindGroup;
    cards: import('@forgeax/engine-rhi').BindGroup[];
    vertices: number;
    firstTile: number;
    instanceId: number;
  }[] = [];
  // In-place edit facts per live instance: section scene buffers and Card projection uniforms.
  const editable = new Map<
    number,
    {
      instance: SurfaceCaptureSource['instance'];
      layout: MeshCardLayout;
      firstTile: number;
      projections: Buffer[];
      /** Every buffer this install created; removal retires them. */
      buffers: Buffer[];
      sections: {
        indexOffset: number;
        indexCount: number;
        materialId: number;
        triangles: Buffer;
        attributes: Buffer;
        winding: number;
      }[];
    }
  >();
  // Admission caches: async digests and module compiles happen once, so `add` stays synchronous.
  const modules = new Map<string, ShaderModule>();
  const meshDigests = new WeakMap<object, WeakMap<object, string>>();
  const sidednessDigests = new Map<string, string>();
  const sidednessOf = (
    source: SurfaceCaptureSource,
  ): Result<Uint8Array, RayReferenceError | RayMaterialError> => {
    const { instance } = source;
    if (source.sections.length < 1 || source.sections.length > 1024)
      return rayReferenceFailure('capture requires 1..1024 material sections per mesh', true);
    const sidedness = new Uint8Array(instance.indices.length / 3);
    let indexEnd = 0;
    for (const section of source.sections) {
      if (
        section.indexOffset !== indexEnd ||
        !Number.isSafeInteger(section.indexCount) ||
        section.indexCount < 3 ||
        section.indexCount % 3 !== 0 ||
        section.indexOffset + section.indexCount > instance.indices.length
      )
        return rayReferenceFailure(
          'card sections must cover contiguous non-overlapping triangle ranges',
        );
      indexEnd += section.indexCount;
      const cull = section.material.snapshot.renderState?.cullMode ?? 'back';
      if (cull !== 'back' && cull !== 'none')
        return rayReferenceFailure('card sections require back or none culling');
      sidedness.fill(cull === 'none' ? 1 : 0, section.indexOffset / 3, indexEnd / 3);
    }
    if (indexEnd !== instance.indices.length)
      return rayReferenceFailure('card sections must cover the whole mesh');
    return ok(sidedness);
  };
  const sidednessKey = (flags: Uint8Array) => flags.join('');
  const admitted = (source: SurfaceCaptureSource) => {
    const sidedness = sidednessOf(source);
    return (
      sidedness.ok &&
      meshDigests.get(source.instance.positions)?.get(source.instance.indices) !== undefined &&
      sidednessDigests.has(sidednessKey(sidedness.value)) &&
      source.sections.every((s) => modules.has(s.material.program.source))
    );
  };
  const admit = async (
    source: SurfaceCaptureSource,
  ): Promise<Result<void, RayReferenceError | RayMaterialError | RhiError>> => {
    const { instance } = source;
    let byIndices = meshDigests.get(instance.positions);
    if (byIndices?.get(instance.indices) === undefined) {
      const digest = await distanceFieldMeshDigest(instance.positions, instance.indices);
      if (byIndices === undefined) {
        byIndices = new WeakMap();
        meshDigests.set(instance.positions, byIndices);
      }
      byIndices.set(instance.indices, digest);
    }
    const sidedness = sidednessOf(source);
    if (!sidedness.ok) return sidedness;
    const key = sidednessKey(sidedness.value);
    if (!sidednessDigests.has(key))
      sidednessDigests.set(key, await meshCardSidednessDigest(sidedness.value));
    for (const section of source.sections) {
      const code = section.material.program.source;
      if (modules.has(code)) continue;
      const module = await compile(device, { code, label: 'cards.material' });
      if (!module.ok) return module;
      modules.set(code, module.value);
    }
    return ok(undefined);
  };
  /** Synchronous install of one admitted instance; a failure retires its partial buffers. */
  const install = (
    source: SurfaceCaptureSource,
    firstTile: number,
  ): Result<void, RayReferenceError | RayMaterialError | RhiError> => {
    const mark = ownedBuffers.length;
    const installed = installAt(source, firstTile, mark);
    if (!installed.ok) retire(ownedBuffers.slice(mark));
    else revision++;
    return installed;
  };
  const installAt = (
    source: SurfaceCaptureSource,
    firstTile: number,
    mark: number,
  ): Result<void, RayReferenceError | RayMaterialError | RhiError> => {
    const { instance, layout: cardLayout } = source;
    if (meshDigests.get(instance.positions)?.get(instance.indices) !== cardLayout.meshDigest)
      return rayReferenceFailure('card source geometry differs from its cooked layout');
    const sidedness = sidednessOf(source);
    if (!sidedness.ok) return sidedness;
    if (cardLayout.sidednessDigest !== sidednessDigests.get(sidednessKey(sidedness.value)))
      return rayReferenceFailure('card layout sidedness must match every material section');
    const cardProjections: SurfaceCardProjection[] = [];
    if (request.kind === 'cards')
      for (const local of cardLayout.cards) {
        const transformed = transformCardProjection(local, instance.transform);
        if (!transformed.ok) return transformed;
        cardProjections.push(transformed.value);
      }
    const cards = request.kind === 'cards' ? cardProjections : [request.projection];
    const projectionBuffers: Buffer[] = [];
    for (const card of cards) {
      const projection = captureViewProjection(card);
      if (!projection.ok) return projection;
      const bytes = new Float32Array(24);
      bytes.set(projection.value.matrix);
      bytes.set(projection.value.eye, 16);
      new Uint32Array(bytes.buffer)[20] = request.kind === 'cards' ? 1 : 0;
      const buffer = make('cards.projection', new Uint8Array(bytes.buffer), true);
      if (!buffer.ok) return buffer;
      projectionBuffers.push(buffer.value);
    }
    const editSections: NonNullable<ReturnType<typeof editable.get>>['sections'] = [];
    const installed: typeof draws = [];
    for (const section of source.sections) {
      const { material } = section;
      const values = {
        ...Object.fromEntries(material.program.paramSchema.map((p) => [p.name, p.default])),
        ...material.snapshot.paramSnapshot,
      };
      const admittedValues = admitRayMaterialValues(values, String(material.id), source.captureKey);
      if (!admittedValues.ok) return admittedValues;
      if (
        material.snapshot.renderState?.blend !== undefined ||
        material.snapshot.surfaceModel === 'single-layer-medium'
      )
        return rayReferenceFailure('card capture requires opaque or masked Standard material');
      const coordinates = material.snapshot.textureCoordinates;
      const textureParams = material.program.paramSchema.filter((p) => p.type === 'texture2d');
      for (const entry of textureParams) {
        if (
          entry.name === 'normalTexture' &&
          (instance.normals === undefined || instance.tangents === undefined)
        )
          return rayReferenceFailure(
            `instance ${instance.instanceId} normal texture requires authored normals and tangents`,
          );
        const set = coordinates?.get(entry.name)?.set ?? 0;
        if (set >= (instance.uvSets?.length ?? 0))
          return rayReferenceFailure(
            `instance ${instance.instanceId} is missing material UV set ${set}`,
          );
      }
      const cullMode = material.snapshot.renderState?.cullMode ?? 'back';
      if (cullMode !== 'back' && cullMode !== 'none')
        return rayReferenceFailure('invalid card culling');
      const scene = buildRaySurfaceScene([
        {
          ...instance,
          materialId: material.id,
          indices: Array.from(
            { length: section.indexCount },
            (_, i) => instance.indices[section.indexOffset + i] ?? NaN,
          ),
        },
      ]);
      if (!scene.ok) return scene;
      const value = scene.value;
      const triangles = make('cards.triangles', value.triangles),
        attributes = make('cards.attributes', value.attributes);
      if (!triangles.ok) return triangles;
      if (!attributes.ok) return attributes;
      const bindings = createSurfaceMaterialBindings(
        device,
        material.program.paramSchema,
        material.snapshot,
        2,
        material.resolveTexture,
      );
      if (!bindings.ok) return bindings;
      ownedBuffers.push(bindings.value.uniform);
      bufferReads.push({
        buffer: bindings.value.uniform,
        size: bindings.value.bytes,
        usage: 'uniform-read',
      });
      for (const view of bindings.value.textureViews)
        if (!textureReads.includes(view)) textureReads.push(view);
      allocatedBytes += bindings.value.bytes;
      if (allocatedBytes > maxBytes)
        return rayReferenceFailure('capture exceeds its complete resource byte budget', true);
      const module = modules.get(material.program.source);
      if (module === undefined) return rayReferenceFailure('card material program is not admitted');
      const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [layout.value, bindings.value.layout],
      });
      if (!pipelineLayout.ok) return pipelineLayout;
      const winding = new DataView(value.attributes.buffer).getFloat32(108, true);
      const pipeline = device.createRenderPipeline({
        label: `cards.capture.instance-${instance.instanceId}.indices-${section.indexOffset}-${section.indexCount}.material-${material.id}`,
        layout: pipelineLayout.value,
        vertex: { module, entryPoint: 'vs_card', buffers: [] },
        fragment: {
          module,
          entryPoint: 'fs_card',
          targets: CARD_PLANES.map(() => ({ format: 'rgba16float' as const })),
        },
        primitive: {
          topology: 'triangle-list',
          cullMode,
          frontFace: winding < 0 ? 'cw' : 'ccw',
        },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      });
      if (!pipeline.ok) return pipeline;
      const groups = [];
      for (const buffer of projectionBuffers) {
        const group = device.createBindGroup({
          layout: layout.value,
          entries: [triangles.value, attributes.value, buffer].map((b, binding) => ({
            binding,
            resource: { kind: 'buffer' as const, value: { buffer: b } },
          })),
        });
        if (!group.ok) return group;
        groups.push(group.value);
      }
      installed.push({
        pipeline: pipeline.value,
        material: bindings.value.group,
        cards: groups,
        vertices: value.triangleCount * 3,
        firstTile,
        instanceId: instance.instanceId,
      });
      editSections.push({
        indexOffset: section.indexOffset,
        indexCount: section.indexCount,
        materialId: material.id,
        triangles: triangles.value,
        attributes: attributes.value,
        winding,
      });
    }
    draws.push(...installed);
    editable.set(instance.instanceId, {
      instance,
      layout: cardLayout,
      firstTile,
      projections: projectionBuffers,
      buffers: ownedBuffers.slice(mark),
      sections: editSections,
    });
    entries.push({
      instanceId: instance.instanceId,
      geometryKey: rayGeometryKey(instance, cardLayout.meshDigest),
      captureKey: source.captureKey,
      projections: cardProjections,
    });
    return ok(undefined);
  };
  const detach = (instanceId: number) => {
    const record = editable.get(instanceId);
    if (record !== undefined) retire(record.buffers);
    editable.delete(instanceId);
    draws = draws.filter((draw) => draw.instanceId !== instanceId);
    const entry = entries.findIndex((e) => e.instanceId === instanceId);
    if (entry >= 0) entries.splice(entry, 1);
  };
  for (const source of sources) {
    // Residency stops at the first source past a ceiling; the rest stream in later.
    if (
      residency !== undefined &&
      (editable.size >= 1024 ||
        draws.length + source.sections.length * source.layout.cards.length > 65_536)
    )
      break;
    const admittedSource = await admit(source);
    if (!admittedSource.ok) return fail(admittedSource);
    const run =
      request.kind === 'cards' ? tiles.allocate(source.layout.cards.length) : { first: 0, end: 0 };
    if (run === undefined) {
      if (residency !== undefined) break;
      return fail(rayReferenceFailure('capture atlas has no free tiles', true));
    }
    const installed = install(source, run.first);
    if (!installed.ok) {
      if (residency !== undefined && installed.error.code === 'ray-reference-limit') {
        tiles.free(run);
        break;
      }
      return fail(installed);
    }
  }
  let clearPipeline: import('@forgeax/engine-rhi').RenderPipeline | undefined;
  if (request.kind === 'cards') {
    const module = await compile(device, { code: CARD_TILE_CLEAR_WGSL, label: 'cards.clear' });
    if (!module.ok) return fail(module);
    const clearLayout = device.createPipelineLayout({ bindGroupLayouts: [] });
    if (!clearLayout.ok) return fail(clearLayout);
    const created = device.createRenderPipeline({
      label: 'cards.clear-tile',
      layout: clearLayout.value,
      vertex: { module: module.value, entryPoint: 'vs_clear', buffers: [] },
      fragment: {
        module: module.value,
        entryPoint: 'fs_clear',
        targets: CARD_PLANES.map(() => ({ format: 'rgba16float' as const })),
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    });
    if (!created.ok) return fail(created);
    clearPipeline = created.value;
  }
  const tileRect = (pass: RhiRenderPassEncoder, tile: number) => {
    const column = tile % columns,
      row = request.kind === 'cards' ? Math.floor(tile / columns) : 0;
    pass.setViewport(column * resolution, row * resolution, resolution, resolution, 0, 1);
    pass.setScissorRect(column * resolution, row * resolution, resolution, resolution);
  };
  const writeProjection = (buffer: Buffer, card: SurfaceCardProjection) => {
    const projection = captureViewProjection(card);
    if (!projection.ok) return projection;
    const bytes = new Float32Array(24);
    bytes.set(projection.value.matrix);
    bytes.set(projection.value.eye, 16);
    new Uint32Array(bytes.buffer)[20] = 1;
    const written = device.queue.writeBuffer(buffer, 0, new Uint8Array(bytes.buffer));
    return written.ok ? ok(undefined) : rayReferenceFailure(written.error.expected);
  };
  const editableSource = (source: SurfaceCaptureSource) => {
    if (disposed || request.kind !== 'cards')
      return rayReferenceFailure('in-place Card edits require a live Card capture');
    if (!admitted(source))
      return rayReferenceFailure('in-place Card source is not admitted; admit it first');
    if (draws.length + source.sections.length * source.layout.cards.length > 65_536)
      return rayReferenceFailure('capture exceeds 65536 material-card draw budget', true);
    return ok(undefined);
  };
  let disposed = false;
  return ok({
    kind: request.kind,
    get bytes() {
      return allocatedBytes;
    },
    width,
    resolution,
    height,
    capacity: tiles.capacity,
    get allocatedTiles() {
      return tiles.end;
    },
    textures,
    views: Object.fromEntries([
      ...views.map((view, i) => [CARD_PLANES[i], view]),
      ['depth', depthView.value],
    ]) as SurfaceCapture['views'],
    bufferReads,
    textureReads,
    entries,
    get revision() {
      return revision;
    },
    ...(residency === undefined ? {} : { residency }),
    has: (instanceId) => editable.has(instanceId),
    track(completed) {
      if (retired.length === 0) return;
      const group = retired.splice(0);
      retiring.add(group);
      const destroy = () => {
        if (!retiring.delete(group)) return;
        for (const b of group) device.destroyBuffer(b);
      };
      void completed.then(destroy, destroy);
    },
    record(encoder) {
      if (disposed) return rayReferenceFailure('surface cards are disposed');
      const pass = encoder.beginRenderPass({
        label: 'cards.capture',
        colorAttachments: views.map((view) => ({
          view,
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        })),
        depthStencilAttachment: {
          view: depthView.value,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
        },
      });
      try {
        return this.recordPass(pass);
      } finally {
        pass.end();
      }
    },
    clearTiles(pass, tiles) {
      if (disposed || clearPipeline === undefined)
        return rayReferenceFailure('surface card tile clears require live Card capture');
      pass.setPipeline(clearPipeline);
      for (let tile = tiles.first; tile < tiles.first + tiles.count; tile++) {
        tileRect(pass, tile);
        pass.draw(3);
      }
      return ok(undefined);
    },
    admitted,
    admit,
    add(source) {
      const valid = editableSource(source);
      if (!valid.ok) return valid;
      if (editable.has(source.instance.instanceId))
        return rayReferenceFailure('duplicate card instance');
      if (editable.size >= 1024)
        return rayReferenceFailure('capture requires 1..1024 instances and 8..512 pixels', true);
      const validLayout = validateMeshCardLayout(source.layout);
      if (!validLayout.ok) return rayReferenceFailure('invalid cooked card layout');
      const run = tiles.allocate(source.layout.cards.length);
      if (run === undefined) return rayReferenceFailure('capture atlas has no free tiles', true);
      const installed = install(source, run.first);
      if (!installed.ok) {
        detach(source.instance.instanceId);
        tiles.free(run);
        return installed;
      }
      return ok({ first: run.first, count: run.end - run.first });
    },
    rematerialize(instanceId, source) {
      const record = editable.get(instanceId);
      if (record === undefined || source.instance.instanceId !== instanceId)
        return rayReferenceFailure('Card rematerialization requires a live captured instance');
      if (
        source.layout.meshDigest !== record.layout.meshDigest ||
        source.layout.cards.length !== record.layout.cards.length
      )
        return rayReferenceFailure('Card rematerialization must keep the instance geometry');
      const valid = editableSource(source);
      if (!valid.ok) return valid;
      const position = entries.findIndex((e) => e.instanceId === instanceId);
      detach(instanceId);
      const installed = install(source, record.firstTile);
      if (!installed.ok) return installed;
      // Entries stay in their original order; only the material draws changed.
      const entry = entries.pop();
      if (entry !== undefined) entries.splice(position, 0, entry);
      return ok({ first: record.firstTile, count: record.layout.cards.length });
    },
    retransform(instanceId, transform) {
      const record = editable.get(instanceId);
      if (disposed || record === undefined || request.kind !== 'cards')
        return rayReferenceFailure('in-place Card edits require a live captured instance');
      const instance = { ...record.instance, transform: Array.from(transform) };
      const projections: SurfaceCardProjection[] = [];
      for (const local of record.layout.cards) {
        const transformed = transformCardProjection(local, instance.transform);
        if (!transformed.ok) return transformed;
        projections.push(transformed.value);
      }
      const scenes = [];
      for (const section of record.sections) {
        const scene = buildRaySurfaceScene([
          {
            ...instance,
            materialId: section.materialId,
            indices: Array.from(
              { length: section.indexCount },
              (_, i) => instance.indices[section.indexOffset + i] ?? NaN,
            ),
          },
        ]);
        if (!scene.ok) return scene;
        const winding = new DataView(scene.value.attributes.buffer).getFloat32(108, true);
        if (Math.sign(winding) !== Math.sign(section.winding))
          return rayReferenceFailure('a Card edit that mirrors winding requires a rebuild');
        scenes.push(scene.value);
      }
      for (const [i, card] of projections.entries()) {
        const buffer = record.projections[i];
        if (buffer === undefined) return rayReferenceFailure('Card projection count changed');
        const written = writeProjection(buffer, card);
        if (!written.ok) return written;
      }
      for (const [i, section] of record.sections.entries()) {
        const scene = scenes[i];
        if (scene === undefined) return rayReferenceFailure('Card section count changed');
        for (const [buffer, bytes] of [
          [section.triangles, scene.triangles],
          [section.attributes, scene.attributes],
        ] as const) {
          const written = device.queue.writeBuffer(buffer, 0, bytes);
          if (!written.ok) return rayReferenceFailure(written.error.expected);
        }
      }
      record.instance = instance;
      const index = entries.findIndex((e) => e.instanceId === instanceId);
      const previous = entries[index];
      const geometryKey = rayGeometryKey(instance, record.layout.meshDigest);
      entries[index] = {
        instanceId,
        geometryKey,
        captureKey: JSON.stringify([previous?.captureKey, geometryKey]),
        projections,
      };
      return ok({ first: record.firstTile, count: projections.length });
    },
    remove(instanceId) {
      const record = editable.get(instanceId);
      if (disposed || record === undefined)
        return rayReferenceFailure('Card removal requires a live captured instance');
      detach(instanceId);
      const run = { first: record.firstTile, end: record.firstTile + record.layout.cards.length };
      if (request.kind === 'cards') tiles.free(run);
      return ok({ first: run.first, count: run.end - run.first });
    },
    recordPass(pass, tiles) {
      if (disposed) return rayReferenceFailure('surface cards are disposed');
      const first = tiles?.first ?? 0;
      const end = tiles === undefined ? Number.POSITIVE_INFINITY : first + tiles.count;
      for (const draw of draws) {
        if (draw.firstTile >= end || draw.firstTile + draw.cards.length <= first) continue;
        pass.setPipeline(draw.pipeline);
        pass.setBindGroup(1, draw.material);
        draw.cards.forEach((group, cardIndex) => {
          const tile = draw.firstTile + cardIndex;
          if (tile < first || tile >= end) return;
          tileRect(pass, tile);
          pass.setBindGroup(0, group);
          pass.draw(draw.vertices);
        });
      }
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
