import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AttributeTypedArray,
  buildKernelMeshSections,
  createKernelMeshBuilder,
  createRustEditMesh,
  createRustPbrSurface,
  generatePerlinFbm,
  initModelingKernelWasmSync,
  liveRustBuilderCount,
  liveRustImageCount,
  liveRustMeshCount,
  liveRustSurfaceCount,
  modelingKernelWasmUrl,
} from '@forgeax/modeling-kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  fromThreeBufferGeometry,
  type ThreeBox3Like,
  type ThreeBufferAttributeLike,
  type ThreeBufferGeometryLike,
  type ThreeDataTextureLike,
  type ThreeGeometryNamespace,
  type ThreeTextureNamespace,
  toThreeBufferGeometry,
  toThreeStandardMaterialTextures,
} from '../index';

const __dirname = dirname(fileURLToPath(import.meta.url));

class MockVector3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
}

class MockBox3 implements ThreeBox3Like {
  min: MockVector3;
  max: MockVector3;
  constructor(min?: unknown, max?: unknown) {
    this.min = (min as MockVector3) ?? new MockVector3();
    this.max = (max as MockVector3) ?? new MockVector3();
  }
}

class MockBufferAttribute implements ThreeBufferAttributeLike {
  constructor(
    public readonly array: AttributeTypedArray,
    public readonly itemSize: number,
    public readonly normalized = false,
  ) {}
}

class MockBufferGeometry implements ThreeBufferGeometryLike {
  readonly attributes = new Map<string, ThreeBufferAttributeLike>();
  private indexAttr: ThreeBufferAttributeLike | null = null;
  readonly groups: { start: number; count: number; materialIndex?: number }[] = [];
  boundingBox: ThreeBox3Like | null = null;

  setAttribute(name: string, attribute: ThreeBufferAttributeLike): this {
    this.attributes.set(name, attribute);
    return this;
  }
  getAttribute(name: string): ThreeBufferAttributeLike | undefined {
    return this.attributes.get(name);
  }
  setIndex(index: ThreeBufferAttributeLike | null): this {
    this.indexAttr = index;
    return this;
  }
  getIndex(): ThreeBufferAttributeLike | null {
    return this.indexAttr;
  }
  clearGroups(): void {
    this.groups.length = 0;
  }
  addGroup(start: number, count: number, materialIndex?: number): void {
    this.groups.push({ start, count, ...(materialIndex === undefined ? {} : { materialIndex }) });
  }
}

const mockThree: ThreeGeometryNamespace = {
  BufferGeometry: MockBufferGeometry,
  BufferAttribute: MockBufferAttribute,
  Box3: MockBox3,
  Vector3: MockVector3,
};

beforeAll(() => {
  initModelingKernelWasmSync(readFileSync(modelingKernelWasmUrl()));
});

describe('@forgeax/modeling-kernel-three zero-copy adapter', () => {
  it('enforces zero @forgeax/engine-* dependencies in package.json', () => {
    const pkgPath = resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    expect(deps.filter((d) => d.startsWith('@forgeax/engine-'))).toEqual([]);
    expect(deps).toContain('@forgeax/modeling-kernel');
    expect(deps).toContain('three');
  });

  it('binds separate Rust RawMeshData to Three.js BufferGeometry with zero buffer copies', () => {
    const builder = createKernelMeshBuilder({
      layout: [
        'position',
        'uv',
        { key: 'skinIndex', format: 'uint16x4' },
        { key: 'skinWeight', format: 'unorm8x4' },
      ],
      materialSlotNames: ['body', 'trim'],
      backend: 'rust',
    }).unwrap();

    const v = builder.allocateVertices(4).unwrap();
    (v.channels.position as Float32Array).set([0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0]);
    (v.channels.uv as Float32Array).set([0, 0, 1, 0, 1, 1, 0, 1]);
    (v.channels.skinIndex as Uint16Array).set([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    (v.channels.skinWeight as Uint8Array).set([
      255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0,
    ]);

    const idx = builder.allocateIndices(6).unwrap();
    idx.indices.set([0, 1, 2, 0, 2, 3]);
    builder.addSubmesh({ indexOffset: 0, indexCount: 3, materialSlot: 0 }).unwrap();
    builder.addSubmesh({ indexOffset: 3, indexCount: 3, materialSlot: 1 }).unwrap();

    const raw = builder.build({ outputMode: 'separate', dispose: true }).unwrap();
    const geom = toThreeBufferGeometry(raw, mockThree).unwrap();

    const channels = raw.channels;
    if (channels === undefined) throw new Error('expected separate channels');

    // Strict zero-copy reference identity: TypedArrays are passed directly, never sliced or copied.
    expect(geom.getAttribute('position')?.array).toBe(channels.position);
    expect(geom.getAttribute('normal')?.array).toBe(channels.normal);
    expect(geom.getAttribute('uv')?.array).toBe(channels.uv);
    expect(geom.getAttribute('tangent')?.array).toBe(channels.tangent);
    expect(geom.getAttribute('skinIndex')?.array).toBe(channels.skinIndex);
    expect(geom.getAttribute('skinWeight')?.array).toBe(channels.skinWeight);
    expect(geom.getAttribute('skinWeight')?.normalized).toBe(true);
    expect(geom.getAttribute('position')?.normalized).toBe(false);
    expect(geom.getIndex()?.array).toBe(raw.indices);
    expect(geom.groups).toEqual([
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
    ]);
    const box = geom.boundingBox as MockBox3;
    expect([box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]).toEqual([
      0, 0, 0, 2, 3, 0,
    ]);

    // Round-trip back from Three.js BufferGeometry into the kernel.
    const extracted = fromThreeBufferGeometry(geom).unwrap();
    expect(extracted.attributes.position).toBe(channels.position);
    expect(extracted.indices).toBe(raw.indices);

    const rebuilt = buildKernelMeshSections(
      {
        sections: [
          {
            materialSlot: 0,
            attributes: extracted.attributes,
            ...(extracted.indices === undefined ? {} : { indices: extracted.indices }),
          },
        ],
        backend: 'rust',
      },
      { outputMode: 'separate' },
    ).unwrap();
    expect(rebuilt.vertexCount).toBe(4);
    expect(liveRustBuilderCount()).toBe(0);
  });

  it('returns structured precondition error when RawMeshData has no separate channels', () => {
    const builder = createKernelMeshBuilder({ layout: ['position'], backend: 'rust' }).unwrap();
    const v = builder.allocateVertices(3).unwrap();
    (v.channels.position as Float32Array).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const raw = builder.build({ outputMode: 'interleaved', dispose: true }).unwrap();
    const res = toThreeBufferGeometry(raw, mockThree);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('kernel-precondition');
    expect(liveRustBuilderCount()).toBe(0);
  });

  it('exports RustEditMesh box -> subdivide directly to Three.js BufferGeometry without ForgeaX engine deps', () => {
    const mesh = createRustEditMesh().unwrap();
    mesh.box({ size: [2, 2, 2] }).unwrap();
    const allFaces = [0, 1, 2, 3, 4, 5];
    mesh.subdivide(allFaces, { levels: 2, scheme: 'catmullClark' }).unwrap();
    const raw = mesh.toRawMeshData('separate').unwrap();
    const geom = toThreeBufferGeometry(raw, mockThree).unwrap();

    expect(geom.getAttribute('position')?.array).toBe(raw.channels?.position);
    expect(geom.getAttribute('normal')?.array).toBe(raw.channels?.normal);
    expect(geom.getIndex()?.array).toBe(raw.indices);
    expect(raw.vertexCount).toBe(6 * 16 * 4);
    mesh.dispose();
    expect(liveRustMeshCount()).toBe(0);
  });

  it('binds StandardPbrTextureSet to Three.js DataTextures with zero buffer copy and shared ORM texture', () => {
    class MockDataTexture implements ThreeDataTextureLike {
      readonly image: {
        readonly data: Uint8Array;
        readonly width: number;
        readonly height: number;
      };
      colorSpace = '';
      wrapS = 0;
      wrapT = 0;
      flipY = true;
      needsUpdate = false;
      disposed = false;
      constructor(data: Uint8Array, width: number, height: number) {
        this.image = { data, width, height };
      }
      dispose(): void {
        this.disposed = true;
      }
    }
    const mockTexThree: ThreeTextureNamespace & {
      readonly DataTexture: new (
        data: Uint8Array,
        width: number,
        height: number,
      ) => MockDataTexture;
    } = {
      DataTexture: MockDataTexture,
      SRGBColorSpace: 'srgb',
      NoColorSpace: '',
      RepeatWrapping: 1000,
    };

    const noise = generatePerlinFbm({ width: 32, height: 32, scaleX: 4, seed: 1 }).unwrap();
    const surf = createRustPbrSurface(32, 32).unwrap();
    surf
      .addLayer({
        baseColor: [0.6, 0.3, 0.2],
        roughness: 0.45,
        metallic: 0.85,
        heightMap: noise,
      })
      .unwrap();
    const pbr = surf.exportStandardPbr({ heightNormalStrength: 2.0, dispose: true }).unwrap();
    noise.dispose();

    const bindings = toThreeStandardMaterialTextures(pbr, mockTexThree);
    // Strict zero-copy buffer identity
    expect(bindings.map.image.data).toBe(pbr.baseColor);
    expect(bindings.normalMap.image.data).toBe(pbr.normal);
    expect(bindings.aoMap.image.data).toBe(pbr.orm);
    // Shared single ORM texture across aoMap / roughnessMap / metalnessMap
    expect(bindings.aoMap).toBe(bindings.roughnessMap);
    expect(bindings.roughnessMap).toBe(bindings.metalnessMap);
    expect(bindings.emissiveMap).toBeUndefined();
    expect(bindings.uniqueTextures.length).toBe(3);

    // Proper sRGB vs Linear color spaces
    expect(bindings.map.colorSpace).toBe('srgb');
    expect(bindings.normalMap.colorSpace).toBe('');
    expect(bindings.aoMap.colorSpace).toBe('');
    expect(bindings.map.flipY).toBe(false);
    expect(bindings.map.needsUpdate).toBe(true);

    bindings.dispose();
    for (const tex of bindings.uniqueTextures) {
      expect(tex.disposed).toBe(true);
    }
    expect(liveRustImageCount()).toBe(0);
    expect(liveRustSurfaceCount()).toBe(0);
  });
});
