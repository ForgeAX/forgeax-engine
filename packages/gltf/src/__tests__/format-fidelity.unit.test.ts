import { describe, expect, it } from 'vitest';
import { decodeAccessor } from '../accessor/decode-accessor';
import { gltfDocToSceneAsset, toMaterialAsset } from '../bridge';
import { parseGltf } from '../parse-gltf';

const load = async () => {
  throw new Error('unexpected external dependency');
};
function source(extra: Record<string, unknown>, bytes = new Uint8Array()) {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Object', mesh: 0 }],
    ...(bytes.length === 0
      ? {}
      : {
          buffers: [
            {
              byteLength: bytes.length,
              uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`,
            },
          ],
        }),
    ...extra,
  };
}
describe('source-format fidelity through the ordinary glTF parser', () => {
  it('deinterleaves positions with offsets and a padded final element', async () => {
    const bytes = new Uint8Array(56);
    const view = new DataView(bytes.buffer);
    [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => {
      view.setFloat32(8 + Math.floor(i / 3) * 16 + (i % 3) * 4, v, true);
    });
    const result = await parseGltf(
      source(
        {
          bufferViews: [{ buffer: 0, byteOffset: 4, byteLength: 48, byteStride: 16 }],
          accessors: [
            { bufferView: 0, byteOffset: 4, componentType: 5126, type: 'VEC3', count: 3 },
          ],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        },
        bytes,
      ),
      load,
      'stride.gltf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(requireValue(result.value.meshes[0]).positions)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
  });
  it('decodes zero-based sparse positions and sparse morph deltas', async () => {
    const bytes = new Uint8Array(28);
    bytes.set([1, 2]);
    new Float32Array(bytes.buffer, 4).set([1, 0, 0, 0, 1, 0]);
    const accessor = {
      componentType: 5126,
      type: 'VEC3',
      count: 3,
      sparse: {
        count: 2,
        indices: { bufferView: 0, componentType: 5121 },
        values: { bufferView: 1 },
      },
    };
    const result = await parseGltf(
      source(
        {
          bufferViews: [
            { buffer: 0, byteLength: 2 },
            { buffer: 0, byteOffset: 4, byteLength: 24 },
          ],
          accessors: [accessor, accessor],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }] }] }],
        },
        bytes,
      ),
      load,
      'sparse.gltf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(requireValue(result.value.meshes[0]).positions)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
    expect(requireValue(result.value.meshes[0]).morphTargets?.[0]?.position).toEqual(
      requireValue(result.value.meshes[0]).positions,
    );
  });
  it.each([
    [
      { type: 'perspective', perspective: { yfov: 1.2, aspectRatio: 1.5, znear: 0.3, zfar: 250 } },
      { fov: 1.2, aspect: 1.5, near: 0.3, far: 250 },
    ],
    [
      { type: 'orthographic', orthographic: { xmag: 3, ymag: 2, znear: 0, zfar: 40 } },
      { projection: 1, left: -3, right: 3, top: 2, bottom: -2, near: 0, far: 40 },
    ],
  ])('preserves camera projection %j', async (camera, expected) => {
    const result = await parseGltf(
      source({ nodes: [{ name: 'Camera', camera: 0 }], cameras: [camera] }),
      load,
      'camera.gltf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = gltfDocToSceneAsset(result.value, {
      meshHandles: new Map(),
      materialHandles: new Map(),
    });
    expect(requireValue(Object.values(scene.entities)[0]).components.Camera).toMatchObject(
      expected,
    );
  });
  it('decodes matrix column padding without requiring terminal padding and rejects sparse duplicates', () => {
    const bytes = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9]);
    const dense = decodeAccessor({
      accessorIndex: 0,
      accessor: { bufferView: 0, count: 1, componentType: 5121, type: 'MAT3' },
      bufferViews: [{ buffer: 0, byteLength: 11 }],
      buffers: [bytes],
      role: 'attribute',
    }).unwrap();
    expect(Array.from(dense.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const sparse = decodeAccessor({
      accessorIndex: 1,
      accessor: {
        count: 3,
        componentType: 5121,
        type: 'SCALAR',
        sparse: {
          count: 2,
          indices: { bufferView: 0, componentType: 5121 },
          values: { bufferView: 1 },
        },
      },
      bufferViews: [
        { buffer: 0, byteLength: 2 },
        { buffer: 0, byteOffset: 2, byteLength: 2 },
      ],
      buffers: [new Uint8Array([1, 1, 5, 6])],
      role: 'attribute',
    });
    expect(sparse.ok).toBe(false);
  });
  it('imports sparse, strided cubic animation and VEC3 morph tangents', async () => {
    const bytes = new Uint8Array(144);
    new Float32Array(bytes.buffer).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const view = new DataView(bytes.buffer);
    view.setFloat32(36, 0, true);
    view.setFloat32(44, 2, true);
    new Float32Array(bytes.buffer, 52, 18).set([
      0, 0, 0, 0, 0, 0, 3, 0, 0, -3, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    bytes[124] = 1;
    new Float32Array(bytes.buffer, 128, 3).set([0.2, 0.3, 0.4]);
    const result = await parseGltf(
      source(
        {
          bufferViews: [
            { buffer: 0, byteLength: 36 },
            { buffer: 0, byteOffset: 36, byteLength: 16, byteStride: 8 },
            { buffer: 0, byteOffset: 52, byteLength: 72 },
            { buffer: 0, byteOffset: 124, byteLength: 1 },
            { buffer: 0, byteOffset: 128, byteLength: 12 },
          ],
          accessors: [
            { bufferView: 0, count: 3, type: 'VEC3', componentType: 5126 },
            { bufferView: 1, count: 2, type: 'SCALAR', componentType: 5126 },
            { bufferView: 2, count: 6, type: 'VEC3', componentType: 5126 },
            {
              count: 3,
              type: 'VEC3',
              componentType: 5126,
              sparse: {
                count: 1,
                indices: { bufferView: 3, componentType: 5121 },
                values: { bufferView: 4 },
              },
            },
          ],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ TANGENT: 3 }] }] }],
          animations: [
            {
              samplers: [{ input: 1, output: 2, interpolation: 'CUBICSPLINE' }],
              channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
            },
          ],
        },
        bytes,
      ),
      load,
      'cubic.gltf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.animationClips?.[0]?.channels[0]?.sampler).toMatchObject({
      input: new Float32Array([0, 2]),
      output: new Float32Array(bytes.buffer.slice(52, 124)),
      interpolation: 'CUBICSPLINE',
    });
    expect(result.value.meshes[0]?.morphTargets?.[0]?.tangent).toEqual(
      new Float32Array([0, 0, 0, 0, 0.2, 0.3, 0.4, 0, 0, 0, 0, 0]),
    );
  });
  it('does not drop a declared malformed normal and preserves automatic aspect only when omitted', async () => {
    const invalid = await parseGltf(
      source({
        accessors: [{ componentType: 5126, type: 'VEC3', count: 3 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 99 } }] }],
      }),
      load,
      'bad-normal.gltf',
    );
    expect(invalid.ok).toBe(false);
    const automatic = await parseGltf(
      source({
        nodes: [{ name: 'Camera', camera: 0 }],
        cameras: [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }],
      }),
      load,
      'auto-camera.gltf',
    );
    expect(automatic.unwrap().nodes[0]?.camera).toMatchObject({ autoAspect: true });
  });
  it.each([
    { type: 'perspective', perspective: { yfov: 1, znear: 0.1, aspectRatio: 1e-80 } },
    { type: 'orthographic', orthographic: { xmag: 1e-30, ymag: 1e30, znear: 0, zfar: 10 } },
    { type: 'perspective', perspective: { yfov: Math.PI - 1e-8, znear: 0.1 } },
  ])('rejects camera values whose positive contract collapses in Float32 %j', async (camera) => {
    const result = await parseGltf(
      source({ nodes: [{ camera: 0 }], cameras: [camera] }),
      load,
      'unrepresentable-camera.gltf',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('gltf-camera-invalid');
  });
  it('retains required unlit and emissive strength declarations', async () => {
    const result = await parseGltf(
      source({
        nodes: [],
        extensionsRequired: ['KHR_materials_unlit', 'KHR_materials_emissive_strength'],
        materials: [
          { extensions: { KHR_materials_unlit: {} } },
          {
            emissiveFactor: [0.2, 0.4, 0.1],
            extensions: { KHR_materials_emissive_strength: { emissiveStrength: 7 } },
          },
        ],
      }),
      load,
      'material.gltf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      toMaterialAsset(requireValue(result.value.materials[0])).passes?.[0]?.program.module,
    ).toContain('unlit');
    expect(toMaterialAsset(requireValue(result.value.materials[1])).values).toMatchObject({
      emissive: [0.2, 0.4, 0.1],
      emissiveIntensity: 7,
    });
  });
});

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
