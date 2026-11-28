import {
  type AttributeKey,
  type AttributeTypedArray,
  CANONICAL_ATTRIBUTE_KEYS,
  err,
  formatComponentCount,
  KernelError,
  type KernelResult,
  ok,
  type RawAttributeChannels,
  type RawMeshData,
  type StandardPbrTextureSet,
} from '@forgeax/modeling-kernel';

/** Minimal structural surface of Three.js BufferAttribute (works with any Three.js r160+ build). */
export interface ThreeBufferAttributeLike {
  readonly array: ArrayLike<number>;
  readonly itemSize: number;
  readonly normalized?: boolean;
}

/** Minimal structural surface of Three.js Box3 / Vector3. */
export interface ThreeBox3Like {
  min: { set(x: number, y: number, z: number): unknown };
  max: { set(x: number, y: number, z: number): unknown };
}

/** Minimal structural surface of Three.js BufferGeometry. */
export interface ThreeBufferGeometryLike {
  setAttribute(name: string, attribute: ThreeBufferAttributeLike): unknown;
  getAttribute(name: string): ThreeBufferAttributeLike | undefined;
  setIndex(index: ThreeBufferAttributeLike | null): unknown;
  getIndex(): ThreeBufferAttributeLike | null;
  clearGroups(): unknown;
  addGroup(start: number, count: number, materialIndex?: number): unknown;
  readonly groups: readonly { start: number; count: number; materialIndex?: number }[];
  boundingBox: ThreeBox3Like | null;
}

/** Minimal Three.js module surface passed to zero-copy adapter helpers. */
export interface ThreeGeometryNamespace {
  readonly BufferGeometry: new () => ThreeBufferGeometryLike;
  readonly BufferAttribute: new (
    array: AttributeTypedArray,
    itemSize: number,
    normalized?: boolean,
  ) => ThreeBufferAttributeLike;
  readonly Box3?: new (min?: unknown, max?: unknown) => ThreeBox3Like;
  readonly Vector3?: new (x?: number, y?: number, z?: number) => unknown;
}

const KERNEL_TO_THREE_ATTR: Readonly<Partial<Record<AttributeKey, string>>> = {
  position: 'position',
  normal: 'normal',
  uv: 'uv',
  tangent: 'tangent',
  skinIndex: 'skinIndex',
  skinWeight: 'skinWeight',
  uv1: 'uv1',
  uv2: 'uv2',
  uv3: 'uv3',
  uv4: 'uv4',
  uv5: 'uv5',
  uv6: 'uv6',
  uv7: 'uv7',
  color: 'color',
};

/**
 * Bind a `RawMeshData` produced with `outputMode: 'separate'` (or `'interleaved-with-channels'`)
 * directly onto a Three.js `BufferGeometry` with zero attribute buffer copies.
 */
export function toThreeBufferGeometry<G extends ThreeBufferGeometryLike>(
  raw: RawMeshData,
  three: ThreeGeometryNamespace,
  target?: G,
): KernelResult<G> {
  if (raw.channels === undefined) {
    return err(
      new KernelError(
        'kernel-precondition',
        'outputMode',
        'toThreeBufferGeometry requires RawMeshData built with outputMode: "separate" or "interleaved-with-channels"',
      ),
    );
  }
  const geometry = (target ?? new three.BufferGeometry()) as G;
  for (const decl of raw.layout) {
    const threeName = KERNEL_TO_THREE_ATTR[decl.key];
    if (threeName === undefined) continue;
    const array = raw.channels[decl.key];
    if (array === undefined) continue;
    const normalized = decl.format === 'unorm8x4' || decl.format === 'unorm16x4';
    const attr = new three.BufferAttribute(array, formatComponentCount(decl.format), normalized);
    geometry.setAttribute(threeName, attr);
  }
  if (raw.indices !== undefined) {
    geometry.setIndex(new three.BufferAttribute(raw.indices, 1, false));
  } else {
    geometry.setIndex(null);
  }
  geometry.clearGroups();
  for (const sub of raw.submeshes) {
    geometry.addGroup(
      raw.indices !== undefined ? sub.indexOffset : 0,
      raw.indices !== undefined ? sub.indexCount : sub.vertexCount,
      sub.materialSlot,
    );
  }
  if (three.Box3 !== undefined && three.Vector3 !== undefined) {
    const box = new three.Box3(
      new three.Vector3(raw.aabb[0], raw.aabb[1], raw.aabb[2]),
      new three.Vector3(raw.aabb[3], raw.aabb[4], raw.aabb[5]),
    );
    geometry.boundingBox = box;
  }
  return ok(geometry);
}

/**
 * Extract zero-copy channel views and index arrays from an existing Three.js `BufferGeometry`.
 */
export function fromThreeBufferGeometry(geometry: ThreeBufferGeometryLike): KernelResult<{
  readonly attributes: RawAttributeChannels;
  readonly indices?: Uint16Array | Uint32Array;
  readonly groups: readonly {
    readonly start: number;
    readonly count: number;
    readonly materialSlot: number;
  }[];
}> {
  const attributes: RawAttributeChannels = {};
  for (const key of CANONICAL_ATTRIBUTE_KEYS) {
    const threeName = KERNEL_TO_THREE_ATTR[key];
    if (threeName === undefined) continue;
    const attr = geometry.getAttribute(threeName);
    if (attr === undefined) continue;
    const arr = attr.array;
    if (
      arr instanceof Float32Array ||
      arr instanceof Uint8Array ||
      arr instanceof Uint16Array ||
      arr instanceof Uint32Array
    ) {
      attributes[key] = arr;
    }
  }
  if (attributes.position === undefined) {
    return err(
      new KernelError(
        'kernel-invalid-value',
        'attributes.position',
        'BufferGeometry has no position attribute',
      ),
    );
  }
  const indexAttr = geometry.getIndex();
  let indices: Uint16Array | Uint32Array | undefined;
  if (indexAttr !== null) {
    if (indexAttr.array instanceof Uint16Array || indexAttr.array instanceof Uint32Array) {
      indices = indexAttr.array;
    } else {
      indices = Uint32Array.from(indexAttr.array);
    }
  }
  const groups = geometry.groups.map((g) => ({
    start: g.start,
    count: g.count,
    materialSlot: g.materialIndex ?? 0,
  }));
  return ok({
    attributes,
    ...(indices === undefined ? {} : { indices }),
    groups,
  });
}

/** Minimal structural surface of Three.js `DataTexture` (r152+ `colorSpace` convention). */
export interface ThreeDataTextureLike {
  readonly image: {
    readonly data: ArrayBufferView;
    readonly width: number;
    readonly height: number;
  };
  colorSpace: string;
  wrapS: number;
  wrapT: number;
  flipY: boolean;
  needsUpdate: boolean;
  dispose?(): void;
}

/** Minimal Three.js texture namespace accepted by `toThreeStandardMaterialTextures`. */
export interface ThreeTextureNamespace<T extends ThreeDataTextureLike = ThreeDataTextureLike> {
  readonly DataTexture: new (
    data: Uint8Array,
    width: number,
    height: number,
    format?: number,
    type?: number,
  ) => T;
  readonly RGBAFormat?: number;
  readonly UnsignedByteType?: number;
  readonly RepeatWrapping?: number;
  readonly SRGBColorSpace?: string;
  readonly NoColorSpace?: string;
}

/**
 * Standard Three.js `MeshStandardMaterial` texture map bindings ready to spread directly
 * into `new THREE.MeshStandardMaterial({ ...textures })`.
 * Note that `aoMap`, `roughnessMap`, and `metalnessMap` intentionally alias the single
 * shared ORM `DataTexture` (`R=AO, G=Roughness, B=Metallic`).
 */
export interface ThreeStandardPbrTextureBindings<
  T extends ThreeDataTextureLike = ThreeDataTextureLike,
> {
  readonly map: T;
  readonly normalMap: T;
  readonly aoMap: T;
  readonly roughnessMap: T;
  readonly metalnessMap: T;
  readonly emissiveMap?: T;
  /** Unique texture instances (`[map, normalMap, orm, emissiveMap?]`) for clean disposal. */
  readonly uniqueTextures: readonly T[];
  dispose(): void;
}

/**
 * Wrap a kernel `StandardPbrTextureSet` into Three.js `DataTexture` objects with zero pixel
 * buffer copies, proper sRGB/Linear color spaces, and a single shared ORM texture bound to
 * `aoMap`, `roughnessMap`, and `metalnessMap`.
 */
export function toThreeStandardMaterialTextures<T extends ThreeDataTextureLike>(
  pbr: StandardPbrTextureSet,
  three: ThreeTextureNamespace<T>,
): ThreeStandardPbrTextureBindings<T> {
  const rgbaFmt = three.RGBAFormat ?? 1023;
  const u8Type = three.UnsignedByteType ?? 1009;
  const repeat = three.RepeatWrapping ?? 1000;
  const srgb = three.SRGBColorSpace ?? 'srgb';
  const linear = three.NoColorSpace ?? '';

  const makeTex = (bytes: Uint8Array, colorSpace: string): T => {
    const tex = new three.DataTexture(bytes, pbr.width, pbr.height, rgbaFmt, u8Type);
    tex.colorSpace = colorSpace;
    tex.wrapS = repeat;
    tex.wrapT = repeat;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  };

  const map = makeTex(pbr.baseColor, srgb);
  const normalMap = makeTex(pbr.normal, linear);
  const orm = makeTex(pbr.orm, linear);
  const emissiveMap = pbr.emissive !== undefined ? makeTex(pbr.emissive, srgb) : undefined;
  const uniqueTextures: T[] =
    emissiveMap !== undefined ? [map, normalMap, orm, emissiveMap] : [map, normalMap, orm];

  return {
    map,
    normalMap,
    aoMap: orm,
    roughnessMap: orm,
    metalnessMap: orm,
    ...(emissiveMap === undefined ? {} : { emissiveMap }),
    uniqueTextures,
    dispose(): void {
      for (const tex of uniqueTextures) {
        tex.dispose?.();
      }
    },
  };
}
