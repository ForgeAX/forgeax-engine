import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { meshIrToMeshAsset, parseGlb, parseGltf } from '@forgeax/engine-gltf';
import type { ImportContext, MeshAsset } from '@forgeax/engine-types';
import { validateBytes } from 'gltf-validator';
import { describe, expect, it } from 'vitest';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}

import {
  exportMeshes,
  importMeshFile,
  objImporter,
  parseObj,
  parseStl,
  parseSvg,
} from '../index.js';

const OBJECT =
  'o Triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\nf -3/-3/1 -2/-2/1 -1/-1/1\n';
function firstMesh(result: ReturnType<typeof parseObj>): MeshAsset {
  return required(result.unwrap()[0]).mesh;
}
function box(): MeshAsset {
  return createBoxGeometry(1, 1, 1).unwrap();
}
function positions(mesh: MeshAsset): Float32Array {
  const result = mesh.attributes.position;
  if (!(result instanceof Float32Array)) throw new Error('expected position array');
  return result;
}
function area(mesh: MeshAsset): number {
  const p = positions(mesh);
  const idx = mesh.indices;
  let sum = 0;
  for (let i = 0; i < (idx?.length ?? p.length / 3); i += 3) {
    const a = (idx?.[i] ?? i) * 3;
    const b = (idx?.[i + 1] ?? i + 1) * 3;
    const c = (idx?.[i + 2] ?? i + 2) * 3;
    sum +=
      Math.abs(
        ((p[b] ?? 0) - (p[a] ?? 0)) * ((p[c + 1] ?? 0) - (p[a + 1] ?? 0)) -
          ((p[b + 1] ?? 0) - (p[a + 1] ?? 0)) * ((p[c] ?? 0) - (p[a] ?? 0)),
      ) / 2;
  }
  return sum;
}

describe('static interchange through canonical MeshAsset', () => {
  it('imports negative OBJ indices, UVs and supplied normals', () => {
    const rows = parseObj(OBJECT).unwrap();
    expect(rows[0]?.name).toBe('Triangle');
    expect(Array.from(positions(required(rows[0]).mesh))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(rows[0]?.mesh.attributes.uv).toEqual(new Float32Array([0, 0, 1, 0, 0, 1]));
    expect(rows[0]?.mesh.indices?.length).toBe(3);
  });
  it('triangulates OBJ polygons and preserves multiple objects/material groups', () => {
    const rows = parseObj(
      'o Quad\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nusemtl Red\nf 1 2 3 4\nusemtl Blue\nf 1 3 4\no Other\nf 1 2 4',
    ).unwrap();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.mesh.submeshes).toHaveLength(2);
    expect(rows[0]?.mesh.indices).toHaveLength(9);
  });
  it.each([
    '',
    'v 0 0 0\nf 1 2 3',
    'v NaN 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3',
  ])('rejects invalid OBJ without a partial mesh (%s)', (source) =>
    expect(parseObj(source).ok).toBe(false));
  it('imports ASCII STL and rejects truncated binary STL', () => {
    const source =
      'solid mesh\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid mesh';
    expect(parseStl(new TextEncoder().encode(source)).unwrap()[0]?.mesh.indices).toHaveLength(3);
    const malformed = new Uint8Array(85);
    new DataView(malformed.buffer).setUint32(80, 5, true);
    expect(parseStl(malformed).ok).toBe(false);
  });
  it('publishes finite orthogonal tangents and explicit zero UVs for UV-less formats', () => {
    const mesh = firstMesh(parseObj('o Triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3'));
    expect(mesh.attributes.uv).toEqual(new Float32Array(6));
    const normals = mesh.attributes.normal as Float32Array;
    const tangents = mesh.attributes.tangent as Float32Array;
    for (let i = 0; i < 3; i++) {
      expect(Math.hypot(...tangents.subarray(i * 4, i * 4 + 3))).toBeCloseTo(1);
      expect(
        required(normals[i * 3]) * required(tangents[i * 4]) +
          required(normals[i * 3 + 1]) * required(tangents[i * 4 + 1]) +
          required(normals[i * 3 + 2]) * required(tangents[i * 4 + 2]),
      ).toBeCloseTo(0);
    }
  });
  it('retains 32-bit index cardinality across a 75,000-vertex OBJ → GLB roundtrip', async () => {
    const mesh = firstMesh(
      parseObj(`o Large\nv 0 0 0\nv 1 0 0\nv 0 1 0\n${'f 1 2 3\n'.repeat(25_000)}`),
    );
    expect(mesh.indices).toBeInstanceOf(Uint32Array);
    const bytes = (await exportMeshes([{ name: 'Large', mesh }], 'glb')).unwrap();
    const validation = await validateBytes(bytes, { uri: 'Large.glb' });
    expect(validation.issues.numErrors).toBe(0);
    const reimported = meshIrToMeshAsset(
      (await parseGlb(bytes.slice().buffer, 'Large.glb')).unwrap().meshes,
    ).unwrap();
    expect(reimported.indices).toBeInstanceOf(Uint32Array);
    expect(reimported.indices?.at(-1)).toBe(74_999);
  });
  it.each([
    'obj',
    'stl',
  ] as const)('preserves outward winding when %s bakes a mirrored placement', async (format) => {
    const source = box();
    const before = source.indices?.slice();
    const bytes = (
      await exportMeshes(
        [{ name: 'Box', mesh: source, matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
        format,
      )
    ).unwrap();
    const mesh = firstMesh(
      format === 'obj' ? parseObj(new TextDecoder().decode(bytes)) : parseStl(bytes),
    );
    const p = positions(mesh),
      n = mesh.attributes.normal as Float32Array,
      indices = required(mesh.indices);
    for (let i = 0; i < indices.length; i += 3) {
      const a = required(indices[i]) * 3,
        b = required(indices[i + 1]) * 3,
        c = required(indices[i + 2]) * 3;
      const u = [
        required(p[b]) - required(p[a]),
        required(p[b + 1]) - required(p[a + 1]),
        required(p[b + 2]) - required(p[a + 2]),
      ];
      const v = [
        required(p[c]) - required(p[a]),
        required(p[c + 1]) - required(p[a + 1]),
        required(p[c + 2]) - required(p[a + 2]),
      ];
      expect(
        (required(u[1]) * required(v[2]) - required(u[2]) * required(v[1])) * required(n[a]) +
          (required(u[2]) * required(v[0]) - required(u[0]) * required(v[2])) * required(n[a + 1]) +
          (required(u[0]) * required(v[1]) - required(u[1]) * required(v[0])) * required(n[a + 2]),
      ).toBeGreaterThan(0);
    }
    expect(source.indices).toEqual(before);
  });
  it.each([
    'obj',
    'stl',
    'gltf',
    'glb',
  ] as const)('roundtrips %s; validates glTF with Khronos validator', async (format) => {
    const source = box();
    const before = source.vertices.slice();
    const exported = (
      await exportMeshes(
        [
          {
            name: 'Box',
            mesh: source,
            ...(format === 'gltf' || format === 'glb'
              ? { materials: [{ color: [0.2, 0.4, 0.6] as const, metallic: 0.3, roughness: 0.7 }] }
              : {}),
          },
        ],
        format,
      )
    ).unwrap();
    let mesh: MeshAsset;
    if (format === 'obj') mesh = firstMesh(parseObj(new TextDecoder().decode(exported)));
    else if (format === 'stl') mesh = firstMesh(parseStl(exported));
    else {
      const validation = await validateBytes(exported, { uri: `Box.${format}` });
      expect(validation.issues.numErrors, JSON.stringify(validation.issues.messages)).toBe(0);
      const result =
        format === 'glb'
          ? await parseGlb(exported.slice().buffer, 'Box.glb')
          : await parseGltf(
              JSON.parse(new TextDecoder().decode(exported)),
              async () => {
                throw new Error('self-contained export');
              },
              'Box.gltf',
            );
      const doc = result.unwrap();
      expect(doc.materials[0]?.metallicFactor).toBeCloseTo(0.3);
      mesh = meshIrToMeshAsset(doc.meshes).unwrap();
    }
    expect(mesh.aabb).toEqual(source.aabb);
    expect(mesh.indices?.length).toBe(source.indices?.length);
    expect(source.vertices).toEqual(before);
  });
  it('exports world placements to OBJ/STL without altering the input', async () => {
    const matrix = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 10, 20, 30, 1];
    for (const format of ['obj', 'stl'] as const) {
      const bytes = (await exportMeshes([{ name: 'Box', mesh: box(), matrix }], format)).unwrap();
      const mesh = firstMesh(
        format === 'obj' ? parseObj(new TextDecoder().decode(bytes)) : parseStl(bytes),
      );
      expect(Array.from(required(mesh.aabb))).toEqual([9, 18.5, 28, 11, 21.5, 32]);
    }
  });
  it('rejects an invalid export before producing bytes', async () => {
    expect((await exportMeshes([], 'glb')).ok).toBe(false);
    expect((await exportMeshes([{ name: 'Box', mesh: box(), matrix: [NaN] }], 'obj')).ok).toBe(
      false,
    );
    expect(
      (await exportMeshes([{ name: 'Box', mesh: { ...box(), morphTargets: [] } }], 'obj')).ok,
    ).toBe(false);
    expect(
      (await exportMeshes([{ name: 'Box', mesh: box(), materials: [{ roughness: NaN }] }], 'glb'))
        .ok,
    ).toBe(false);
  });
  it('imports an evenodd SVG hole with exact polygon area and transform', async () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg"><path id="Ring" fill="#ff0000" fill-rule="evenodd" transform="translate(2 3)" d="M0 0H10V10H0Z M3 3H7V7H3Z"/></svg>';
    const rows = (await parseSvg(source)).unwrap();
    expect(rows).toHaveLength(1);
    expect(area(required(rows[0]).mesh)).toBeCloseTo(84);
    expect(Array.from(required(required(rows[0]).mesh.aabb))).toEqual([2, 3, 0, 12, 13, 0]);
    expect((rows[0]?.mesh.attributes.color as Float32Array)?.slice(0, 4)).toEqual(
      new Float32Array([1, 0, 0, 1]),
    );
  });
  it('imports SVG curves/arcs and stroke geometry in an isolated worker', async () => {
    const before = globalThis.DOMParser;
    const rows = (
      await parseSvg(
        '<svg><path fill="none" stroke="#00ff00" stroke-width="2" d="M0 0 Q10 20 20 0 A10 10 0 0 1 40 0"/></svg>',
        16,
      )
    ).unwrap();
    expect(rows[0]?.mesh.indices?.length).toBeGreaterThan(30);
    expect(globalThis.DOMParser).toBe(before);
  });
  it.each([
    '<svg><image href="https://invalid"/></svg>',
    '<svg><path fill="url(#g)"/></svg>',
    '<html/>',
    '<svg/>',
  ])('fails explicitly for unsupported or empty SVG', async (source) =>
    expect((await parseSvg(source)).ok).toBe(false));
  it('preserves GUIDs when OBJ objects reorder, and cooks mesh-bin v5', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-mesh-io-'));
    try {
      const path = join(root, 'mesh.obj');
      await writeFile(path, `${OBJECT}o Other\nf 1 2 3\n`);
      const first = (await importMeshFile(path)).unwrap();
      await writeFile(path, `${OBJECT.replace('o Triangle', 'o Other')}o Triangle\nf 1 2 3\n`);
      const second = (await importMeshFile(path)).unwrap();
      expect(second.subAssets.find((entry) => entry.sourceKey === 'mesh:Triangle')?.guid).toBe(
        first.subAssets.find((entry) => entry.sourceKey === 'mesh:Triangle')?.guid,
      );
      const ctx = {
        source: 'mesh.obj',
        readSource: async () => ({ ok: true, value: await readFile(path) }),
        subAssets: second.subAssets,
        importSettings: {},
        readSibling: async () => {
          throw new Error('no siblings');
        },
        decodeImage: async () => {
          throw new Error('no images');
        },
      } satisfies ImportContext;
      const imported = await objImporter.import(ctx);
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      expect(imported.value.assets.map((asset) => asset.guid)).toEqual(
        second.subAssets.map((asset) => asset.guid),
      );
      expect(
        imported.value.assets.every((asset) => (asset.artifacts.body?.bytes?.length ?? 0) > 0),
      ).toBe(true);
      const staleIndex = await objImporter.import({ ...ctx, subAssets: first.subAssets });
      expect(staleIndex.ok).toBe(true);
      if (!staleIndex.ok) return;
      expect(
        staleIndex.value.assets.map((asset) => ({ guid: asset.guid, name: asset.name })),
      ).toEqual(
        first.subAssets.map((asset) => ({
          guid: asset.guid,
          name: asset.sourceKey === 'mesh:Triangle' ? 'Triangle' : 'Other',
        })),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('retains the deterministic plane direction with default handedness when OBJ has no UVs', () => {
  const mesh = firstMesh(
    parseObj('o Triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvn 2 -3 4\nf 1//1 2//1 3//1'),
  );
  const tangent = mesh.attributes.tangent;
  expect(tangent).toBeInstanceOf(Float32Array);
  if (!(tangent instanceof Float32Array)) throw new Error('expected tangent attribute');
  for (let i = 0; i < 3; i++) {
    expect(Array.from(tangent.subarray(i * 4, i * 4 + 4))).toEqual(
      Array.from(new Float32Array([0, -0.8, -0.6, 1])),
    );
  }
});
