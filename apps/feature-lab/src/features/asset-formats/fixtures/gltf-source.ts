function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function concat(parts: readonly ArrayBufferView[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
    offset += part.byteLength;
  }
  return out;
}

const CUBE_POSITIONS: readonly number[] = (() => {
  const faces: readonly (readonly number[])[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const out: number[] = [];
  for (const n of faces) {
    const axis = n.findIndex((v) => v !== 0);
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const sign = n[axis] ?? 1;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const p = [0, 0, 0];
      p[axis] = 0.5 * sign;
      p[u] = 0.5 * a * sign;
      p[v] = 0.5 * b;
      out.push(...p);
    }
  }
  return out;
})();

const CUBE_NORMALS: readonly number[] = [0, 1, 2, 3, 4, 5].flatMap((face) => {
  const n = [0, 0, 0];
  n[Math.floor(face / 2)] = face % 2 === 0 ? 1 : -1;
  return [...n, ...n, ...n, ...n];
});

const CUBE_INDICES: readonly number[] = [0, 1, 2, 3, 4, 5].flatMap((face) => {
  const b = face * 4;
  return [b, b + 1, b + 2, b, b + 2, b + 3];
});

/**
 * A 1x1x1 cube mesh named Box with a Red material under a single-node scene. `png` adds TEXCOORD_0 and
 * an embedded baseColorTexture (data URI image + default sampler).
 */
export function cubeGltf(options: { readonly glb?: boolean; readonly png?: Uint8Array } = {}): {
  readonly json: Record<string, unknown>;
  readonly bin: Uint8Array;
} {
  const positions = new Float32Array(CUBE_POSITIONS);
  const normals = new Float32Array(CUBE_NORMALS);
  const indices = new Uint16Array(CUBE_INDICES);
  const uvs = new Float32Array([0, 1, 2, 3, 4, 5].flatMap(() => [0, 0, 1, 0, 1, 1, 0, 1]));
  const png = options.png;
  const bin = concat(
    png === undefined ? [positions, normals, indices] : [positions, normals, indices, uvs],
  );
  const buffer =
    options.glb === true
      ? { byteLength: bin.byteLength }
      : { byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${base64(bin)}` };
  const json = {
    asset: { version: '2.0' },
    buffers: [buffer],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
      {
        buffer: 0,
        byteOffset: positions.byteLength + normals.byteLength,
        byteLength: indices.byteLength,
      },
      ...(png === undefined
        ? []
        : [
            {
              buffer: 0,
              byteOffset: positions.byteLength + normals.byteLength + indices.byteLength,
              byteLength: uvs.byteLength,
            },
          ]),
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 24,
        type: 'VEC3',
        min: [-0.5, -0.5, -0.5],
        max: [0.5, 0.5, 0.5],
      },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
      ...(png === undefined
        ? []
        : [{ bufferView: 3, componentType: 5126, count: 24, type: 'VEC2' }]),
    ],
    materials: [
      {
        name: 'Red',
        pbrMetallicRoughness: {
          baseColorFactor: [0.9, 0.15, 0.1, 1],
          metallicFactor: 0,
          roughnessFactor: 0.6,
          ...(png === undefined ? {} : { baseColorTexture: { index: 0 } }),
        },
      },
    ],
    ...(png === undefined
      ? {}
      : {
          textures: [{ source: 0, sampler: 0 }],
          samplers: [{ magFilter: 9728, minFilter: 9728 }],
          images: [
            { name: 'Checker', uri: `data:image/png;base64,${base64(png)}`, mimeType: 'image/png' },
          ],
        }),
    meshes: [
      {
        name: 'Box',
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, ...(png === undefined ? {} : { TEXCOORD_0: 3 }) },
            indices: 2,
            material: 0,
          },
        ],
      },
    ],
    nodes: [{ name: 'Box', mesh: 0, translation: [0, 0.5, 0] }],
    scenes: [{ name: 'Lab', nodes: [0] }],
    scene: 0,
  };
  return { json, bin };
}

/** Assemble a GLB 2.0 container (12-byte header, JSON chunk padded with spaces, BIN chunk padded with zeros). */
export function buildGlb(json: Record<string, unknown>, bin: Uint8Array, version = 2): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(jsonBytes.byteLength / 4) * 4;
  const binLength = Math.ceil(bin.byteLength / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, version, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(jsonBytes, 20);
  const binHeader = 20 + jsonLength;
  view.setUint32(binHeader, binLength, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  out.set(bin, binHeader + 8);
  return out.buffer;
}

/** One-vertex skinned point mesh whose single joint translates from x=0 to x=4 over one second (LINEAR). */
export function skinnedGltf(
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE' = 'LINEAR',
): Record<string, unknown> {
  const cubic = interpolation === 'CUBICSPLINE';
  const binary = new Uint8Array(cubic ? 116 : 72);
  new Float32Array(binary.buffer, 0, 3).set([1, 0, 0]);
  new Uint16Array(binary.buffer, 12, 4).set([0, 0, 0, 0]);
  new Float32Array(binary.buffer, 20, 4).set([1, 0, 0, 0]);
  new Float32Array(binary.buffer, 36, 2).set([0, 1]);
  new Float32Array(binary.buffer, 44, cubic ? 18 : 6).set(
    cubic ? [0, 0, 0, 0, 0, 0, 4, 2, 0, 4, 2, 0, 4, 2, 0, 0, 0, 0] : [0, 0, 0, 4, 2, 0],
  );
  return {
    asset: { version: '2.0' },
    buffers: [
      {
        byteLength: binary.byteLength,
        uri: `data:application/octet-stream;base64,${base64(binary)}`,
      },
    ],
    bufferViews: [
      [0, 12],
      [12, 8],
      [20, 16],
      [36, 8],
      [44, cubic ? 72 : 24],
    ].map(([byteOffset, byteLength]) => ({ buffer: 0, byteOffset, byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 1, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 1, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: cubic ? 6 : 2, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ mode: 0, attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    nodes: [
      { name: 'root', children: [1, 2] },
      { name: 'mesh', mesh: 0, skin: 0 },
      { name: 'joint' },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
    skins: [{ joints: [2] }],
    animations: [
      {
        name: 'Slide',
        channels: [{ sampler: 0, target: { node: 2, path: 'translation' } }],
        samplers: [{ input: 3, output: 4, interpolation }],
      },
    ],
  };
}

export const rejectLoader = (uri: string): Promise<ArrayBuffer> =>
  Promise.reject(new Error(`unexpected external uri ${uri}`));
