import { readFileSync } from 'node:fs';
import {
  encodeTangentFrame32Rust,
  initModelingKernelWasmSync,
  liveRustBuilderCount,
  modelingKernelWasmUrl,
} from '@forgeax/modeling-kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMeshBuilder, createStagingMeshBuilder } from '../mesh-builder';
import { invalidMeshAttributeDeclaration, meshAttributeWindow } from '../mesh-storage';
import { encodeTangentFrame32 } from '../tangent-frame32';
import { deriveVertexLayoutProjection } from '../vertex-attribute-layout';

beforeAll(() => {
  initModelingKernelWasmSync(readFileSync(modelingKernelWasmUrl()));
});

describe('Ring 1 @forgeax/engine-geometry <-> @forgeax/modeling-kernel integration', () => {
  it('matches Rust and TS backends on createMeshBuilder (channels and interleaved storage)', () => {
    const position = new Float32Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0]);
    const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const indices = [0, 1, 2, 0, 2, 3];

    for (const attributeStorage of [undefined, 'interleaved'] as const) {
      const rustMesh = createMeshBuilder({
        attributes: { position, uv },
        indices,
        backend: 'rust',
        ...(attributeStorage === undefined ? {} : { attributeStorage }),
      })
        .build()
        .unwrap();
      const tsMesh = createMeshBuilder({
        attributes: { position, uv },
        indices,
        backend: 'ts',
        ...(attributeStorage === undefined ? {} : { attributeStorage }),
      })
        .build()
        .unwrap();

      expect(rustMesh.vertices).toEqual(tsMesh.vertices);
      expect(rustMesh.indices).toEqual(tsMesh.indices);
      expect(rustMesh.aabb).toEqual(tsMesh.aabb);
      expect(rustMesh.submeshes).toEqual(tsMesh.submeshes);
      expect(rustMesh.attributeStorage).toBe(attributeStorage);

      if (attributeStorage === 'interleaved') {
        const layout = deriveVertexLayoutProjection(rustMesh.attributes);
        expect(invalidMeshAttributeDeclaration(rustMesh.attributes, layout)).toBeUndefined();
        expect(meshAttributeWindow(rustMesh, 'position')?.count).toBe(4);
        expect(meshAttributeWindow(rustMesh, 'tangent')?.count).toBe(4);
      } else {
        expect(rustMesh.attributes.normal).toEqual(tsMesh.attributes.normal);
        expect(rustMesh.attributes.tangent).toEqual(tsMesh.attributes.tangent);
      }
    }
    expect(liveRustBuilderCount()).toBe(0);
  });

  it('builds MeshAsset directly via zero-copy createStagingMeshBuilder', () => {
    const builder = createStagingMeshBuilder({
      layout: ['position', 'uv'],
      materialSlots: [{ slotName: 'Surface' }],
      vertexCapacity: 4,
      indexCapacity: 6,
      backend: 'rust',
    }).unwrap();
    expect(builder.backend).toBe('rust');
    expect(liveRustBuilderCount()).toBe(1);

    const v = builder.allocateVertices(4).unwrap();
    (v.channels.position as Float32Array).set([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    (v.channels.uv as Float32Array).set([0, 0, 1, 0, 1, 1, 0, 1]);
    const idx = builder.allocateIndices(6).unwrap();
    idx.indices.set([0, 1, 2, 0, 2, 3]);

    const mesh = builder.build({ attributeStorage: 'interleaved', dispose: true }).unwrap();
    expect(builder.disposed).toBe(true);
    expect(liveRustBuilderCount()).toBe(0);
    expect(mesh.attributeStorage).toBe('interleaved');
    expect(mesh.vertices.byteLength).toBe(4 * 48);
    expect(mesh.indices).toEqual(Uint16Array.of(0, 1, 2, 0, 2, 3));
    expect(mesh.aabb).toEqual(Float32Array.of(0, 0, 0, 1, 1, 0));
    const layout = deriveVertexLayoutProjection(mesh.attributes);
    expect(invalidMeshAttributeDeclaration(mesh.attributes, layout)).toBeUndefined();
  });

  it('matches encodeTangentFrame32 bit-exactly between TS and Rust WASM', () => {
    const samples: readonly [number, number, number, number, number, number, number][] = [
      [0, 0, 1, 1, 0, 0, 1],
      [0, 0, -1, 0, 1, 0, -1],
      [0, 1, 0, 0, 0, -1, 1],
      [1, 0, 0, 0, 1, 0, -1],
      [0.57735027, 0.57735027, 0.57735027, -Math.SQRT1_2, Math.SQRT1_2, 0, 1],
      [-0.26726124, 0.53452248, -0.80178373, 0.89442719, 0.4472136, 0, -1],
    ];
    for (const [nx, ny, nz, tx, ty, tz, sign] of samples) {
      const tsWord = encodeTangentFrame32(nx, ny, nz, tx, ty, tz, sign);
      const rustWord = encodeTangentFrame32Rust(nx, ny, nz, tx, ty, tz, sign).unwrap();
      expect(rustWord).toBe(tsWord);
    }
  });
});
