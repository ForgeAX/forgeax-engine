import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildKernelMeshSections,
  createKernelMeshBuilder,
  decodeTangentFrame32Rust,
  encodeTangentFrame32Rust,
  initModelingKernelWasmSync,
  liveRustBuilderCount,
  modelingKernelWasmUrl,
  type OutputMode,
  type RawMeshData,
} from '../index';

const __dirname = dirname(fileURLToPath(import.meta.url));

function expectFloatArraysClose(a: Float32Array, b: Float32Array, tol = 1e-5): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    const diff = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (diff > tol) {
      throw new Error(`Float mismatch at [${i}]: rust=${a[i]} ts=${b[i]} diff=${diff}`);
    }
  }
}

function expectIndicesParity(rustMesh: RawMeshData, tsMesh: RawMeshData): void {
  if (rustMesh.indices === undefined) {
    expect(tsMesh.indices).toBeUndefined();
    return;
  }
  const tsIndices = tsMesh.indices;
  expect(tsIndices).toBeDefined();
  if (tsIndices === undefined) return;
  expect(rustMesh.indices.constructor).toBe(tsIndices.constructor);
  expect(Array.from(rustMesh.indices)).toEqual(Array.from(tsIndices));
}

function expectChannelsParity(rustMesh: RawMeshData, tsMesh: RawMeshData, tol: number): void {
  if (rustMesh.channels === undefined) {
    expect(tsMesh.channels).toBeUndefined();
    return;
  }
  const tsChannels = tsMesh.channels;
  expect(tsChannels).toBeDefined();
  if (tsChannels === undefined) return;
  expect(Object.keys(rustMesh.channels)).toEqual(Object.keys(tsChannels));
  for (const decl of rustMesh.layout) {
    const rArr = rustMesh.channels[decl.key];
    const tArr = tsChannels[decl.key];
    expect(rArr).toBeDefined();
    expect(tArr).toBeDefined();
    if (rArr === undefined || tArr === undefined) continue;
    expect(rArr.constructor).toBe(tArr.constructor);
    if (rArr instanceof Float32Array && tArr instanceof Float32Array) {
      expectFloatArraysClose(rArr, tArr, tol);
    } else {
      expect(Array.from(rArr)).toEqual(Array.from(tArr));
    }
  }
}

function compareInterleavedDecl(
  rView: DataView,
  tView: DataView,
  rBytes: Uint8Array,
  tBytes: Uint8Array,
  v: number,
  base: number,
  decl: RawMeshData['layout'][number],
  tol: number,
): number {
  if (decl.format === 'float32x2' || decl.format === 'float32x3' || decl.format === 'float32x4') {
    const count = decl.format === 'float32x2' ? 2 : decl.format === 'float32x3' ? 3 : 4;
    for (let c = 0; c < count; c++) {
      const rv = rView.getFloat32(base + c * 4, true);
      const tv = tView.getFloat32(base + c * 4, true);
      if (Math.abs(rv - tv) > tol) {
        throw new Error(
          `Interleaved float mismatch at v=${v} ${decl.key}[${c}]: rust=${rv} ts=${tv}`,
        );
      }
    }
    return count * 4;
  }
  const blen = decl.format === 'uint32' || decl.format === 'unorm8x4' ? 4 : 8;
  for (let b = 0; b < blen; b++) {
    if (rBytes[base + b] !== tBytes[base + b]) {
      throw new Error(`Interleaved byte mismatch at v=${v} ${decl.key}+${b}`);
    }
  }
  return blen;
}

function expectInterleavedParity(rustMesh: RawMeshData, tsMesh: RawMeshData, tol: number): void {
  if (rustMesh.interleaved === undefined) {
    expect(tsMesh.interleaved).toBeUndefined();
    return;
  }
  const tsInterleaved = tsMesh.interleaved;
  expect(tsInterleaved).toBeDefined();
  if (tsInterleaved === undefined) return;
  expect(rustMesh.interleaved.byteLength).toBe(tsInterleaved.byteLength);
  const rBytes = new Uint8Array(
    rustMesh.interleaved.buffer,
    rustMesh.interleaved.byteOffset,
    rustMesh.interleaved.byteLength,
  );
  const tBytes = new Uint8Array(
    tsInterleaved.buffer,
    tsInterleaved.byteOffset,
    tsInterleaved.byteLength,
  );
  const rView = new DataView(rBytes.buffer, rBytes.byteOffset, rBytes.byteLength);
  const tView = new DataView(tBytes.buffer, tBytes.byteOffset, tBytes.byteLength);
  const stride = rustMesh.arrayStride;
  for (let v = 0; v < rustMesh.vertexCount; v++) {
    let off = 0;
    for (const decl of rustMesh.layout) {
      off += compareInterleavedDecl(rView, tView, rBytes, tBytes, v, v * stride + off, decl, tol);
    }
  }
}

function expectRawMeshParity(rustMesh: RawMeshData, tsMesh: RawMeshData, tol = 1e-5): void {
  expect(rustMesh.backend).toBe('rust');
  expect(tsMesh.backend).toBe('ts');
  expect(rustMesh.outputMode).toBe(tsMesh.outputMode);
  expect(rustMesh.vertexCount).toBe(tsMesh.vertexCount);
  expect(rustMesh.arrayStride).toBe(tsMesh.arrayStride);
  expect(rustMesh.layoutMask).toBe(tsMesh.layoutMask);
  expect(rustMesh.layout).toEqual(tsMesh.layout);
  expect(rustMesh.submeshes).toEqual(tsMesh.submeshes);
  expect(rustMesh.materialSlotNames).toEqual(tsMesh.materialSlotNames);
  expectFloatArraysClose(rustMesh.aabb, tsMesh.aabb, 1e-6);
  expectIndicesParity(rustMesh, tsMesh);
  expectChannelsParity(rustMesh, tsMesh, tol);
  expectInterleavedParity(rustMesh, tsMesh, tol);
}

beforeAll(() => {
  const bytes = readFileSync(modelingKernelWasmUrl());
  initModelingKernelWasmSync(bytes);
});

describe('@forgeax/modeling-kernel Rust vs TS parity and lifecycle', () => {
  it('enforces zero engine and zero three dependencies in package.json', () => {
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
    expect(deps).not.toContain('three');
  });

  it('matches Rust and TS staging output across all 3 outputModes with multi-batch growth', () => {
    const modes: readonly OutputMode[] = ['separate', 'interleaved', 'interleaved-with-channels'];
    for (const outputMode of modes) {
      const run = (backend: 'rust' | 'ts') => {
        const builder = createKernelMeshBuilder({
          layout: ['position', 'uv', 'color'],
          vertexCapacity: 4,
          indexCapacity: 6,
          backend,
        }).unwrap();

        // Write 256 quads in small batches to exercise repeated staging buffer / WASM memory growth.
        for (let q = 0; q < 256; q++) {
          const v = builder.allocateVertices(4).unwrap();
          const pos = v.channels.position as Float32Array;
          const uv = v.channels.uv as Float32Array;
          const col = v.channels.color as Float32Array;
          const ox = (q % 16) * 2;
          const oy = Math.floor(q / 16) * 2;
          pos.set([ox, oy, 0, ox + 1, oy, 0, ox + 1, oy + 1, 0, ox, oy + 1, 0]);
          uv.set([0, 0, 1, 0, 1, 1, 0, 1]);
          col.set([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1]);
          const idx = builder.allocateIndices(6).unwrap();
          const b = v.baseVertex;
          idx.indices.set([b, b + 1, b + 2, b, b + 2, b + 3]);
        }

        const built = builder.build({ outputMode, dispose: true }).unwrap();
        expect(builder.disposed).toBe(true);
        return built;
      };

      const rustMesh = run('rust');
      const tsMesh = run('ts');
      expectRawMeshParity(rustMesh, tsMesh);
      if (outputMode === 'separate') {
        expect(rustMesh.interleaved).toBeUndefined();
        expect(rustMesh.channels).toBeDefined();
      } else if (outputMode === 'interleaved') {
        expect(rustMesh.interleaved).toBeDefined();
        expect(rustMesh.channels).toBeUndefined();
      } else {
        expect(rustMesh.interleaved).toBeDefined();
        expect(rustMesh.channels).toBeDefined();
      }
    }
    expect(liveRustBuilderCount()).toBe(0);
  });

  it('matches Rust and TS on skinning (uint16x4 + unorm8x4/unorm16x4), strips, and line-only meshes', () => {
    const buildSkinned = (backend: 'rust' | 'ts', weightFmt: 'unorm8x4' | 'unorm16x4') => {
      const b = createKernelMeshBuilder({
        layout: [
          'position',
          'normal',
          'uv',
          { key: 'skinIndex', format: 'uint16x4' },
          { key: 'skinWeight', format: weightFmt },
        ],
        backend,
      }).unwrap();
      const v = b.allocateVertices(4).unwrap();
      (v.channels.position as Float32Array).set([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
      (v.channels.normal as Float32Array).set([0, 0, 5, 0, 0, 5, 0, 0, 0, 0, 0, 5]);
      (v.channels.uv as Float32Array).set([0, 0, 1, 0, 1, 1, 0, 1]);
      (v.channels.skinIndex as Uint16Array).set([0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6]);
      if (weightFmt === 'unorm8x4') {
        (v.channels.skinWeight as Uint8Array).set([
          255, 0, 0, 0, 128, 127, 0, 0, 64, 64, 64, 63, 255, 0, 0, 0,
        ]);
      } else {
        (v.channels.skinWeight as Uint16Array).set([
          65535, 0, 0, 0, 32768, 32767, 0, 0, 16384, 16384, 16384, 16383, 65535, 0, 0, 0,
        ]);
      }
      const idx = b.allocateIndices(4).unwrap();
      idx.indices.set([0, 1, 3, 2]);
      b.addSubmesh({
        indexOffset: 0,
        indexCount: 4,
        topology: 'triangle-strip',
        materialSlot: 0,
      }).unwrap();
      return b.build({ outputMode: 'interleaved-with-channels', dispose: true }).unwrap();
    };

    expectRawMeshParity(buildSkinned('rust', 'unorm8x4'), buildSkinned('ts', 'unorm8x4'));
    expectRawMeshParity(buildSkinned('rust', 'unorm16x4'), buildSkinned('ts', 'unorm16x4'));

    const buildLines = (backend: 'rust' | 'ts') => {
      const b = createKernelMeshBuilder({ layout: ['position'], backend }).unwrap();
      const v = b.allocateVertices(3).unwrap();
      (v.channels.position as Float32Array).set([0, 0, 0, 1, 2, 3, -1, 0, 4]);
      const idx = b.allocateIndices(2).unwrap();
      idx.indices.set([0, 2]);
      b.addSubmesh({ topology: 'line-list' }).unwrap();
      return b.build({ outputMode: 'interleaved-with-channels', dispose: true }).unwrap();
    };

    const rLines = buildLines('rust');
    const tLines = buildLines('ts');
    expectRawMeshParity(rLines, tLines);
    expect(rLines.layout.map((d) => d.key)).toEqual(['position']);
    expect(liveRustBuilderCount()).toBe(0);
  });

  it('matches Rust and TS on buildKernelMeshSections with reserved slots and Uint32 widening', () => {
    const posA = new Float32Array([-1, -2, -3, 4, 5, 6, 0, 2, 1]);
    const posB = new Float32Array([8, 0, 0, 9, 0, 0, 8, 1, 0]);
    const runSections = (backend: 'rust' | 'ts') =>
      buildKernelMeshSections(
        {
          materialSlotNames: ['wall', 'unused', 'trim'],
          sections: [
            { materialSlot: 0, attributes: { position: posA }, indices: [0, 1, 2] },
            { materialSlot: 1 },
            { materialSlot: 2, attributes: { position: posB }, indices: Uint16Array.of(0, 1, 2) },
          ],
          backend,
        },
        { outputMode: 'interleaved-with-channels' },
      ).unwrap();

    expectRawMeshParity(runSections('rust'), runSections('ts'));

    // Widening past 65_535
    const bigPos = new Float32Array(65_534 * 3);
    const runWide = (backend: 'rust' | 'ts') =>
      buildKernelMeshSections(
        {
          sections: [
            { materialSlot: 0, attributes: { position: bigPos }, indices: [0, 1, 2] },
            { materialSlot: 0, attributes: { position: posA }, indices: Uint16Array.of(0, 1, 2) },
          ],
          backend,
        },
        { outputMode: 'interleaved' },
      ).unwrap();

    const rWide = runWide('rust');
    const tWide = runWide('ts');
    expect(rWide.indices).toEqual(Uint32Array.of(0, 1, 2, 65_534, 65_535, 65_536));
    expectRawMeshParity(rWide, tWide);

    // Out-of-range section-local index rejected by both backends
    for (const backend of ['rust', 'ts'] as const) {
      const bad = buildKernelMeshSections({
        sections: [
          { materialSlot: 0, attributes: { position: posA }, indices: [0, 1, 2] },
          { materialSlot: 0, attributes: { position: posA }, indices: [0, 1, 3] },
        ],
        backend,
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.field).toBe('sections[1].indices[2]');
    }
    expect(liveRustBuilderCount()).toBe(0);
  });

  it('enforces identical error handling and arena lifecycle guarantees across Rust and TS', () => {
    for (const backend of ['rust', 'ts'] as const) {
      // NaN position rejected
      const b1 = createKernelMeshBuilder({ layout: ['position'], backend }).unwrap();
      const v1 = b1.allocateVertices(3).unwrap();
      (v1.channels.position as Float32Array).set([0, Number.NaN, 0, 1, 0, 0, 0, 1, 0]);
      const r1 = b1.build();
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error.field).toBe('position');
      b1.dispose();

      // Strip topology without index buffer rejected
      const b2 = createKernelMeshBuilder({ layout: ['position'], backend }).unwrap();
      b2.allocateVertices(3).unwrap();
      b2.addSubmesh({ topology: 'triangle-strip' }).unwrap();
      const r2 = b2.build();
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error.field).toBe('submeshes[0].topology');
      b2.dispose();

      // Disposed handle fails closed
      const stale = b2.allocateVertices(1);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe('kernel-invalid-handle');
    }
    expect(liveRustBuilderCount()).toBe(0);
  });

  it('round-trips encodeTangentFrame32Rust / decodeTangentFrame32Rust accurately', () => {
    const cases: readonly [number, number, number, number, number, number, number][] = [
      [0, 0, 1, 1, 0, 0, 1],
      [0, 1, 0, 0, 0, -1, -1],
      [0.57735027, 0.57735027, 0.57735027, -Math.SQRT1_2, Math.SQRT1_2, 0, 1],
    ];
    for (const [nx, ny, nz, tx, ty, tz, sign] of cases) {
      const word = encodeTangentFrame32Rust(nx, ny, nz, tx, ty, tz, sign).unwrap();
      const decoded = decodeTangentFrame32Rust(word).unwrap();
      const nDot = (decoded[0] ?? 0) * nx + (decoded[1] ?? 0) * ny + (decoded[2] ?? 0) * nz;
      const tDot = (decoded[3] ?? 0) * tx + (decoded[4] ?? 0) * ty + (decoded[5] ?? 0) * tz;
      expect(nDot).toBeGreaterThan(0.9999);
      expect(tDot).toBeGreaterThan(0.9995);
      expect(decoded[6]).toBe(sign);
    }
  });
});
