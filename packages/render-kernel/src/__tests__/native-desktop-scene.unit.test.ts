// Verifies DesktopNativeSceneRenderer on the dedicated native Rust wgpu 30 OS render thread:
//   1. Multi-light shading (Directional + Point + Spot) + directional shadow occlusion
//   2. Alpha-blended transparent queue over opaque geometry
//   3. Incremental dirty-row transform diffing, dynamic material parameter edits, and entity despawn
//   4. 60+ async pipelined continuous-partial-change frames with bounded dirty uploads

import { describe, expect, it } from 'vitest';
import {
  createDesktopNativeSceneRenderer,
  type DesktopRenderObjectInput,
  desktopMat4LookAt,
  desktopMat4Multiply,
  desktopMat4Perspective,
  isNativeRenderKernelAvailable,
  packDesktopMeshVertices,
  packDesktopSkinnedMeshVertices,
} from '../desktop/index.js';

function makeUnitCube(): { readonly vertices: Float32Array; readonly indices: Uint16Array } {
  const faces = [
    {
      n: [0, 0, 1],
      v: [
        [-0.5, -0.5, 0.5],
        [0.5, -0.5, 0.5],
        [0.5, 0.5, 0.5],
        [-0.5, 0.5, 0.5],
      ],
    },
    {
      n: [0, 0, -1],
      v: [
        [0.5, -0.5, -0.5],
        [-0.5, -0.5, -0.5],
        [-0.5, 0.5, -0.5],
        [0.5, 0.5, -0.5],
      ],
    },
    {
      n: [1, 0, 0],
      v: [
        [0.5, -0.5, 0.5],
        [0.5, -0.5, -0.5],
        [0.5, 0.5, -0.5],
        [0.5, 0.5, 0.5],
      ],
    },
    {
      n: [-1, 0, 0],
      v: [
        [-0.5, -0.5, -0.5],
        [-0.5, -0.5, 0.5],
        [-0.5, 0.5, 0.5],
        [-0.5, 0.5, -0.5],
      ],
    },
    {
      n: [0, 1, 0],
      v: [
        [-0.5, 0.5, 0.5],
        [0.5, 0.5, 0.5],
        [0.5, 0.5, -0.5],
        [-0.5, 0.5, -0.5],
      ],
    },
    {
      n: [0, -1, 0],
      v: [
        [-0.5, -0.5, -0.5],
        [0.5, -0.5, -0.5],
        [0.5, -0.5, 0.5],
        [-0.5, -0.5, 0.5],
      ],
    },
  ];
  const uvs: readonly (readonly [number, number])[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const pos = new Float32Array(24 * 3);
  const nrm = new Float32Array(24 * 3);
  const uv = new Float32Array(24 * 2);
  const indices = new Uint16Array(36);
  let vi = 0;
  let ii = 0;
  for (let f = 0; f < 6; f++) {
    const face = faces[f];
    if (face === undefined) continue;
    const base = f * 4;
    for (let i = 0; i < 4; i++) {
      const vtx = face.v[i];
      const uvPt = uvs[i];
      if (vtx === undefined || uvPt === undefined) continue;
      pos[vi * 3 + 0] = vtx[0] ?? 0;
      pos[vi * 3 + 1] = vtx[1] ?? 0;
      pos[vi * 3 + 2] = vtx[2] ?? 0;
      nrm[vi * 3 + 0] = face.n[0] ?? 0;
      nrm[vi * 3 + 1] = face.n[1] ?? 0;
      nrm[vi * 3 + 2] = face.n[2] ?? 0;
      uv[vi * 2 + 0] = uvPt[0];
      uv[vi * 2 + 1] = uvPt[1];
      vi++;
    }
    indices[ii++] = base;
    indices[ii++] = base + 1;
    indices[ii++] = base + 2;
    indices[ii++] = base;
    indices[ii++] = base + 2;
    indices[ii++] = base + 3;
  }
  const packed = packDesktopMeshVertices(pos, nrm, uv);
  return { vertices: packed.vertices, indices };
}

function makeTrs(
  tx: number,
  ty: number,
  tz: number,
  sx: number,
  sy: number,
  sz: number,
  rotY = 0,
): Float32Array {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return new Float32Array([
    c * sx,
    0,
    -s * sx,
    0,
    0,
    sy,
    0,
    0,
    s * sz,
    0,
    c * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]);
}

function samplePixel(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
): readonly [number, number, number] {
  const idx = (y * width + x) * 4;
  return [pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0];
}

describe.skipIf(!isNativeRenderKernelAvailable())(
  'DesktopNativeSceneRenderer (native Rust wgpu 30 OS render thread)',
  () => {
    it('renders multi-light shadowed + transparent 3D scene and tracks incremental partial edits', () => {
      const renderer = createDesktopNativeSceneRenderer({
        headless: true,
        shadowMapSize: 512,
      }).unwrap();

      try {
        const cube = makeUnitCube();
        renderer
          .ensureMesh({ key: 'cube', vertices: cube.vertices, indices: cube.indices })
          .unwrap();

        // Checkerboard albedo texture
        const texBytes = new Uint8Array(32 * 32 * 4);
        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 32; x++) {
            const bright = ((x >> 2) + (y >> 2)) % 2 === 0;
            const o = (y * 32 + x) * 4;
            texBytes[o] = bright ? 240 : 180;
            texBytes[o + 1] = bright ? 240 : 180;
            texBytes[o + 2] = bright ? 240 : 180;
            texBytes[o + 3] = 255;
          }
        }
        renderer
          .ensureTexture({ key: 'checker', width: 32, height: 32, rgbaBytes: texBytes })
          .unwrap();

        renderer
          .ensureMaterial({
            key: 'ground',
            baseColor: [0.88, 0.9, 0.92, 1],
            roughness: 0.85,
            metallic: 0.0,
            baseColorTextureKey: 'checker',
          })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'caster',
            baseColor: [0.95, 0.35, 0.25, 1],
            roughness: 0.35,
            metallic: 0.15,
          })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'glass',
            baseColor: [0.15, 0.65, 1.0, 0.45],
            roughness: 0.1,
            metallic: 0.0,
            transparent: true,
            queue: 3000,
          })
          .unwrap();

        // Top-down camera so ground fills center; shadow caster hovers directly above center
        const camPos: readonly [number, number, number] = [0, 10, 6];
        const vp = desktopMat4Multiply(
          desktopMat4Perspective(Math.PI / 4, 16 / 9, 0.1, 100, new Float32Array(16)),
          desktopMat4LookAt(camPos, [0, 0, 0], [0, 1, 0], new Float32Array(16)),
          new Float32Array(16),
        );

        const lights = [
          {
            id: 1,
            kind: 'directional' as const,
            direction: [0, -1, 0] as const,
            color: [1.0, 0.98, 0.95] as const,
            intensity: 3.0,
            castShadow: true,
            shadowDistance: 12,
          },
          {
            id: 2,
            kind: 'point' as const,
            position: [3.2, 1.5, 0] as const,
            color: [0.2, 0.5, 1.0] as const,
            intensity: 14.0,
            range: 12,
          },
          {
            id: 3,
            kind: 'spot' as const,
            position: [-3.2, 3.0, 0] as const,
            direction: [0, -1, 0] as const,
            color: [1.0, 0.8, 0.2] as const,
            intensity: 18.0,
            range: 12,
            outerConeCos: Math.cos(Math.PI / 5),
          },
        ];

        const baseObjects: DesktopRenderObjectInput[] = [
          {
            entityId: 1,
            meshKey: 'cube',
            materialKey: 'ground',
            worldMatrix: makeTrs(0, -0.5, 0, 20, 1, 20),
            castShadow: false,
          },
          {
            entityId: 2,
            meshKey: 'cube',
            materialKey: 'caster',
            worldMatrix: makeTrs(0, 1.8, 0, 1.8, 0.6, 1.8),
            castShadow: true,
          },
          {
            entityId: 3,
            meshKey: 'cube',
            materialKey: 'glass',
            worldMatrix: makeTrs(0, 2.8, 2.2, 1.6, 1.2, 0.2),
            castShadow: false,
            queue: 3000,
          },
        ];

        const w1 = renderer
          .renderWitnessFrame({
            width: 320,
            height: 180,
            camera: { viewProj: vp, position: camPos },
            lights,
            objects: baseObjects,
          })
          .unwrap();
        expect(w1.receipt.executedPasses).toBe(3);
        expect(w1.image.width).toBe(320);
        expect(w1.image.height).toBe(180);

        // Verify scene produced rich non-uniform shaded geometry + glass tint
        let nonZeroPixels = 0;
        let maxBlueDiff = 0;
        for (let y = 20; y < 160; y++) {
          for (let x = 20; x < 300; x++) {
            const [r, g, b] = samplePixel(w1.image.pixels, 320, x, y);
            if (r + g + b > 30) nonZeroPixels++;
            if (b - r > maxBlueDiff) maxBlueDiff = b - r;
          }
        }
        expect(nonZeroPixels).toBeGreaterThan(20000);
        expect(maxBlueDiff).toBeGreaterThan(15); // blue point light + blue transparent glass visible

        // Verify incremental partial change: add 200 cubes, then rotate only 10 per frame for 65 frames
        const dynamicObjects: DesktopRenderObjectInput[] = [...baseObjects];
        const cubeWorldMatrices: Float32Array[] = [];
        for (let i = 0; i < 200; i++) {
          const m = makeTrs(
            ((i % 15) - 7) * 1.1,
            0.5,
            (Math.floor(i / 15) - 6) * 1.1,
            0.5,
            0.5,
            0.5,
          );
          cubeWorldMatrices.push(m);
          dynamicObjects.push({
            entityId: 100 + i,
            meshKey: 'cube',
            materialKey: 'caster',
            worldMatrix: m,
            castShadow: true,
          });
        }

        // First frame upserts 200 new objects
        renderer
          .submitFrameAsync({
            width: 320,
            height: 180,
            camera: { viewProj: vp, position: camPos },
            lights,
            objects: dynamicObjects,
          })
          .unwrap();
        const afterSpawn = renderer.getStats().unwrap();
        expect(afterSpawn.trackedObjects).toBe(203);
        expect(afterSpawn.lastUpsertCount).toBe(200);
        expect(afterSpawn.lastDirtyTransformCount).toBe(200);

        // Rotate only 10 cubes per frame + dynamically edit caster material color for 64 frames
        for (let f = 0; f < 64; f++) {
          const start = (f * 10) % 200;
          for (let k = 0; k < 10; k++) {
            const idx = (start + k) % 200;
            const nextM = makeTrs(
              ((idx % 15) - 7) * 1.1,
              0.5 + Math.sin(f * 0.1 + k) * 0.25,
              (Math.floor(idx / 15) - 6) * 1.1,
              0.5,
              0.5,
              0.5,
              f * 0.08,
            );
            cubeWorldMatrices[idx]?.set(nextM);
          }
          renderer
            .ensureMaterial({
              key: 'caster',
              baseColor: [0.85 + 0.1 * Math.sin(f * 0.1), 0.35, 0.25, 1],
              roughness: 0.35,
              metallic: 0.15,
            })
            .unwrap();
          renderer
            .submitFrameAsync({
              width: 320,
              height: 180,
              camera: { viewProj: vp, position: camPos },
              lights,
              objects: dynamicObjects,
            })
            .unwrap();
        }

        // Despawn 50 objects on final frame
        dynamicObjects.length = 153;
        renderer
          .submitFrameAsync({
            width: 320,
            height: 180,
            camera: { viewProj: vp, position: camPos },
            lights,
            objects: dynamicObjects,
          })
          .unwrap();
        renderer.flush().unwrap();

        const finalStats = renderer.getStats().unwrap();
        expect(finalStats.trackedObjects).toBe(153);
        expect(finalStats.lastRemoveCount).toBe(50);
        expect(finalStats.thread.completedFrames).toBe(67); // 1 witness + 1 spawn + 64 moving + 1 despawn
        expect(finalStats.thread.inFlightFrames).toBe(0);
        expect(finalStats.thread.materialUploads).toBeGreaterThanOrEqual(64);
        // Incremental dirty sync proof: 64 frames * 10 dirty rows + baseline + spawn << 67 * 203 (13,601)!
        expect(finalStats.thread.dirtyRowsUploaded).toBeLessThan(2000);
      } finally {
        renderer.dispose();
      }
    });

    it('renders TBN normal maps, AlphaTest mask discard, multi-submesh materials, and 3-cascade CSM shadows', () => {
      const renderer = createDesktopNativeSceneRenderer({
        headless: true,
        shadowMapSize: 512,
      }).unwrap();

      try {
        // Two-submesh quad: left submesh (-1..0) and right submesh (0..1) in one shared mesh buffer
        const pos = new Float32Array([
          -1.6, -1.0, 0, 0.0, -1.0, 0, 0.0, 1.0, 0, -1.6, 1.0, 0, 0.0, -1.0, 0, 1.6, -1.0, 0, 1.6,
          1.0, 0, 0.0, 1.0, 0,
        ]);
        const nrm = new Float32Array([
          0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
        ]);
        const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
        const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
        const packed = packDesktopMeshVertices(pos, nrm, uv);
        renderer
          .ensureMesh({
            key: 'dual-quad',
            vertices: packed.vertices,
            indices: idx,
            submeshes: [
              { firstIndex: 0, indexCount: 6 },
              { firstIndex: 6, indexCount: 6 },
            ],
          })
          .unwrap();

        // Tilted tangent-space normal map (+X tilt so grazing +X light brightens it vs flat normal)
        const tiltedNormal = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) {
          tiltedNormal[i * 4 + 0] = 245; // +X tangent tilt
          tiltedNormal[i * 4 + 1] = 128;
          tiltedNormal[i * 4 + 2] = 160;
          tiltedNormal[i * 4 + 3] = 255;
        }
        renderer
          .ensureTexture({ key: 'tilt-nrm', width: 4, height: 4, rgbaBytes: tiltedNormal })
          .unwrap();

        // Alpha-mask texture: top half opaque (255), bottom half transparent (0)
        const maskBytes = new Uint8Array(8 * 8 * 4);
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const o = (y * 8 + x) * 4;
            maskBytes[o + 0] = 40;
            maskBytes[o + 1] = 230;
            maskBytes[o + 2] = 60;
            maskBytes[o + 3] = y < 4 ? 255 : 0;
          }
        }
        renderer
          .ensureTexture({ key: 'mask-tex', width: 8, height: 8, rgbaBytes: maskBytes })
          .unwrap();

        renderer
          .ensureMaterial({
            key: 'mat-flat',
            baseColor: [0.9, 0.25, 0.25, 1],
            roughness: 0.7,
            metallic: 0.0,
          })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'mat-normal-mapped',
            baseColor: [0.9, 0.25, 0.25, 1],
            roughness: 0.7,
            metallic: 0.0,
            normalTextureKey: 'tilt-nrm',
            normalScale: 1.0,
          })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'mat-masked',
            baseColor: [1, 1, 1, 1],
            roughness: 0.5,
            metallic: 0.0,
            alphaMode: 'mask',
            alphaCutoff: 0.5,
            baseColorTextureKey: 'mask-tex',
          })
          .unwrap();

        const camPos: readonly [number, number, number] = [0, 0, 4.5];
        const vp = desktopMat4Multiply(
          desktopMat4Perspective(Math.PI / 4, 16 / 9, 0.1, 100, new Float32Array(16)),
          desktopMat4LookAt(camPos, [0, 0, 0], [0, 1, 0], new Float32Array(16)),
          new Float32Array(16),
        );

        // Directional light coming strongly from +X with 3-cascade CSM enabled
        const lights = [
          {
            id: 10,
            kind: 'directional' as const,
            direction: [-0.95, 0.0, -0.3] as const,
            color: [1, 1, 1] as const,
            intensity: 3.5,
            castShadow: true,
            cascadeCount: 3,
            shadowDistance: 20,
          },
        ];

        const w = renderer
          .renderWitnessFrame({
            width: 320,
            height: 180,
            camera: { viewProj: vp, position: camPos, clearColor: [0.02, 0.02, 0.04, 1] },
            lights,
            skylight: {
              skyColor: [0.05, 0.05, 0.08],
              groundColor: [0.02, 0.02, 0.03],
              intensity: 1.0,
            },
            objects: [
              // Submesh 0 (left) with flat normal, submesh 1 (right) with tilted normal map
              {
                entityId: 10,
                meshKey: 'dual-quad',
                submeshIndex: 0,
                materialKey: 'mat-flat',
                worldMatrix: makeTrs(0, 0, 0, 1, 1, 1),
              },
              {
                entityId: 11,
                meshKey: 'dual-quad',
                submeshIndex: 1,
                materialKey: 'mat-normal-mapped',
                worldMatrix: makeTrs(0, 0, 0, 1, 1, 1),
              },
              // Alpha-masked quad in front of left side: bottom half (uv.y > 0.5 -> top of screen) discarded!
              {
                entityId: 12,
                meshKey: 'dual-quad',
                submeshIndex: 0,
                materialKey: 'mat-masked',
                worldMatrix: makeTrs(-0.2, 0, 0.6, 0.5, 0.8, 1),
              },
            ],
          })
          .unwrap();

        expect(w.receipt.executedPasses).toBe(3);
        const flatPx = samplePixel(w.image.pixels, 320, 110, 90);
        const nrmPx = samplePixel(w.image.pixels, 320, 210, 90);
        // Normal-mapped right submesh tilts toward the +X light, producing significantly higher red intensity
        expect(nrmPx[0]).toBeGreaterThan(flatPx[0] + 15);

        // Alpha-masked quad: opaque half shows bright green; discarded half reveals red quad behind it
        const maskOpaquePx = samplePixel(w.image.pixels, 320, 128, 115);
        const maskDiscardedPx = samplePixel(w.image.pixels, 320, 128, 65);
        expect(maskOpaquePx[1]).toBeGreaterThan(maskOpaquePx[0] + 30); // green opaque half
        expect(maskDiscardedPx[0]).toBeGreaterThan(maskDiscardedPx[1] + 20); // red quad behind discarded half
      } finally {
        renderer.dispose();
      }
    });

    it('composites alpha-blended RGBA UI overlays over 3D scene with in-place dynamic updates', () => {
      const renderer = createDesktopNativeSceneRenderer({ headless: true }).unwrap();
      try {
        const cube = makeUnitCube();
        renderer
          .ensureMesh({ key: 'cube', vertices: cube.vertices, indices: cube.indices })
          .unwrap();
        renderer
          .ensureMaterial({ key: 'red', baseColor: [0.95, 0.12, 0.12, 1], roughness: 0.9 })
          .unwrap();

        // Top quarter solid blue UI bar (alpha 255), rest transparent (alpha 0)
        const w = 160;
        const h = 120;
        const uiBytes = new Uint8Array(w * h * 4);
        for (let y = 0; y < 30; y++) {
          for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            uiBytes[o + 0] = 20;
            uiBytes[o + 1] = 80;
            uiBytes[o + 2] = 240;
            uiBytes[o + 3] = 255;
          }
        }
        expect(renderer.setUiOverlayRgba(w, h, uiBytes, 1).unwrap()).toBe(false);

        const camPos: readonly [number, number, number] = [0, 0, 2.2];
        const vp = desktopMat4Multiply(
          desktopMat4Perspective(Math.PI / 3, w / h, 0.1, 50, new Float32Array(16)),
          desktopMat4LookAt(camPos, [0, 0, 0], [0, 1, 0], new Float32Array(16)),
          new Float32Array(16),
        );
        const frame = {
          width: w,
          height: h,
          camera: { viewProj: vp, position: camPos },
          lights: [
            {
              id: 1,
              kind: 'directional' as const,
              direction: [0, 0, -1] as const,
              color: [1, 1, 1] as const,
              intensity: 2.5,
            },
          ],
          objects: [
            {
              entityId: 1,
              meshKey: 'cube',
              materialKey: 'red',
              worldMatrix: makeTrs(0, 0, 0, 2.5, 2.5, 1),
            },
          ],
        };

        const r1 = renderer.renderWitnessFrame(frame).unwrap();
        // Top bar must be blue UI overlay; center must show underlying red 3D cube!
        const topPx = samplePixel(r1.image.pixels, w, 80, 12);
        const midPx = samplePixel(r1.image.pixels, w, 80, 65);
        expect(topPx[2]).toBeGreaterThan(200);
        expect(topPx[0]).toBeLessThan(50);
        expect(midPx[0]).toBeGreaterThan(150);
        expect(midPx[0]).toBeGreaterThan(midPx[2] + 80);

        // Same-size in-place update: switch UI bar to bright green (reallocated === false!)
        for (let y = 0; y < 30; y++) {
          for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            uiBytes[o + 0] = 20;
            uiBytes[o + 1] = 235;
            uiBytes[o + 2] = 40;
            uiBytes[o + 3] = 255;
          }
        }
        expect(renderer.setUiOverlayRgba(w, h, uiBytes, 2).unwrap()).toBe(false);
        const r2 = renderer.renderWitnessFrame(frame).unwrap();
        const topPx2 = samplePixel(r2.image.pixels, w, 80, 12);
        expect(topPx2[1]).toBeGreaterThan(200);
        expect(topPx2[2]).toBeLessThan(70);

        // Clear UI overlay -> top bar reverts to underlying red 3D scene
        renderer.clearUiOverlay();
        const r3 = renderer.renderWitnessFrame(frame).unwrap();
        const topPx3 = samplePixel(r3.image.pixels, w, 80, 12);
        expect(topPx3[0]).toBeGreaterThan(topPx3[1] + 50);
      } finally {
        renderer.dispose();
      }
    });

    it('deforms skinned meshes via GPU joint palettes in @group(2) @binding(4) and updates live pose', () => {
      const renderer = createDesktopNativeSceneRenderer({ headless: true }).unwrap();
      try {
        // Skinned quad: vertices bound 100% to joint 0, centered at origin
        const pos = new Float32Array([-0.6, -0.6, 0, 0.6, -0.6, 0, 0.6, 0.6, 0, -0.6, 0.6, 0]);
        const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
        const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
        const joints = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
        const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
        const packed = packDesktopSkinnedMeshVertices(pos, nrm, uv, undefined, joints, weights);

        renderer
          .ensureMesh({
            key: 'skinned-quad',
            vertices: packed.vertices,
            indices: idx,
            skinned: true,
          })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'skin-mat',
            baseColor: [0.15, 0.9, 0.25, 1],
            roughness: 0.85,
            doubleSided: true,
          })
          .unwrap();

        // Pose 1: joint 0 shifted LEFT to x = -1.2
        const leftPalette = new Float32Array(16);
        leftPalette.set(makeTrs(-1.2, 0, 0, 1, 1, 1));
        renderer.setSkinJoints('hero-skin', leftPalette, 1);

        const w = 200;
        const h = 120;
        const camPos: readonly [number, number, number] = [0, 0, 4.0];
        const vp = desktopMat4Multiply(
          desktopMat4Perspective(Math.PI / 3, w / h, 0.1, 50, new Float32Array(16)),
          desktopMat4LookAt(camPos, [0, 0, 0], [0, 1, 0], new Float32Array(16)),
          new Float32Array(16),
        );
        const frame = {
          width: w,
          height: h,
          camera: { viewProj: vp, position: camPos, clearColor: [0.02, 0.02, 0.04, 1] as const },
          lights: [
            {
              id: 1,
              kind: 'directional' as const,
              direction: [0, 0, -1] as const,
              color: [1, 1, 1] as const,
              intensity: 2.8,
              castShadow: true,
            },
          ],
          objects: [
            {
              entityId: 77,
              meshKey: 'skinned-quad',
              materialKey: 'skin-mat',
              skinKey: 'hero-skin',
              worldMatrix: makeTrs(0, 0, 0, 1, 1, 1),
              frustumCulled: false,
            },
          ],
        };

        const rLeft = renderer.renderWitnessFrame(frame).unwrap();
        const leftSide1 = samplePixel(rLeft.image.pixels, w, 69, 60);
        const rightSide1 = samplePixel(rLeft.image.pixels, w, 131, 60);
        expect(leftSide1[1]).toBeGreaterThan(140); // bright green on left
        expect(rightSide1[1]).toBeLessThan(40); // dark background on right

        // Pose 2: animate joint 0 to RIGHT at x = +1.2 without moving object worldMatrix!
        const rightPalette = new Float32Array(16);
        rightPalette.set(makeTrs(1.2, 0, 0, 1, 1, 1));
        renderer.setSkinJoints('hero-skin', rightPalette, 1);

        const rRight = renderer.renderWitnessFrame(frame).unwrap();
        const leftSide2 = samplePixel(rRight.image.pixels, w, 69, 60);
        const rightSide2 = samplePixel(rRight.image.pixels, w, 131, 60);
        expect(leftSide2[1]).toBeLessThan(40); // dark background on left
        expect(rightSide2[1]).toBeGreaterThan(140); // bright green moved to right!
      } finally {
        renderer.dispose();
      }
    });

    it('registers custom 4-BGL WGSL shaders and hot-reloads live material PSOs without restart', () => {
      const renderer = createDesktopNativeSceneRenderer({ headless: true }).unwrap();
      try {
        const makeCustomWgsl = (r: number, g: number, b: number) => /* wgsl */ `
struct ViewUniform {
  view_proj: mat4x4<f32>,
  cascade_vp: array<mat4x4<f32>, 4>,
  cascade_splits: vec4<f32>,
  cascade_atlas_rect: array<vec4<f32>, 4>,
  camera_pos_exposure: vec4<f32>,
  sky_color_intensity: vec4<f32>,
  ground_color_bias: vec4<f32>,
  light_meta: vec4<u32>,
  shadow_atlas_meta: vec4<f32>,
  fog_params0: vec4<f32>,
  fog_params1: vec4<f32>,
  fog_params2: vec4<f32>,
};
struct SceneObject {
  world: mat4x4<f32>,
  params0: vec4<f32>,
  params1: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(2) @binding(0) var<storage, read> s_objects: array<SceneObject>;
@group(3) @binding(0) var<storage, read> s_instance_rows: array<u32>;
@vertex
fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) _n: vec3<f32>,
  @location(2) _uv: vec2<f32>,
  @location(3) _t: vec4<f32>,
  @builtin(instance_index) inst: u32,
) -> @builtin(position) vec4<f32> {
  let obj = s_objects[s_instance_rows[inst]];
  return u_view.view_proj * (obj.world * vec4<f32>(pos, 1.0));
}
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(${r.toFixed(2)}, ${g.toFixed(2)}, ${b.toFixed(2)}, 1.0);
}
`;
        const cube = makeUnitCube();
        renderer
          .ensureMesh({ key: 'cube', vertices: cube.vertices, indices: cube.indices })
          .unwrap();
        renderer
          .registerCustomShader('neon-custom', makeCustomWgsl(2.5, 0.0, 2.5), {
            label: 'neon-magenta',
          })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'custom-mat',
            baseColor: [1, 1, 1, 1],
            customShaderKey: 'neon-custom',
          })
          .unwrap();

        const w = 160;
        const h = 120;
        const camPos: readonly [number, number, number] = [0, 0, 2.4];
        const vp = desktopMat4Multiply(
          desktopMat4Perspective(Math.PI / 3, w / h, 0.1, 50, new Float32Array(16)),
          desktopMat4LookAt(camPos, [0, 0, 0], [0, 1, 0], new Float32Array(16)),
          new Float32Array(16),
        );
        const frame = {
          width: w,
          height: h,
          camera: { viewProj: vp, position: camPos },
          lights: [],
          objects: [
            {
              entityId: 90,
              meshKey: 'cube',
              materialKey: 'custom-mat',
              worldMatrix: makeTrs(0, 0, 0, 2.2, 2.2, 1),
            },
          ],
        };

        // Render 1: custom shader outputs vivid magenta (high R & B, near-zero G)
        const r1 = renderer.renderWitnessFrame(frame).unwrap();
        const px1 = samplePixel(r1.image.pixels, w, 80, 60);
        expect(px1[0]).toBeGreaterThan(180);
        expect(px1[1]).toBeLessThan(35);
        expect(px1[2]).toBeGreaterThan(180);

        // Live hot-reload same shader key to vivid cyan (near-zero R, high G & B)
        renderer
          .reloadCustomShader('neon-custom', makeCustomWgsl(0.0, 2.5, 2.5), {
            label: 'neon-cyan',
          })
          .unwrap();

        // Render 2: same material & entity immediately picks up reloaded cyan shader!
        const r2 = renderer.renderWitnessFrame(frame).unwrap();
        const px2 = samplePixel(r2.image.pixels, w, 80, 60);
        expect(px2[0]).toBeLessThan(35);
        expect(px2[1]).toBeGreaterThan(180);
        expect(px2[2]).toBeGreaterThan(180);
      } finally {
        renderer.dispose();
      }
    });

    it('renders analytic Fog, Skybox gradient, HDR Bloom halo, FXAA, and 3D DebugDraw lines', () => {
      const renderer = createDesktopNativeSceneRenderer({ headless: true }).unwrap();
      try {
        const cube = makeUnitCube();
        renderer
          .ensureMesh({ key: 'cube', vertices: cube.vertices, indices: cube.indices })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'emissive-core',
            baseColor: [0.1, 0.1, 0.1, 1],
            emissive: [6.0, 2.5, 0.2],
            roughness: 0.9,
          })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'distant-wall',
            baseColor: [0.05, 0.05, 0.05, 1],
            roughness: 0.9,
          })
          .unwrap();

        const w = 160;
        const h = 120;
        const camPos: readonly [number, number, number] = [0, 0, 5.0];
        const vp = desktopMat4Multiply(
          desktopMat4Perspective(Math.PI / 3, w / h, 0.1, 100, new Float32Array(16)),
          desktopMat4LookAt(camPos, [0, 0, 0], [0, 1, 0], new Float32Array(16)),
          new Float32Array(16),
        );

        // 1. Skybox + Analytic Fog + DebugDraw green horizontal line across center
        renderer
          .setDebugLines(
            new Float32Array([
              -3.0, 0.0, 1.0, 0.0, 3.0, 0.1, 1.0, 3.0, 0.0, 1.0, 0.0, 3.0, 0.1, 1.0,
            ]),
          )
          .unwrap();
        const rSkyFog = renderer
          .renderWitnessFrame({
            width: w,
            height: h,
            camera: { viewProj: vp, position: camPos },
            lights: [],
            skybox: {
              zenithColor: [0.05, 0.2, 0.95],
              horizonColor: [0.7, 0.85, 1.0],
              groundColor: [0.55, 0.14, 0.04],
              intensity: 1.0,
            },
            fog: {
              mode: 'linear',
              color: [0.8, 0.1, 0.1],
              near: 2.0,
              far: 8.0,
              maxOpacity: 1.0,
            },
            objects: [
              // Distant dark cube at z = -10 (distance 15 > far=8) -> fully fogged to bright red!
              {
                entityId: 201,
                meshKey: 'cube',
                materialKey: 'distant-wall',
                worldMatrix: makeTrs(-2.8, 0, -5.0, 2.5, 2.5, 1),
              },
            ],
          })
          .unwrap();

        // Top of screen shows blue skybox zenith; bottom shows brownish ground skybox
        const skyTop = samplePixel(rSkyFog.image.pixels, w, 130, 8);
        const skyBot = samplePixel(rSkyFog.image.pixels, w, 130, 112);
        expect(skyTop[2]).toBeGreaterThan(skyTop[0] + 40);
        expect(skyBot[0]).toBeGreaterThan(skyBot[2]);
        // Distant dark cube at left is strongly tinted by red linear fog
        const foggedCube = samplePixel(rSkyFog.image.pixels, w, 51, 54);
        expect(foggedCube[0]).toBeGreaterThan(foggedCube[2] + 60);
        // Bright green debug line across center row y=60
        const dbgLine = samplePixel(rSkyFog.image.pixels, w, 80, 60);
        expect(dbgLine[1]).toBeGreaterThan(150);

        // 2. HDR Bloom halo + FXAA around small emissive cube on dark background
        renderer.clearDebugLines();
        const baseBloomFrame = {
          width: w,
          height: h,
          camera: {
            viewProj: vp,
            position: camPos,
            clearColor: [0, 0, 0, 1] as const,
          },
          lights: [],
          objects: [
            {
              entityId: 202,
              meshKey: 'cube',
              materialKey: 'emissive-core',
              worldMatrix: makeTrs(0, 0, 0, 0.5, 0.5, 0.5),
            },
          ],
        };
        const rNoBloom = renderer.renderWitnessFrame(baseBloomFrame).unwrap();
        const rBloomFxaa = renderer
          .renderWitnessFrame({
            ...baseBloomFrame,
            camera: {
              ...baseBloomFrame.camera,
              bloom: { enabled: true, threshold: 0.8, intensity: 1.5 },
              fxaa: true,
            },
          })
          .unwrap();

        // Pixel just outside the emissive cube: dark without bloom, glowing orange with bloom+FXAA!
        const haloOff = samplePixel(rNoBloom.image.pixels, w, 90, 60);
        const haloOn = samplePixel(rBloomFxaa.image.pixels, w, 90, 60);
        expect(haloOff[0]).toBeLessThan(15);
        expect(haloOn[0]).toBeGreaterThan(haloOff[0] + 25);
        expect(rBloomFxaa.receipt.executedPasses).toBeGreaterThanOrEqual(6);
      } finally {
        renderer.dispose();
      }
    });

    it('recovers from GPU device loss with pixel parity and maintains bounded GPU memory over a 180-frame soak', () => {
      const renderer = createDesktopNativeSceneRenderer({
        headless: true,
        shadowMapSize: 256,
      }).unwrap();
      try {
        const cube = makeUnitCube();
        renderer
          .ensureMesh({ key: 'cube', vertices: cube.vertices, indices: cube.indices })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'hero',
            baseColor: [0.9, 0.35, 0.2, 1],
            roughness: 0.45,
            metallic: 0.1,
          })
          .unwrap();

        const w = 160;
        const h = 120;
        const camPos: readonly [number, number, number] = [0, 1.5, 4.0];
        const vp = desktopMat4Multiply(
          desktopMat4Perspective(Math.PI / 4, w / h, 0.1, 100, new Float32Array(16)),
          desktopMat4LookAt(camPos, [0, 0, 0], [0, 1, 0], new Float32Array(16)),
          new Float32Array(16),
        );
        const objects: DesktopRenderObjectInput[] = [];
        const mats: Float32Array[] = [];
        for (let i = 0; i < 40; i++) {
          const m = makeTrs(((i % 8) - 3.5) * 0.6, 0, (Math.floor(i / 8) - 2) * 0.6, 0.4, 0.4, 0.4);
          mats.push(m);
          objects.push({
            entityId: 500 + i,
            meshKey: 'cube',
            materialKey: 'hero',
            worldMatrix: m,
          });
        }
        const frame = {
          width: w,
          height: h,
          camera: { viewProj: vp, position: camPos },
          lights: [
            {
              id: 1,
              kind: 'directional' as const,
              direction: [-0.4, -0.8, -0.5] as const,
              color: [1, 0.96, 0.9] as const,
              intensity: 2.4,
              castShadow: true,
            },
          ],
          objects,
        };

        // 1. Capture witness before device-lost recovery
        const before = renderer.renderWitnessFrame(frame).unwrap();
        const statsBefore = renderer.getStats().unwrap();
        expect(statsBefore.thread.deviceGeneration).toBe(1);
        expect(statsBefore.thread.recoveryCount).toBe(0);
        expect(statsBefore.thread.gpuMemoryBytes).toBeGreaterThan(0);
        expect(statsBefore.thread.poolMemoryBytes).toBeGreaterThan(0);

        // 2. Trim transient RT pool textures and verify freed bytes > 0
        const freed = renderer.trimPoolTextures().unwrap();
        expect(freed).toBeGreaterThan(0);
        expect(renderer.getStats().unwrap().thread.poolMemoryBytes).toBe(0);

        // 3. Full GPU device-loss recovery -> verify generation bump & pixel-identical output!
        const newGen = renderer.recover().unwrap();
        expect(newGen).toBe(2);
        const after = renderer.renderWitnessFrame(frame).unwrap();
        const statsAfter = renderer.getStats().unwrap();
        expect(statsAfter.thread.deviceGeneration).toBe(2);
        expect(statsAfter.thread.recoveryCount).toBe(1);

        let maxChannelDiff = 0;
        for (let i = 0; i < before.image.pixels.length; i++) {
          const diff = Math.abs((before.image.pixels[i] ?? 0) - (after.image.pixels[i] ?? 0));
          if (diff > maxChannelDiff) maxChannelDiff = diff;
        }
        expect(maxChannelDiff).toBeLessThanOrEqual(2);

        // 4. 180-frame continuous-partial-change soak gate: GPU & pool memory must remain flat!
        const memBaseline = renderer.getStats().unwrap().thread.gpuMemoryBytes;
        const poolBaseline = renderer.getStats().unwrap().thread.poolMemoryBytes;
        for (let f = 0; f < 180; f++) {
          for (let k = 0; k < 4; k++) {
            const idx = (f * 4 + k) % 40;
            mats[idx]?.set(
              makeTrs(
                ((idx % 8) - 3.5) * 0.6,
                Math.sin(f * 0.1 + k) * 0.2,
                (Math.floor(idx / 8) - 2) * 0.6,
                0.4,
                0.4,
                0.4,
                f * 0.05,
              ),
            );
          }
          renderer.submitFrameAsync(frame).unwrap();
        }
        renderer.flush().unwrap();
        const memEnd = renderer.getStats().unwrap().thread.gpuMemoryBytes;
        const poolEnd = renderer.getStats().unwrap().thread.poolMemoryBytes;
        expect(memEnd).toBeLessThanOrEqual(memBaseline + 65536);
        expect(poolEnd).toBeLessThanOrEqual(poolBaseline + 65536);
      } finally {
        renderer.dispose();
      }
    });
  },
);
